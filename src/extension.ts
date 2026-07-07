import * as vscode from "vscode";
import { MarkdownEditorProvider } from "./MarkdownEditorProvider";
import { getAllThemes, getCustomThemes, type ThemeInfo } from "./themeManager";
import type { TableWrapMode, FontPreset } from "../shared/messages";
import { resolveFontFamily, DEFAULT_FONT_PRESET, DEFAULT_FONT_SIZE_PERCENT, clampFontSizePercent } from "../shared/fontPresets";
import { scanHeadings } from "./utils/headingScan";
import { EDITOR_COMMANDS, editorCommandName } from "../shared/editorCommands";

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

    // Sync editorAssociations once on activation
    const initialMode = vscode.workspace
        .getConfiguration("markdownWysiwyg")
        .get<string>("defaultMode", "preview");
    syncEditorAssociation(initialMode);

    // Under priority:option, file opening is not taken over automatically; use onDidChangeTabs to watch text tabs and switch to WYSIWYG
    // Diff views only produce TabInputTextDiff and won't trigger this logic
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(async (event) => {
            const mode = vscode.workspace
                .getConfiguration("markdownWysiwyg")
                .get<string>("defaultMode", "preview");
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
    const initialDebug = vscode.workspace
        .getConfiguration("markdownWysiwyg")
        .get<boolean>("debugMode", false);
    vscode.commands.executeCommand(
        "setContext",
        "markdownWysiwyg.debugModeActive",
        initialDebug,
    );

    // Debug mode toggle command (two mutually exclusive commands, whose display is switched via when conditions to achieve the ✓ prefix effect)
    const toggleDebugMode = () => {
        const cfg = vscode.workspace.getConfiguration("markdownWysiwyg");
        const next = !cfg.get<boolean>("debugMode", false);
        cfg.update("debugMode", next, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand(
            "setContext",
            "markdownWysiwyg.debugModeActive",
            next,
        );
        MarkdownEditorProvider.current?.postToAll({
            type: "setDebugMode",
            enabled: next,
        });
    };
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "markdownWysiwyg.debugModeEnable",
            toggleDebugMode,
        ),
        vscode.commands.registerCommand(
            "markdownWysiwyg.debugModeDisable",
            toggleDebugMode,
        ),
    );

    // Toggle style check (keyboard shortcut / command palette); the config
    // change listener below broadcasts the new state to every open editor.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "markdownWysiwyg.toggleStyleCheck",
            () => MarkdownEditorProvider.toggleStyleCheck(),
        ),
    );

    // Select color theme command
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "markdownWysiwyg.selectTheme",
            async () => {
                const themes = getAllThemes();
                const customThemes = getCustomThemes();
                const currentTheme = vscode.workspace
                    .getConfiguration("markdownWysiwyg")
                    .get<string>("colorTheme", "auto");

                // Group by type: dark themes first, light themes after, sorted alphabetically within each group
                const darkThemes = themes
                    .filter(t => t.uiTheme === "vs-dark" || t.uiTheme === "hc-black")
                    .sort((a, b) => a.label.localeCompare(b.label));
                const lightThemes = themes
                    .filter(t => t.uiTheme === "vs" || t.uiTheme === "hc-light")
                    .sort((a, b) => a.label.localeCompare(b.label));

                const items: (vscode.QuickPickItem & { value: string })[] = [
                    { label: "$(color-mode) Auto", description: "Follow VS Code Theme", value: "auto" },
                    // Custom themes
                    ...customThemes.map(t => ({
                        label: `$(paintbrush) ${t.name}`,
                        description: "Custom",
                        value: `custom:${t.name}`,
                    })),
                    // Dark themes
                    ...darkThemes.map(t => ({
                        label: t.label,
                        description: "Dark",
                        value: t.id,
                    })),
                    // Light themes
                    ...lightThemes.map(t => ({
                        label: t.label,
                        description: "Light",
                        value: t.id,
                    })),
                ];

                // Find the index of the currently selected theme, used for positioning
                const activeIndex = items.findIndex((item: any) => item.value === currentTheme);

                const quickPick = vscode.window.createQuickPick();
                quickPick.title = "Markdown Editor Color Theme";
                quickPick.placeholder = "Select a color theme for Markdown editor";
                quickPick.items = items;
                if (activeIndex >= 0) {
                    quickPick.activeItems = [items[activeIndex]];
                }

                quickPick.onDidAccept(async () => {
                    const selected = quickPick.selectedItems[0];
                    if (selected) {
                        const themeId = (selected as any).value;
                        await vscode.workspace
                            .getConfiguration("markdownWysiwyg")
                            .update("colorTheme", themeId, vscode.ConfigurationTarget.Global);
                    }
                    quickPick.dispose();
                });

                quickPick.show();
            },
        ),
    );

    // Show current theme command
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "markdownWysiwyg.showCurrentTheme",
            () => {
                const configTheme = vscode.workspace
                    .getConfiguration("markdownWysiwyg")
                    .get<string>("colorTheme", "auto");

                const vscodeTheme = vscode.workspace
                    .getConfiguration("workbench")
                    .get<string>("colorTheme", "Unknown");

                const themeKind = vscode.window.activeColorTheme.kind;
                const themeType = themeKind === vscode.ColorThemeKind.Light ? "Light"
                    : themeKind === vscode.ColorThemeKind.Dark ? "Dark"
                    : themeKind === vscode.ColorThemeKind.HighContrast ? "High Contrast"
                    : "High Contrast Light";

                let message: string;
                if (configTheme === "auto") {
                    message = `Theme: Auto (follows VS Code)\nVS Code Theme: ${vscodeTheme}\nType: ${themeType}`;
                } else {
                    const themes = getAllThemes();
                    const theme = themes.find(t => t.id === configTheme);
                    message = `Theme: ${theme?.label ?? configTheme}\nType: ${theme?.uiTheme ?? themeType}`;
                }

                vscode.window.showInformationMessage(message, { modal: false });
            },
        ),
    );

    // Listen for manual setting changes (sync when modified from the VSCode settings UI)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("markdownWysiwyg.defaultMode")) {
                const mode = vscode.workspace
                    .getConfiguration("markdownWysiwyg")
                    .get<string>("defaultMode", "preview");
                syncEditorAssociation(mode);
            }
            if (e.affectsConfiguration("markdownWysiwyg.debugMode")) {
                const v = vscode.workspace
                    .getConfiguration("markdownWysiwyg")
                    .get<boolean>("debugMode", false);
                vscode.commands.executeCommand(
                    "setContext",
                    "markdownWysiwyg.debugModeActive",
                    v,
                );
                MarkdownEditorProvider.current?.postToAll({
                    type: "setDebugMode",
                    enabled: v,
                });
            }
            if (e.affectsConfiguration("markdownWysiwyg.colorTheme")) {
                MarkdownEditorProvider.current?.applyThemeToAll();
            }
            if (e.affectsConfiguration("markdownWysiwyg.tableWrap")) {
                const cfg = vscode.workspace.getConfiguration("markdownWysiwyg");
                const tableWrap = cfg.get<TableWrapMode>("tableWrap", "normal");
                MarkdownEditorProvider.current?.postToAll({ type: "setTableWrap", wrap: tableWrap });
            }
            if (e.affectsConfiguration("markdownWysiwyg.styleCheck")
                || e.affectsConfiguration("markdownWysiwyg.spellCheck")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "proofreadConfig",
                    config: MarkdownEditorProvider.getProofreadConfig(),
                });
            }
            if (e.affectsConfiguration("markdownWysiwyg.toolbar")) {
                MarkdownEditorProvider.current?.postToAll({
                    type: "toolbarConfig",
                    config: MarkdownEditorProvider.getToolbarConfig(),
                });
            }
            if (e.affectsConfiguration("markdownWysiwyg.fontPreset")
                || e.affectsConfiguration("markdownWysiwyg.fontFamilySans")
                || e.affectsConfiguration("markdownWysiwyg.fontFamilySerif")
                || e.affectsConfiguration("markdownWysiwyg.fontFamilyMono")) {
                const cfg = vscode.workspace.getConfiguration("markdownWysiwyg");
                const preset = cfg.get<FontPreset>("fontPreset", DEFAULT_FONT_PRESET);
                const stacks = MarkdownEditorProvider.getFontStacks(cfg);
                MarkdownEditorProvider.current?.postToAll({
                    type: "setFontFamily",
                    fontFamily: resolveFontFamily(preset, stacks),
                    preset,
                    stacks,
                });
            }
            if (e.affectsConfiguration("markdownWysiwyg.fontSize")) {
                const cfg = vscode.workspace.getConfiguration("markdownWysiwyg");
                MarkdownEditorProvider.current?.postToAll({
                    type: "setFontSize",
                    size: clampFontSizePercent(cfg.get<number>("fontSize", DEFAULT_FONT_SIZE_PERCENT)),
                });
            }
        }),
    );

    // No onDidChangeActiveColorTheme listener is needed in auto mode: the
    // webview consumes VS Code's natively-injected --vscode-* variables, which
    // VS Code updates live on every theme change (see resolveThemeColors and
    // the webview's native-theme bridge). A pinned/custom editor theme only
    // changes via configuration, handled by the onDidChangeConfiguration
    // listener on markdownWysiwyg.colorTheme above.

    // Close preview: WYSIWYG → text editor
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "markdownWysiwyg.switchToTextEditor",
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
            "markdownWysiwyg.switchToPreview",
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
                // Close the text editor tab first, then open WYSIWYG, to avoid the flicker of two tabs coexisting
                if (textTab) {
                    await vscode.window.tabGroups.close(textTab);
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
            "markdownWysiwyg.gotoSymbol",
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
