import * as vscode from "vscode";
import { MarkdownEditorProvider } from "./MarkdownEditorProvider";
import { resolveFontFamily, clampFontSizePercent } from "../shared/fontPresets";
import { normalizeBlockHandlesMode, BLOCK_HANDLES_DISPLAY_ORDER, type BlockHandlesMode } from "../shared/blockHandles";
import { normalizeMermaidThemeMode } from "../shared/mermaid";
import { normalizeTocVisibility } from "../shared/tocVisibility";
import { scanHeadings } from "./utils/headingScan";
import { EDITOR_COMMANDS, editorCommandName } from "../shared/editorCommands";
import { WordCountStatusBar } from "./wordCountStatus";
import { reportErrorWithNotification } from "./errorSink";
import {
    getBirtaConfiguration,
    readBirtaSetting,
    getProofreadConfig,
    getToolbarConfig,
    getFontStacks,
    resolveContentWidthConfig,
    toggleProofreading,
    updateSettingRespectingScope,
} from "./config";

/**
 * "Block Handles" in the command palette: a QuickPick of the three resting
 * modes with the current one annotated AND preselected — createQuickPick, not
 * showQuickPick, because only it can set activeItems, and without that Enter
 * straight after opening would silently switch a `headings` user to the first
 * row (the gotoSymbol picker's idiom). Picking persists the `blockHandles`
 * setting (respecting the winning scope); the config-change listener in
 * activate() then broadcasts it to every open editor. Exported for unit
 * testing.
 */
export async function promptBlockHandlesMode(): Promise<void> {
    const current = normalizeBlockHandlesMode(readBirtaSetting("blockHandles"));
    type ModeItem = vscode.QuickPickItem & { mode: BlockHandlesMode };
    // Most → least visible, the shared display order of the typography menu's
    // radio rows.
    const rows: Record<BlockHandlesMode, { label: string; description: string }> = {
        always: { label: "Always show", description: vscode.l10n.t("Every block's handle stays visible") },
        headings: { label: "Headings and hover", description: vscode.l10n.t("Heading badges stay visible; other handles appear on hover (default)") },
        hover: { label: "Hover only", description: vscode.l10n.t("Handles appear only on hover") },
    };
    const base: ModeItem[] = BLOCK_HANDLES_DISPLAY_ORDER.map((mode) => ({ mode, ...rows[mode] }));
    const items = base.map((item) => ({
        ...item,
        // The palette idiom for "where you are now" (VS Code's own theme /
        // language pickers): annotate the current row rather than hide it.
        ...(item.mode === current && { description: `${item.description} — ${vscode.l10n.t("current")}` }),
    }));
    const quickPick = vscode.window.createQuickPick<ModeItem>();
    quickPick.title = vscode.l10n.t("Block Handles");
    quickPick.placeholder = vscode.l10n.t("Handles shown at rest (hovering a block always reveals its handle)");
    quickPick.items = items;
    quickPick.activeItems = items.filter((item) => item.mode === current);
    const picked = await new Promise<ModeItem | undefined>((resolve) => {
        quickPick.onDidAccept(() => {
            resolve(quickPick.selectedItems[0]);
            quickPick.hide();
        });
        // Fires on Escape AND after an accept's hide(); the promise is
        // already settled in the latter case, so this resolve is a no-op.
        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });
        quickPick.show();
    });
    if (picked && picked.mode !== current) {
        updateSettingRespectingScope("blockHandles", picked.mode);
    }
}

/**
 * Sync workbench.editorAssociations based on defaultMode:
 * - "markdown" → inject "*.md"/"*.markdown": "default" so the text editor opens directly without triggering the custom editor
 * - "preview"  → remove the above entries, restoring the priority:default in package.json
 */
