/**
 * messageHandlers.ts
 * 
 * Dispatches Extension -> WebView messages.
 *
 * Maps each message type to its handler function, decoupling the messages and
 * keeping dispatch type-safe. Handlers receive the external capabilities they
 * need via dependency injection, which keeps them testable and maintainable.
 */

import type { Editor } from "@milkdown/core";
import type { EditorView } from "./pm";
import type { ToWebviewMessage, TableWrapMode } from "../shared/messages";
import { clampFontSizePercent } from "../shared/fontPresets";
// The extension always sends `lineMap`, so this only ever runs when it somehow
// did not — and then computing it locally, from the very content the message
// carried, is strictly better than the empty map that used to be substituted.
// An empty map degrades EVERY consumer silently (scroll-to-line, the find bar's
// raw-source fallback, the line-number gutter). The `??` short-circuits in the
// normal case, so this costs the mount path nothing.
import { computeLineMap } from "../shared/lineMap";
import { applyBlockHandles } from "./utils/blockHandles";
import { setMermaidThemeMode, setPlantUmlThemeMode } from "./components/codeBlock";
import { applyFoldingControls } from "./utils/foldingControls";
import { foldPluginKey, type FoldMeta } from "./plugins/foldState";
import { bankOpenHtmlPanel } from "./components/htmlView";
import { bankOpenBlockSourcePanel } from "./components/blockSource";
import { setImageUriMap } from "./components/imageView";
import { dispatchPathSuggestions } from "./components/pathLink/pathComplete";
import { dispatchLinkTargetSuggestions, dispatchLinkTargetPicked, dispatchLinkTargetResolved } from "./components/pathLink/linkTargetComplete";
import { dispatchImgPathSuggestions, dispatchImagePathResolved } from "./components/imageView/imgPathComplete";
import { setLogTableSel, syncExternalContent, flushPendingEdit, acknowledgeFlush } from "./editor";
import { regateCalcCues, regateNoteMarkers, setProofreadConfig, failAgentRun, markAgentRunning, settleAgentRun } from "./plugins";
import { mergeAgentResult } from "./editor";
import { notifyAgentMergeResult } from "./messaging";
import { t } from "./i18n";
import { mark } from "./perf";
import { setReadOnly } from "./readOnly";
import { absorbTocVisibilityUnderFocus, maskProofreadConfigUnderFocus, maskToolbarConfigUnderFocus } from "./focusMode";
import { applyLintResults } from "./plugins/proofread";
import { withScrollAnchor } from "./utils/scrollAnchor";
import { notifySwitchToTextEditor, getWebviewState, setWebviewState, setBaseSyncVersion, notifyFlushResult, notifyPerfMarks, notifyEditorContextResult } from "./messaging";
import type { EditorSelectionContext } from "../shared/agentContext";
import { renderFrontmatterPanel, refreshFrontmatterEmptyState } from "./components/frontmatter";
import { dispatchFmSuggestions } from "./components/frontmatter/suggestMenu";
import { runEditorCommand } from "./editorCommands";
import {
    handleImageUploaded,
    handleImageUploadError,
    handleProjectImagesList,
} from "./imageUpload";
import { handleUnfurlResult } from "./unfurl";
import { handleEmbedMetaResult } from "./embedMeta";
import { handleLinkCardResult } from "./linkCardMeta";
import { handleEmbedCardResult, setConnectorStates } from "./embedConnector";
import { regateEmbeds } from "./plugins/embed";
import { setWhatsNewUnread } from "./components/toolbar/settingsMenu";

// ── Global table wrap mode ─────────────────────────────────
let currentTableWrap: TableWrapMode = "normal";

/** Update table cells' overflow-wrap property from the current tableWrap config. */
export function applyTableWrap(wrap: TableWrapMode): void {
    currentTableWrap = wrap;
    const root = document.documentElement;
    switch (wrap) {
        case "aggressive":
            root.style.setProperty("--tbl-ow", "anywhere");
            break;
        case "normal":
            root.style.setProperty("--tbl-ow", "break-word");
            break;
        case "none":
            root.style.setProperty("--tbl-ow", "normal");
            break;
    }
}