function syncEditorAssociation(mode: string): void {
    const wbConfig = vscode.workspace.getConfiguration("workbench");
    const current: Record<string, string> = {
        ...(wbConfig.get<Record<string, string>>("editorAssociations") ?? {}),
    };
    if (mode === "markdown") {
        current["*.md"] = "default";
        current["*.markdown"] = "default";
    } else {
        // preview mode: remove the association, relying on package.json's priority:default to take effect automatically
        delete current["*.md"];
        delete current["*.markdown"];
    }
    wbConfig.update("editorAssociations", current, vscode.ConfigurationTarget.Global);
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        MarkdownEditorProvider.register(context),
    );

    // Status bar word/character/reading-time readout (MAR-29): created once here
    // and driven by the provider from the active editor's `wordCount` messages.
    const wordCountStatusBar = new WordCountStatusBar();
    context.subscriptions.push(wordCountStatusBar);
    MarkdownEditorProvider.current?.setWordCountView(wordCountStatusBar);

    // Sync editorAssociations once on activation
    const initialMode = readBirtaSetting("defaultMode");
    syncEditorAssociation(initialMode);

    // Under priority:option, file opening is not taken over automatically; use onDidChangeTabs to watch text tabs and switch to WYSIWYG
    // Diff views only produce TabInputTextDiff and won't trigger this logic
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(async (event) => {
            const mode = readBirtaSetting("defaultMode");
            if (mode !== "preview") { return; }

            for (const tab of event.opened) {
                if (!(tab.input instanceof vscode.TabInputText)) { continue; }
                const uri = (tab.input as vscode.TabInputText).uri;
                if (uri.scheme !== "file") { continue; }
                if (!/\.(md|markdown)$/i.test(uri.fsPath)) { continue; }

                const uriStr = uri.toString();
                if (MarkdownEditorProvider.suppressAutoSwitch.has(uriStr)) { continue; }

                // If the URI fragment contains a line number (global search passes #L10 format), store it in advance so WYSIWYG can jump after initialization
                const fragMatch = uri.fragment?.match(/^L?(\d+)/);
                if (fragMatch) {
                    const fragLine = parseInt(fragMatch[1], 10);
                    if (fragLine >= 1) {
                        console.log('[onDidChangeTabs] fragment line:', fragLine, 'fsPath:', uri.fsPath);
                        MarkdownEditorProvider.current?.setPendingNavigation(uri.fsPath, fragLine);
                    }
                }

                // Close the text tab first, then open WYSIWYG (consistent with the switchToPreview command)
                const isPreview = tab.isPreview;
                const viewCol = tab.group.viewColumn;
                await vscode.window.tabGroups.close(tab);
                await vscode.commands.executeCommand(
                    "vscode.openWith",
                    uri,
                    MarkdownEditorProvider.viewType,
                    { viewColumn: viewCol, preview: isPreview },
                );
            }
        }),
    );

    // Listen for text editor activation events: capture the cursor position of the .md text editor that briefly appears during global search navigation
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor) { return; }
            const { uri } = editor.document;
            if (!uri.fsPath.endsWith('.md')) { return; }
            // While switching to the text editor (suppressNavFromTextEditor is set), skip reporting the line number
            // to avoid the line number being fed back to the WebView and triggering an unnecessary scrollToLine when actively switching away
            if (MarkdownEditorProvider.current?.isNavFromTextEditorSuppressed) { return; }
            const line = editor.selection.active.line + 1; // convert to 1-indexed
            if (line >= 1) {
                MarkdownEditorProvider.current?.setPendingNavigation(uri.fsPath, line);
            }
        }),
    );

    // Intercept the revealLine command: VS Code calls this command to navigate to a specific line when a global search result is clicked.
    // If there is currently a .md custom editor tab (iterate over all groups), forward it to the WebView; otherwise fall back to the text editor behavior.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'revealLine',
            (args: { lineNumber: number; at?: string }) => {
                console.log('[revealLine] triggered, lineNumber:', args.lineNumber, 'at:', args.at);
                const targetLine = args.lineNumber + 1; // convert to 1-indexed
                // Always write to the global fallback: ensure onDidChangeViewState (including the delayed check) can consume it
                MarkdownEditorProvider.current?.setGlobalRevealLine(targetLine);
                // Set pending navigation for all registered .md panels
                // to avoid relying solely on tab.isActive (the order of tab switching and revealLine triggering is uncertain)
                const mdPaths = MarkdownEditorProvider.current?.getAllMdFsPaths() ?? [];
                if (mdPaths.length > 0) {
                    console.log('[revealLine] number of registered .md panels:', mdPaths.length, 'line:', targetLine);
                    for (const fsPath of mdPaths) {
                        MarkdownEditorProvider.current?.setPendingNavigation(fsPath, targetLine);
                    }
                    return;
                }
                // Fallback: iterate over tab groups to find the active .md custom tab
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        if (tab.input instanceof vscode.TabInputCustom) {
                            const uri = (tab.input as vscode.TabInputCustom).uri;
                            if (uri.fsPath.endsWith('.md') && tab.isActive) {
                                console.log('[revealLine] found active .md custom tab, fsPath:', uri.fsPath);
                                MarkdownEditorProvider.current?.setPendingNavigation(uri.fsPath, targetLine);
                                return;
                            }
                        }
                    }
                }
                console.log('[revealLine] no .md panel found, waiting for delayed viewState consumption');
                // Fallback: text editor uses revealRange
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const pos = new vscode.Position(args.lineNumber, 0);
                    const revealType =
                        args.at === 'top' ? vscode.TextEditorRevealType.AtTop
                        : args.at === 'center' ? vscode.TextEditorRevealType.InCenter
                        : vscode.TextEditorRevealType.Default;
                    editor.revealRange(new vscode.Range(pos, pos), revealType);
                }
            },
        ),
    );

    // Debug mode: initialize the context variable
    const initialDebug = readBirtaSetting("debugMode");
    vscode.commands.executeCommand(
        "setContext",
        "birta.debugModeActive",
        initialDebug,
    );

    // Debug mode toggle command (two mutually exclusive commands, whose display is switched via when conditions to achieve the ✓ prefix effect)
    const toggleDebugMode = () => {
        const next = !readBirtaSetting("debugMode");
        getBirtaConfiguration().update("debugMode", next, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand(
            "setContext",
            "birta.debugModeActive",
            next,
        );
        MarkdownEditorProvider.current?.postToAll({
            type: "setDebugMode",
            enabled: next,
        });
    };
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "birta.debugModeEnable",
            toggleDebugMode,
        ),
        vscode.commands.registerCommand(
            "birta.debugModeDisable",
            toggleDebugMode,
        ),
    );

    // Master network switch from the palette (MAR-184): the same setting the
    // just-in-time pill writes, discoverable without hunting Settings. The
    // config-change listener below broadcasts the flip to open webviews, which
    // re-gate paste-unfurl and rebuild embed decorations in place.
    context.subscriptions.push(
        vscode.commands.registerCommand("birta.toggleNetwork", () => {
            const next = !readBirtaSetting("networkEnabled");
            getBirtaConfiguration().update(
                "network.enabled",
                next,
                vscode.ConfigurationTarget.Global,
            );
            vscode.window.setStatusBarMessage(
                next
                    ? "Birta: network features on — pasted URLs can fetch titles, provider links show cards"
                    : "Birta: network features off — nothing leaves your machine",
                5000,
            );
        }),
    );

    // Palette toggles for the boolean feature gates. Each flips the persisted
    // setting (Global; the config-change listener broadcasts the fresh value
    // to every open webview) and states the new behavior in the status bar.
    const registerGateToggle = (
        command: string,
        settingKey: string,
        readKey: Parameters<typeof readBirtaSetting>[0],
        onMessage: string,
        offMessage: string,
    ): void => {
        context.subscriptions.push(
            vscode.commands.registerCommand(command, () => {
                const next = !readBirtaSetting(readKey);
                getBirtaConfiguration().update(
                    settingKey,
                    next,
                    vscode.ConfigurationTarget.Global,
                );
                vscode.window.setStatusBarMessage(next ? onMessage : offMessage, 5000);
            }),
        );
    };
    registerGateToggle(
        "birta.toggleCalcAutoInsert",
        "calc.autoInsert",
        "calcAutoInsert",
        "Birta: calc auto-insert on — typing = inserts the result immediately",
        "Birta: calc auto-insert off — results are offered as suggestions (Tab accepts)",
    );
    registerGateToggle(
        "birta.togglePasteUnfurl",
        "pasteUnfurl.enabled",
        "pasteUnfurlEnabled",
        "Birta: paste-unfurl on — pasted URLs offer their page title (needs network features on)",
        "Birta: paste-unfurl off — pasted URLs stay plain links",
    );
    registerGateToggle(
        "birta.togglePasteUnfurlAutoApply",
        "pasteUnfurl.autoApply",
        "pasteUnfurlAutoApply",
        "Birta: fetched titles apply automatically",
        "Birta: fetched titles are offered as suggestions — nothing is written until you accept",
    );
    registerGateToggle(
        "birta.toggleEmbeds",
        "embeds.enabled",
        "embedsEnabled",
        "Birta: URL embeds on — provider links show a card (display only; your file is unchanged)",
        "Birta: URL embeds off — provider links stay plain links",
    );
    registerGateToggle(
        "birta.toggleChecklistSink",
        "checklist.sinkChecked",
        "checklistSinkChecked",
        "Birta: checked tasks move to the bottom of their list",
        "Birta: checked tasks stay in place",
    );

    // TEST-ONLY hook: registered ONLY outside Production (i.e. the
    // @vscode/test-electron Development/Test host), so the shipped extension never
    // exposes it at all — zero production surface. Drives the active editor's real
    // Milkdown view ahead of the document so the save flush can be verified
    // end-to-end in a real host. Not contributed → invisible in the palette.
    if (context.extensionMode !== vscode.ExtensionMode.Production) {
        context.subscriptions.push(
            vscode.commands.registerCommand(
                "birta._test.insertText",
                (text: string) =>
                    MarkdownEditorProvider.current?.postToActivePanel({ type: "__testInsertText", text }),
            ),
        );
    }

    // Recover the pre-destruction text kept by the destructive-change
    // tripwire (MAR-114). The provider owns the slot and the swap semantics.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "birta.restorePreviousContent",
            () => MarkdownEditorProvider.current?.restorePreviousContent()
                // A user-invoked recovery must not fail silently (e.g. the
                // file was deleted and the document can no longer be opened).
                .catch((err) => reportErrorWithNotification(
                    "restorePreviousContent",
                    err,
                    vscode.l10n.t("Could not restore the previous content. See the developer console for details."),
                )),
        ),
    );

    // Toggle the master proofreading gate (keyboard shortcut / command palette);
    // the config-change listener below broadcasts the new state to every open
    // editor. This gates spelling + grammar + style at once without touching
    // their individual switches, so it restores exactly what was on before.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "birta.toggleProofreading",
            () => toggleProofreading(),
        ),
    );

    // Command-palette picker for the resting block-handles mode; the
    // config-change listener below broadcasts the result to every open editor.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "birta.selectBlockHandles",
            promptBlockHandlesMode,
        ),
    );

    // Coalesce a burst of proofread setting writes into a single broadcast: a
    // trailing-edge debounce fires once writes stop and reads the settled config,
    // so a rapid sequence of toggles (e.g. several rows in the Settings UI) can
    // never broadcast a half-applied state and flicker the Checks menu.
    let proofreadBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
    const broadcastProofreadConfig = (): void => {
        if (proofreadBroadcastTimer) { clearTimeout(proofreadBroadcastTimer); }
        proofreadBroadcastTimer = setTimeout(() => {
            proofreadBroadcastTimer = undefined;
            MarkdownEditorProvider.current?.postToAll({
                type: "proofreadConfig",
                config: getProofreadConfig(),
            });
        }, 80);
    };

    // Listen for manual setting changes (sync when modified from the VSCode settings UI)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("birta.defaultMode")) {
                syncEditorAssociation(readBirtaSetting("defaultMode"));
            }
            if (e.affectsConfiguration("birta.debugMode")) {
                const v = readBirtaSetting("debugMode");
                vscode.commands.executeCommand(
                    "setContext",
                    "birta.debugModeActive",
                    v,
                );
                MarkdownEditorProvider.current?.postToAll({
                    type: "setDebugMode",
                    enabled: v,
                });
            }
            if (e.affectsConfiguration("birta.tableWrap")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "setTableWrap",
                    wrap: readBirtaSetting("tableWrap"),
                });
            }
            // Read-at-use-time feature gates: broadcast the fresh value so
            // every open webview follows a settings edit, palette toggle, or
            // another webview's menu switch without a reload.
            if (e.affectsConfiguration("birta.calc.autoInsert")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "featureGateChanged",
                    gate: "calcAutoInsert",
                    enabled: readBirtaSetting("calcAutoInsert"),
                });
            }
            if (e.affectsConfiguration("birta.checklist.sinkChecked")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "featureGateChanged",
                    gate: "checklistSinkChecked",
                    enabled: readBirtaSetting("checklistSinkChecked"),
                });
            }
            if (e.affectsConfiguration("birta.pasteUnfurl.enabled")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "featureGateChanged",
                    gate: "pasteUnfurl",
                    enabled: readBirtaSetting("pasteUnfurlEnabled"),
                });
            }
            if (e.affectsConfiguration("birta.pasteUnfurl.autoApply")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "featureGateChanged",
                    gate: "pasteUnfurlAutoApply",
                    enabled: readBirtaSetting("pasteUnfurlAutoApply"),
                });
            }
            if (e.affectsConfiguration("birta.embeds.enabled")) {
                // Without this the embed feature key was the ONE gate with no
                // live path at all: toggling it did nothing until the file was
                // reopened. The webview re-runs the decoration pass on receipt.
                MarkdownEditorProvider.current?.postToAll({
                    type: "featureGateChanged",
                    gate: "embedsEnabled",
                    enabled: readBirtaSetting("embedsEnabled"),
                });
            }
            if (e.affectsConfiguration("birta.network.enabled")) {
                // Master network switch flipped — settings UI, or the
                // just-in-time opt-in accepted in one webview (its write-back
                // lands here too). Broadcast so every OPEN webview re-gates:
                // paste-unfurl reads the new value at its next use, and the
                // embed decorations are rebuilt in place. Without this the
                // setting persists but running editors stay on their
                // baked-at-load value until reopened.
                MarkdownEditorProvider.current?.postToAll({
                    type: "networkStateChanged",
                    enabled: readBirtaSetting("networkEnabled"),
                });
            }
            if (e.affectsConfiguration("birta.proofreading")
                || e.affectsConfiguration("birta.styleCheck")
                || e.affectsConfiguration("birta.spellCheck")
                || e.affectsConfiguration("birta.grammarCheck")) {
                broadcastProofreadConfig();
            }
            if (e.affectsConfiguration("birta.toolbar")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "toolbarConfig",
                    config: getToolbarConfig(),
                });
            }
            if (e.affectsConfiguration("birta.notes.customMarkers")) {
                // Notes review tab: rescan with the new marker set in every open
                // editor without a reload (mirrors the other read-at-use gates).
                MarkdownEditorProvider.current?.postToAll({
                    type: "notesConfig",
                    customMarkers: readBirtaSetting("notesCustomMarkers"),
                });
            }
            if (e.affectsConfiguration("birta.fontPreset")
                || e.affectsConfiguration("birta.fontFamilySans")
                || e.affectsConfiguration("birta.fontFamilySerif")
                || e.affectsConfiguration("birta.fontFamilyMono")) {
                const preset = readBirtaSetting("fontPreset");
                const stacks = getFontStacks();
                MarkdownEditorProvider.current?.postToAll({
                    type: "setFontFamily",
                    fontFamily: resolveFontFamily(preset, stacks),
                    preset,
                    stacks,
                });
            }
            if (e.affectsConfiguration("birta.fontSize")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "setFontSize",
                    size: clampFontSizePercent(readBirtaSetting("fontSize")),
                });
            }
            if (e.affectsConfiguration("birta.tocPosition")) {
                const position = readBirtaSetting("tocPosition") === "left" ? "left" : "right";
                MarkdownEditorProvider.current?.postToAll({ type: "setTocPosition", position });
            }
            if (e.affectsConfiguration("birta.tocVisibility")) {
                const visibility = normalizeTocVisibility(readBirtaSetting("tocVisibility"));
                MarkdownEditorProvider.current?.postToAll({ type: "setTocVisibility", visibility });
            }
            if (e.affectsConfiguration("birta.tocWidth")) {
                const width = readBirtaSetting("tocWidth");
                MarkdownEditorProvider.current?.postToAll({ type: "setTocWidth", width });
            }
            if (e.affectsConfiguration("birta.blockHandles")) {
                const mode = normalizeBlockHandlesMode(readBirtaSetting("blockHandles"));
                MarkdownEditorProvider.current?.postToAll({ type: "setBlockHandles", mode });
            }
            if (e.affectsConfiguration("birta.mermaid.theme")) {
                const mode = normalizeMermaidThemeMode(readBirtaSetting("mermaidTheme"));
                MarkdownEditorProvider.current?.postToAll({ type: "setMermaidTheme", mode });
            }
            if (e.affectsConfiguration("editor.showFoldingControls")
                || e.affectsConfiguration("editor.folding")) {
                // Resource-scoped native settings: the provider re-resolves
                // per open document and posts per-webview (MAR-110).
                MarkdownEditorProvider.current?.broadcastFoldingConfig();
            }
            if (e.affectsConfiguration("birta.contentWidth")
                || e.affectsConfiguration("birta.maxContentWidth")) {
                const cw = resolveContentWidthConfig();
                MarkdownEditorProvider.current?.postToAll({
                    type: "setContentWidth",
                    cssValue: cw.cssValue,
                    isAuto: cw.isAuto,
                    mode: cw.mode,
                });
            }
        }),
    );

    // No theme listener is needed: the webview consumes VS Code's
    // natively-injected --vscode-* variables, which VS Code updates live on
    // every theme change. The webview's native-theme bridge
    // (webview/nativeThemeBridge.ts) relays the body-class swap to JS-driven
    // consumers (e.g. Mermaid), so nothing has to round-trip through the
    // extension host.

    // Close preview: WYSIWYG → text editor
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "birta.switchToTextEditor",
            async (uri?: vscode.Uri) => {
                let target =
                    uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target) {
                    // When the Custom Editor is active, activeTextEditor is undefined; find the active CustomEditor tab from the tab groups
                    for (const group of vscode.window.tabGroups.all) {
                        const activeTab = group.activeTab;
                        if (activeTab?.input instanceof vscode.TabInputCustom) {
                            target = (activeTab.input as vscode.TabInputCustom).uri;
                            break;
                        }
                    }
                }
                if (!target) { return; }

                const provider = MarkdownEditorProvider.current;
                // Preferred approach: request the current scroll line number from the WebView; the WebView reports the position and then triggers the switch itself
                // This keeps the menu button and Cmd+Shift+M shortcut behavior consistent (both carry the line number and do not actively close the custom editor tab)
                if (provider) {
                    provider.postToPanel(target, { type: "requestSwitchToTextEditor" });
                    return;
                }

                // Fallback: when the panel does not exist, open the text editor directly (without a line number)
                await vscode.commands.executeCommand("vscode.openWith", target, "default");
            },
        ),
    );

    // MAR-9: editor action commands (command palette + right-click context
    // menu). Every entry in the shared table registers one command that posts a
    // single `editorCommand` message to the target webview, which dispatches it
    // into the shared editor-command registry. A webview/context menu passes its
    // `data-vscode-context` object as the first argument; we read `documentUri`
    // from it as a belt-and-braces routing hint (falling back to the active
    // panel). Palette visibility is gated in package.json.
    for (const meta of EDITOR_COMMANDS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(editorCommandName(meta.id), (arg?: unknown) => {
                const ctxObj = arg && typeof arg === "object" ? (arg as Record<string, unknown>) : undefined;
                const documentUri = typeof ctxObj?.["documentUri"] === "string" ? (ctxObj["documentUri"] as string) : undefined;
                // Right-click targets travel with the command so it operates on
                // the clicked cell/block, not the live selection (which the
                // native-menu round-trip does not reliably preserve). The two
                // stamps merge into one args object: { cellPos?, blockPos? }.
                const tableTarget = ctxObj?.["tableTarget"];
                const blockTarget = ctxObj?.["blockTarget"];
                const args = tableTarget || blockTarget
                    ? {
                        ...(typeof tableTarget === "object" ? tableTarget : {}),
                        ...(typeof blockTarget === "object" ? blockTarget : {}),
                    }
                    : undefined;
                MarkdownEditorProvider.current?.postEditorCommand(meta.id, documentUri, args);
            }),
        );
    }

    // Open preview: text editor → WYSIWYG
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "birta.switchToPreview",
            async (uri?: vscode.Uri) => {
                const activeEditor = vscode.window.activeTextEditor;
                const target = uri ?? activeEditor?.document.uri;
                if (!target) {
                    return;
                }
                // Save the current cursor line number before switching, for positioning when the WYSIWYG panel is activated
                const currentLine = activeEditor?.selection.active.line ?? -1;
                if (currentLine >= 0) {
                    MarkdownEditorProvider.current?.setPendingNavigation(target.fsPath, currentLine + 1);
                }
                // Read the text editor tab's preview state and column, saving before closing
                let isPreview = false;
                let viewCol: vscode.ViewColumn = vscode.ViewColumn.Active;
                let textTab: vscode.Tab | undefined;
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        if (
                            tab.input instanceof vscode.TabInputText &&
                            (tab.input as vscode.TabInputText).uri.toString() === target.toString()
                        ) {
                            isPreview = tab.isPreview;
                            viewCol = group.viewColumn;
                            textTab = tab;
                            break;
                        }
                    }
                }
                // Close the source (text) tab FIRST, then open WYSIWYG — and
                // switch only if the close succeeded. Closing a dirty tab shows
                // VS Code's native Save / Don't Save / Cancel prompt: Save and
                // Don't Save close it (→ we proceed to render), Cancel leaves it
                // open and returns false (→ true no-op). Opening the destination
                // only after a successful close means a mode switch never spawns
                // a second tab based on dirty state.
                if (textTab) {
                    const closed = await vscode.window.tabGroups.close(textTab);
                    if (!closed) { return; }
                }
                await vscode.commands.executeCommand(
                    "vscode.openWith",
                    target,
                    MarkdownEditorProvider.viewType,
                    { viewColumn: viewCol, preview: isPreview },
                );
            },
        ),
    );

    // Go-to-Symbol quick pick (MAR-12): parity for Cmd+Shift+O while the WYSIWYG
    // custom editor is focused. The built-in symbol picker binds to
    // window.activeTextEditor, which is undefined for a webview custom editor,
    // so the Outline / breadcrumbs / Cmd+Shift+O never populate in WYSIWYG mode.
    // This QuickPick scans the backing TextDocument's headings and reveals the
    // chosen one by posting the existing scrollToLine message to the panel.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "birta.gotoSymbol",
            async () => {
                // Resolve the active custom editor's document URI from the tab
                // groups (activeTextEditor is undefined here).
                let target: vscode.Uri | undefined;
                for (const group of vscode.window.tabGroups.all) {
                    const activeTab = group.activeTab;
                    if (
                        activeTab?.input instanceof vscode.TabInputCustom &&
                        (activeTab.input as vscode.TabInputCustom).viewType === MarkdownEditorProvider.viewType
                    ) {
                        target = (activeTab.input as vscode.TabInputCustom).uri;
                        break;
                    }
                }
                if (!target) { return; }

                const doc =
                    vscode.workspace.textDocuments.find(
                        (d) => d.uri.toString() === target!.toString(),
                    ) ?? (await vscode.workspace.openTextDocument(target));
                const headings = scanHeadings(doc.getText());
                if (headings.length === 0) {
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("No headings in this document."),
                    );
                    return;
                }

                const provider = MarkdownEditorProvider.current;

                // Level → symbol icon (kind mirrors the built-in markdown outline:
                // H1/H2 as string-like sections, deeper levels as fields).
                const iconFor = (level: number): string =>
                    level <= 1 ? "$(symbol-string)"
                    : level === 2 ? "$(symbol-field)"
                    : "$(symbol-key)";

                type HeadingItem = vscode.QuickPickItem & { line: number };
                const items: HeadingItem[] = headings.map((h) => ({
                    // Indent by level so the hierarchy reads at a glance.
                    label: `${"    ".repeat(Math.max(0, h.level - 1))}${iconFor(h.level)} ${h.text || "(untitled)"}`,
                    description: `H${h.level}`,
                    line: h.line,
                }));

                const quickPick = vscode.window.createQuickPick<HeadingItem>();
                quickPick.title = vscode.l10n.t("Go to Heading");
                quickPick.placeholder = vscode.l10n.t("Type to filter headings");
                quickPick.matchOnDescription = true;
                quickPick.items = items;

                // Live preview: reveal the highlighted heading as the user moves.
                quickPick.onDidChangeActive((active) => {
                    const item = active[0];
                    if (item && provider && target) {
                        provider.postToPanel(target, { type: "scrollToLine", line: item.line });
                    }
                });
                quickPick.onDidAccept(() => {
                    const item = quickPick.selectedItems[0];
                    if (item && provider && target) {
                        provider.postToPanel(target, { type: "scrollToLine", line: item.line });
                    }
                    quickPick.dispose();
                });
                quickPick.show();
            },
        ),
    );
}

export function deactivate() {}