// ── Type definitions ───────────────────────────────────────

type ExtractMessage<T extends ToWebviewMessage["type"]> = Extract<ToWebviewMessage, { type: T }>;

/** Message-handler function type. */
export type Handler<T extends ToWebviewMessage["type"] = ToWebviewMessage["type"]> = (
    msg: ExtractMessage<T>,
    container: HTMLElement,
) => void | Promise<void>;

/** Toolbar controller interface. */
export interface ToolbarController {
    onSelectionChange(view: EditorView): void;
    /** Blank the bar while focus is in a nested editable island (a callout title). */
    setDetached(): void;
    setDebugMode(enabled: boolean): void;
    /** Rebuild the toolbar for a changed per-item placement config. */
    applyConfig(config: import("../shared/messages").ToolbarConfig): void;
    /** Update the font picker's active-preset indicator (and, when provided, its per-preset stack previews). */
    setFontPreset(preset: import("../shared/messages").FontPreset, stacks?: import("../shared/messages").FontStacks): void;
    /** Update the font picker's size-stepper display (percent). */
    setFontSize(size: number): void;
    /** Update the typography menu's content-width segmented control (and cache the fixed width). */
    setContentWidth(mode: import("../shared/contentWidth").ContentWidthMode, fixedCss?: string): void;
    /** Update the typography menu's block-handles radio rows. */
    setBlockHandles(mode: import("../shared/blockHandles").BlockHandlesMode): void;
    /** Show/hide the disk-drift badge (file on disk changed vs unsaved edits). */
    setSyncConflict(active: boolean): void;
    /** Show the Logseq badge with the reason's tooltip, or hide it (null). */
    setLogseq(reason: import("../shared/messages").LogseqReason | null): void;
}

/** Editor state-management interface. */
export interface EditorStateAccessor {
    getEditor: () => Editor | null;
    setEditor: (editor: Editor | null) => void;
    setLineMap: (lineMap: number[]) => void;
    getMarkdownSource: () => string;
    setMarkdownSource: (source: string) => void;
}

/** Editor actions interface. */
export interface EditorActions {
    /**
     * Put the caret at a DOCUMENT line (frontmatter included) and, when given, a
     * column. Needs no layout, so it can run before the first paint settles.
     */
    placeCaretAtLine: (line: number, column?: number, anchor?: { line: number; column?: number }) => void;
    /** Scroll the block for a DOCUMENT line to the viewport centre. Needs layout. */
    scrollToDocumentLine: (line: number) => void;
    /** The source position (document line, optional column) a mode switch carries out. */
    getSwitchTarget: () => { line: number; column?: number; anchorLine?: number; anchorColumn?: number } | undefined;
    /** The live selection context for a coding-agent bridge pull, or null when unmappable. */
    getSelectionContext: () => EditorSelectionContext | null;
    /** Record how many source lines the frontmatter occupies (MAR-23). */
    setLineOffset: (offset: number) => void;
    /**
     * (Re)build the editor. `format` selects the document's FormatModule and
     * is carried only by `init`; re-init paths (externalUpdate fallback) omit
     * it and reuse the format the document opened with.
     */
    initEditor: (container: HTMLElement, markdown: string, format?: import("../shared/messages").DocumentFormat) => Promise<void>;
    retryScroll: (fn: () => void) => void;
    getEditorView: () => EditorView | null;
    /** Refreshes the table-of-contents panel after an inbound diff sync. */
    refreshToc: () => void;
    /** Flips the table-of-contents panel to the given dock side. */
    setTocPosition: (position: import("../shared/messages").TocPosition) => void;
    /** Applies a birta.tocVisibility change (no re-persist). */
    setTocVisibility: (visibility: import("../shared/messages").TocVisibility) => void;
    /** Applies a birta.tocWidth change (no re-persist). */
    setTocWidth: (width: number) => void;
    /** Applies a birta.notes.customMarkers change to the Notes review tab. */
    setNotesMarkers: (markers: string[]) => void;
    /** Applies a birta.review.groupByType change to both review tabs. */
    setReviewGroupByType: (grouped: boolean) => void;
    /**
     * Applies a birta.lineNumbers change. Turning it ON is what first loads the
     * gutter's module (utils/lineNumbersLoader.ts); turning it off removes the
     * layer from the DOM.
     */
    setLineNumbers: (enabled: boolean) => void;
}

/** Message-handler dependencies. */
export interface MessageHandlerDeps {
    state: EditorStateAccessor;
    actions: EditorActions;
    topbarTb: ToolbarController | null;
}

// ── Message-handler factory ────────────────────────────────

/** Create the message handlers. */
export function createMessageHandlers(
    deps: MessageHandlerDeps,
): { [K in ToWebviewMessage["type"]]?: Handler<K> } {
    const { state, actions, topbarTb } = deps;
    const { getEditor, setEditor, setLineMap, getMarkdownSource, setMarkdownSource } = state;
    const { placeCaretAtLine, scrollToDocumentLine, getSwitchTarget, getSelectionContext, setLineOffset, initEditor, retryScroll, getEditorView, refreshToc, setTocPosition, setTocVisibility, setTocWidth, setNotesMarkers, setReviewGroupByType } = actions;

    /**
     * Rebuild the embed decorations after a gate flip. A no-op before the editor
     * exists (a gate can change while the panel is still initializing) — the
     * first decoration pass reads the current gates anyway.
     */
    const regateEmbedsIfPossible = (): void => {
        const view = getEditorView();
        if (view) { regateEmbeds(view); }
    };

    return {
        async init(msg, container) {
            mark("init-received");
            // Seed the webview state bag from the extension's per-URI echo
            // BEFORE anything reads it (frontmatter collapse below, fold
            // anchors at editor creation, scroll restore). PER-KEY merge,
            // live bag winning: when VS Code itself restored the webview
            // (tab hide, window reload) the live bag is fresher — but a
            // revived bag that merely LACKS a key (a stale `{scrollY}` from
            // an older session) must not discard everything the extension
            // remembered. The old all-or-nothing skip did exactly that: one
            // stale key silently reverted every table width and fold.
            if (msg.viewState) {
                setWebviewState({ ...msg.viewState, ...(getWebviewState() ?? {}) });
            }
            setBaseSyncVersion(msg.syncVersion);
            setMarkdownSource(msg.content);
            setLineMap(msg.lineMap ?? computeLineMap(msg.content));
            setLineOffset(msg.lineOffset ?? 0);
            renderFrontmatterPanel(msg.frontmatter);
            if (msg.imageUriMap) {
                setImageUriMap(msg.imageUriMap);
            }
            if (msg.tableWrap) {
                applyTableWrap(msg.tableWrap);
            }
            await initEditor(container, msg.content, msg.format);
            window.focus();
            if (msg.scrollToLine) {
                // The caret needs only the document, so it lands now; the scroll
                // waits for the first blocks to have a measurable height.
                placeCaretAtLine(
                    msg.scrollToLine,
                    msg.scrollToColumn,
                    msg.scrollToAnchorLine !== undefined
                        ? { line: msg.scrollToAnchorLine, column: msg.scrollToAnchorColumn }
                        : undefined,
                );
                retryScroll(() => scrollToDocumentLine(msg.scrollToLine!));
            } else {
                const saved = getWebviewState();
                if (saved?.scrollY) {
                    retryScroll(() =>
                        window.scrollTo({ top: saved.scrollY as number }),
                    );
                }
            }
        },
        async externalUpdate(msg, container) {
            // Bank an open source panel BEFORE the incoming content replaces
            // local state, so the user's uncommitted text is part of what the
            // merge re-bases rather than something it overwrites. The panel
            // lives in a NodeView that any transaction touching its node
            // recreates, and `destroy` does not commit; a focused element
            // removed from the document fires no blur, so without this the
            // typed value is dropped with nothing to undo. Same seam as
            // flushSave and the mode switch.
            const openView = getEditorView();
            if (openView) {
                bankOpenHtmlPanel(openView);
                bankOpenBlockSourcePanel(openView);
            }
            // Record the version we're syncing to so subsequent outbound edits
            // carry it as baseSyncVersion (stale-update rejection on the
            // extension side).
            setBaseSyncVersion(msg.syncVersion);
            setMarkdownSource(msg.content);
            setLineMap(msg.lineMap ?? computeLineMap(msg.content));
            setLineOffset(msg.lineOffset ?? 0);
            renderFrontmatterPanel(msg.frontmatter);
            if (msg.imageUriMap) {
                setImageUriMap(msg.imageUriMap);
            }
            if (msg.tableWrap) {
                applyTableWrap(msg.tableWrap);
            }
            // Cursor-preserving diff apply; on any failure fall back to a full
            // rebuild exactly like revert (which loses the selection but is
            // guaranteed correct).
            if (syncExternalContent(msg.content)) {
                refreshToc();
            } else {
                await initEditor(container, msg.content);
            }
        },
        requestSwitchToTextEditor() {
            notifySwitchToTextEditor(getSwitchTarget());
        },
        requestEditorContext(msg) {
            // A coding-agent bridge (src/agentBridge/) asked for the live file
            // selection. Compute it from the current editor state and reply. This
            // is the ONLY driver of the mapping — nothing runs on the editor's own
            // selection-change path — so the editor pays nothing until an agent asks.
            notifyEditorContextResult(msg.id, getSelectionContext());
        },
        scrollToLine(msg) {
            let scrollAttempts = 0;
            const tryScrollNow = () => {
                const view = getEditorView();
                if (view) {
                    // Arriving from the raw editor or a search hit: the caret
                    // moves too, so typing continues where the user landed
                    // rather than at the top of the document (MAR-23).
                    placeCaretAtLine(
                        msg.line,
                        msg.column,
                        msg.anchorLine !== undefined
                            ? { line: msg.anchorLine, column: msg.anchorColumn }
                            : undefined,
                    );
                    scrollToDocumentLine(msg.line);
                } else if (scrollAttempts < 8) {
                    scrollAttempts++;
                    setTimeout(tryScrollNow, 250);
                }
            };
            tryScrollNow();
        },
        lineMapUpdate(msg) {
            setLineMap(msg.lineMap);
            setLineOffset(msg.lineOffset ?? 0);
        },
        flushSave(msg) {
            // A save is imminent: serialize the live document NOW (bypassing the
            // throttle) and reply so the extension writes the freshest content.
            // An open HTML source panel banks its edit first (blur commits
            // synchronously), so the flush cannot persist bytes older than
            // what the panel shows — the same seam the mode switch has.
            const view = getEditorView();
            if (view) {
                bankOpenHtmlPanel(view);
                bankOpenBlockSourcePanel(view);
            }
            notifyFlushResult(msg.id, flushPendingEdit(msg.id));
        },
        flushAck(msg) {
            // The extension's verdict on our flushResult: commit the parked
            // baseline candidate (applied) or abandon it and re-sync (discarded).
            acknowledgeFlush(msg.id, msg.applied);
        },
        __testInsertText(msg) {
            // TEST-ONLY (see the message's declaration): insert text at the caret
            // via a real ProseMirror transaction, so the integration suite can put
            // the editor genuinely ahead of the backing document.
            const view = getEditorView();
            if (!view) { return; }
            // Trip the "user has interacted" gate exactly as a real keystroke does
            // (capture-phase keydown listener in editor.ts); without it the update
            // listener skips the sync and the edit would never reach the document.
            document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: msg.text.slice(0, 1) }));
            view.focus();
            view.dispatch(view.state.tr.insertText(msg.text, view.state.selection.to));
        },
        __getPerfMarks(msg) {
            // TEST-ONLY (see the message's declaration): reply with the `mdw:`
            // marks (prefix stripped) already stamped by webview/perf.ts, so the
            // integration suite can measure real launch time in a live VS Code
            // webview and validate the headless harness against reality (MAR-191).
            const marks: Record<string, number> = {};
            for (const e of performance.getEntriesByType("mark")) {
                if (e.name.startsWith("mdw:")) { marks[e.name.slice(4)] = e.startTime; }
            }
            notifyPerfMarks(msg.id, marks);
        },
        setDebugMode(msg) {
            setLogTableSel(msg.enabled);
            topbarTb?.setDebugMode(msg.enabled);
        },
        imageUploaded(msg) {
            handleImageUploaded(msg.id, msg.url);
        },
        agentRun(msg) {
            // The life of an `/ai` background run (plugins/agentPending): the
            // marker shows on `running`, clears on `done`, and a `done` that
            // carries the file's text is the reload VS Code refused because
            // the user typed meanwhile, merged here around their edits.
            const view = getEditorView();
            if (!view) { return; }
            switch (msg.status) {
                case "running":
                    markAgentRunning(view, msg.requestId, msg.harness);
                    return;
                case "failed":
                    failAgentRun(view, msg.requestId, msg.message ?? "");
                    return;
                case "done": {
                    if (msg.text !== undefined) {
                        const outcome = mergeAgentResult(msg.requestId, msg.text);
                        notifyAgentMergeResult(msg.requestId, outcome);
                        if (outcome === "conflict") {
                            failAgentRun(view, msg.requestId, t("its changes overlap yours; the file on disk holds them, and Compare in the drift badge shows both"));
                            return;
                        }
                        if (outcome === "partial") {
                            failAgentRun(view, msg.requestId, t("some of its changes overlapped yours and were left out; the file on disk holds them all"));
                            return;
                        }
                    }
                    settleAgentRun(view, msg.requestId);
                    return;
                }
                case "cancelled":
                case "handedOff":
                    settleAgentRun(view, msg.requestId);
                    return;
            }
        },
        imageUploadError(msg) {
            handleImageUploadError(msg.id, msg.error);
        },
        projectImagesList(msg) {
            handleProjectImagesList(msg.id, msg.images);
        },
        pathSuggestions(msg) {
            dispatchPathSuggestions(msg.id, msg.items);
            dispatchImgPathSuggestions(msg.id, msg.items);
        },
        linkTargetSuggestions(msg) {
            dispatchLinkTargetSuggestions(msg.id, msg.items);
        },
        linkTargetResolved(msg) {
            dispatchLinkTargetResolved(msg.id, msg.resolved);
        },
        linkTargetPicked(msg) {
            dispatchLinkTargetPicked(msg.id, msg.path);
        },
        imagePathResolved(msg) {
            dispatchImagePathResolved(msg.id, msg.webviewUri);
        },
        unfurlResult(msg) {
            // Paste-unfurl reply: upgrade the bare `[url](url)` to `[title](url)`
            // in the live doc (or keep the bare link when title is null).
            handleUnfurlResult(getEditorView(), msg.id, msg.title);
        },
        embedMetaResult(msg) {
            // Embed-card metadata reply: settle the store; subscribed card
            // captions fill in. Render-only — never touches the document.
            handleEmbedMetaResult(msg.id, msg.title);
        },
        linkCardResult(msg) {
            // Link-card metadata reply: same shape, keyed by URL. Render-only.
            handleLinkCardResult(msg.id, msg.card);
        },
        embedCardResult(msg) {
            // Connector card reply: settle the store; subscribed cards fill in
            // their status chip and detail line. Render-only, and there is no
            // field here a credential could arrive in.
            handleEmbedCardResult(msg.id, msg.result);
        },
        connectorStateChanged(msg) {
            // Which services are connected. Re-gating repaints every card
            // against the new map, which is how a service connected a moment
            // ago unlocks the cards already on screen without a reload.
            setConnectorStates(msg.connectors);
            regateEmbedsIfPossible();
        },
        setTableWrap(msg) {
            applyTableWrap(msg.wrap);
        },
        networkStateChanged(msg) {
            // Live update of the in-session master-switch gate (the same one
            // the local opt-in affordance flips): paste-unfurl in THIS webview
            // now matches the persisted setting without a reload.
            if (window.__i18n) {
                window.__i18n.network = msg.enabled;
            }
            // Embeds read the gate from a decoration pass, which only reruns on
            // a transaction — so the flag alone changes nothing on screen.
            regateEmbedsIfPossible();
        },
        copyFormatChanged(msg) {
            // Read at copy time from __i18n — flipping the field is the update.
            if (window.__i18n) {
                window.__i18n.copyFormat = msg.format;
            }
        },
        pasteFormatChanged(msg) {
            // Read at paste time from __i18n — flipping the field is the update.
            if (window.__i18n) {
                window.__i18n.pasteFormat = msg.format;
            }
        },
        featureGateChanged(msg) {
            // Read-at-use-time gates: flipping the __i18n field is the whole
            // update (calc's advisory/auto split, the checklist sink, the
            // unfurl feature key all read it per event, not per composition).
            if (window.__i18n) {
                window.__i18n[msg.gate] = msg.enabled;
            }
            if (msg.gate === "embedsEnabled" || msg.gate === "linkCardsEnabled") {
                regateEmbedsIfPossible();
            }
            if (msg.gate === "calcEnabled") {
                // The advisory/auto calc paths read the flag per event; only
                // the stale-cue decorations need an explicit re-gate (clear
                // cues on off, first scan on on).
                const view = getEditorView();
                if (view) { regateCalcCues(view); }
            }
            if (msg.gate === "frontmatterAddButton") {
                refreshFrontmatterEmptyState();
            }
        },
        embedProvidersChanged(msg) {
            // Same read-at-use-time shape as the gates above: replacing the
            // __i18n map is the whole update, and the re-gate repaints the
            // documents already open.
            if (window.__i18n) {
                window.__i18n.embedProviders = msg.providers;
            }
            regateEmbedsIfPossible();
        },
        setBlockHandles(msg) {
            applyBlockHandles(msg.mode);
            topbarTb?.setBlockHandles(msg.mode);
        },
        setLineNumbers(msg) {
            actions.setLineNumbers(msg.enabled);
        },
        setReadOnly(msg) {
            // Straight through to the mode's one owner, which announces to
            // every mirroring control (the toolbar toggle, the body class, the
            // ProseMirror `editable` predicate). Nothing else caches it.
            setReadOnly(msg.readOnly);
        },
        setMermaidTheme(msg) {
            setMermaidThemeMode(msg.mode);
        },
        setPlantUmlTheme(msg) {
            setPlantUmlThemeMode(msg.mode);
        },
        setFoldingControls(msg) {
            // Chevron residency is pure CSS (body classes); the enabled flag
            // also reaches the fold plugin so disabling `editor.folding`
            // expands every UI-only fold and stops all fold decoration work.
            applyFoldingControls(msg.controls, msg.enabled);
            const view = getEditorView();
            if (view) {
                view.dispatch(
                    view.state.tr
                        .setMeta(foldPluginKey, { type: "setEnabled", enabled: msg.enabled } satisfies FoldMeta)
                        .setMeta("addToHistory", false),
                );
            }
        },
        fmSuggestions(msg) {
            dispatchFmSuggestions(msg.key, msg.values);
        },
        proofreadConfig(msg) {
            const view = getEditorView();
            if (view) {
                // Focus mode masks the master gate in the live config, so an
                // inbound write is the one thing that can un-silence a focused
                // document. The mask keeps the live gate and takes the incoming
                // value as what the exit restores (MAR-72).
                setProofreadConfig(view, maskProofreadConfigUnderFocus(msg.config));
            }
        },
        notesConfig(msg) {
            setNotesMarkers(msg.customMarkers);
            // The in-text highlight reads both values at scan time, so write
            // them back to the baked snapshot before re-gating — the re-gate
            // also drops the plugin's scan cache, which is keyed on doc
            // identity and would otherwise return the old marker set's
            // decorations for an unchanged document.
            if (window.__i18n) {
                window.__i18n.notesCustomMarkers = msg.customMarkers;
                window.__i18n.notesHighlightMarkers = msg.highlightMarkers;
            }
            regateNoteMarkers(getEditorView());
        },
        reviewConfig(msg) {
            setReviewGroupByType(msg.groupByType);
        },
        toolbarConfig(msg) {
            // Same seam as proofreadConfig: the echo carries `visible`, and
            // focus mode hides the toolbar without writing it.
            topbarTb?.applyConfig(maskToolbarConfigUnderFocus(msg.config));
        },
        whatsNewUnread(msg) {
            setWhatsNewUnread(msg.unread);
        },
        setFontFamily(msg) {
            // Anchored: swapping the family changes every glyph's metrics, so
            // the whole document rewraps and re-heights. Keep the top visible
            // line stable, exactly as a width flip does. This is the only apply
            // path for a preset change, wherever it came from (the menu posts
            // and waits for this echo).
            withScrollAnchor(getEditorView(), () => {
                const root = document.documentElement;
                if (msg.fontFamily) {
                    root.style.setProperty("--content-font-family", msg.fontFamily);
                } else {
                    // The "editor" preset: unset, so the CSS falls back to the
                    // VS Code editor font (--vscode-editor-font-family).
                    root.style.removeProperty("--content-font-family");
                }
            });
            topbarTb?.setFontPreset(msg.preset, msg.stacks);
        },
        setFontSize(msg) {
            const size = clampFontSizePercent(msg.size);
            // Anchored for the same reason as the family swap; the toolbar's
            // own optimistic apply anchors too, so this echo re-applies an
            // identical value and measures a zero delta.
            withScrollAnchor(getEditorView(), () => {
                document.documentElement.style.setProperty("--content-font-scale", String(size / 100));
            });
            topbarTb?.setFontSize(size);
        },
        setContentWidth(msg) {
            // Anchored: a width flip rewraps the document; keep the top
            // visible line stable. This path is also the only one that runs
            // for a flip made in Settings or another editor — and for the
            // toolbar's own echo it re-applies identical values, so the
            // anchor measures a zero delta.
            withScrollAnchor(getEditorView(), () => {
                document.documentElement.style.setProperty("--editor-max-width", msg.cssValue);
                document.body.classList.toggle("editor-width-auto", msg.isAuto);
            });
            // Pass the resolved css so the toolbar's cached fixed width tracks
            // external `maxContentWidth` changes (no stale-flash on re-toggle).
            topbarTb?.setContentWidth(msg.mode, msg.isAuto ? undefined : msg.cssValue);
        },
        setTocPosition(msg) {
            setTocPosition(msg.position);
        },
        setTocVisibility(msg) {
            // A focused editor records the echo for its exit and leaves the
            // collapsed panel alone.
            if (absorbTocVisibilityUnderFocus(msg.visibility)) { return; }
            setTocVisibility(msg.visibility);
        },
        setTocWidth(msg) {
            setTocWidth(msg.width);
        },
        lintResults(msg) {
            applyLintResults(msg.id, msg.results);
        },
        editorCommand(msg) {
            // Command palette / right-click menu action routed to this editor.
            // `args` carries a right-clicked cell target for table commands.
            // An unknown id is a safe no-op inside runEditorCommand.
            runEditorCommand(msg.command, getEditor, msg.args);
        },
        syncConflict(msg) {
            topbarTb?.setSyncConflict(msg.state === "conflict");
        },
        logseqState(msg) {
            topbarTb?.setLogseq(msg.reason);
        },
    };
}
