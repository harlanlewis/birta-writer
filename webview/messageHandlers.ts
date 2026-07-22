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
import { applyBlockHandles } from "./utils/blockHandles";
import { setMermaidThemeMode } from "./components/codeBlock";
import { applyFoldingControls } from "./utils/foldingControls";
import { foldPluginKey, type FoldMeta } from "./plugins/foldState";
import { setImageUriMap } from "./components/imageView";
import { dispatchPathSuggestions } from "./components/pathLink/pathComplete";
import { dispatchLinkTargetSuggestions, dispatchLinkTargetResolved } from "./components/pathLink/linkTargetComplete";
import { dispatchImgPathSuggestions, dispatchImagePathResolved } from "./components/imageView/imgPathComplete";
import { setLogTableSel, syncExternalContent, flushPendingEdit } from "./editor";
import { setProofreadConfig } from "./plugins";
import { mark } from "./perf";
import { applyLintResults } from "./plugins/proofread";
import { notifySwitchToTextEditor, getWebviewState, setBaseSyncVersion, notifyFlushResult, notifyPerfMarks } from "./messaging";
import { renderFrontmatterPanel } from "./components/frontmatter";
import { dispatchFmSuggestions } from "./components/frontmatter/suggestMenu";
import { runEditorCommand } from "./editorCommands";
import {
    handleImageUploaded,
    handleImageUploadError,
    handleProjectImagesList,
} from "./imageUpload";
import { handleUnfurlResult } from "./unfurl";
import { regateEmbeds } from "./plugins/embed";

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
}

/** Editor state-management interface. */
export interface EditorStateAccessor {
    getEditor: () => Editor | null;
    setEditor: (editor: Editor | null) => void;
    getLineMap: () => number[];
    setLineMap: (lineMap: number[]) => void;
    getMarkdownSource: () => string;
    setMarkdownSource: (source: string) => void;
}

/** Editor actions interface. */
export interface EditorActions {
    scrollToSourceLine: (view: EditorView, lineMap: number[], targetLine: number) => void;
    getFirstVisibleSourceLine: (view: EditorView, lineMap: number[]) => number;
    initEditor: (container: HTMLElement, markdown: string) => Promise<void>;
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
    const { getEditor, setEditor, getLineMap, setLineMap, getMarkdownSource, setMarkdownSource } = state;
    const { scrollToSourceLine, getFirstVisibleSourceLine, initEditor, retryScroll, getEditorView, refreshToc, setTocPosition, setTocVisibility, setTocWidth, setNotesMarkers, setReviewGroupByType } = actions;

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
            setBaseSyncVersion(msg.syncVersion);
            setMarkdownSource(msg.content);
            setLineMap(msg.lineMap ?? []);
            renderFrontmatterPanel(msg.frontmatter);
            if (msg.imageUriMap) {
                setImageUriMap(msg.imageUriMap);
            }
            if (msg.tableWrap) {
                applyTableWrap(msg.tableWrap);
            }
            await initEditor(container, msg.content);
            window.focus();
            if (msg.scrollToLine) {
                retryScroll(() =>
                    scrollToSourceLine(
                        getEditorView()!,
                        getLineMap(),
                        msg.scrollToLine!,
                    ),
                );
            } else {
                const saved = getWebviewState();
                if (saved?.scrollY) {
                    retryScroll(() =>
                        window.scrollTo({ top: saved.scrollY as number }),
                    );
                }
            }
        },
        async revert(msg, container) {
            setMarkdownSource(msg.content);
            setLineMap(msg.lineMap ?? []);
            renderFrontmatterPanel(msg.frontmatter);
            if (msg.imageUriMap) {
                setImageUriMap(msg.imageUriMap);
            }
            if (msg.tableWrap) {
                applyTableWrap(msg.tableWrap);
            }
            await initEditor(container, msg.content);
        },
        async externalUpdate(msg, container) {
            // Record the version we're syncing to so subsequent outbound edits
            // carry it as baseSyncVersion (stale-update rejection on the
            // extension side).
            setBaseSyncVersion(msg.syncVersion);
            setMarkdownSource(msg.content);
            setLineMap(msg.lineMap ?? []);
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
            const view = getEditorView();
            const lineMap = getLineMap();
            const line = view ? getFirstVisibleSourceLine(view, lineMap) : undefined;
            notifySwitchToTextEditor(line);
        },
        scrollToLine(msg) {
            const lineMap = getLineMap();
            const scrollLine = msg.line;
            let scrollAttempts = 0;
            const tryScrollNow = () => {
                const view = getEditorView();
                if (view) {
                    scrollToSourceLine(view, lineMap, scrollLine);
                } else if (scrollAttempts < 8) {
                    scrollAttempts++;
                    setTimeout(tryScrollNow, 250);
                }
            };
            tryScrollNow();
        },
        lineMapUpdate(msg) {
            setLineMap(msg.lineMap);
        },
        flushSave(msg) {
            // A save is imminent: serialize the live document NOW (bypassing the
            // throttle) and reply so the extension writes the freshest content.
            notifyFlushResult(msg.id, flushPendingEdit());
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
        imagePathResolved(msg) {
            dispatchImagePathResolved(msg.id, msg.webviewUri);
        },
        unfurlResult(msg) {
            // Paste-unfurl reply: upgrade the bare `[url](url)` to `[title](url)`
            // in the live doc (or keep the bare link when title is null).
            handleUnfurlResult(getEditorView(), msg.id, msg.title);
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
        featureGateChanged(msg) {
            // Read-at-use-time gates: flipping the __i18n field is the whole
            // update (calc's advisory/auto split, the checklist sink, the
            // unfurl feature key all read it per event, not per composition).
            if (window.__i18n) {
                window.__i18n[msg.gate] = msg.enabled;
            }
            if (msg.gate === "embedsEnabled") {
                regateEmbedsIfPossible();
            }
        },
        setBlockHandles(msg) {
            applyBlockHandles(msg.mode);
            topbarTb?.setBlockHandles(msg.mode);
        },
        setMermaidTheme(msg) {
            setMermaidThemeMode(msg.mode);
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
                setProofreadConfig(view, msg.config);
            }
        },
        notesConfig(msg) {
            setNotesMarkers(msg.customMarkers);
        },
        reviewConfig(msg) {
            setReviewGroupByType(msg.groupByType);
        },
        toolbarConfig(msg) {
            topbarTb?.applyConfig(msg.config);
        },
        setFontFamily(msg) {
            const root = document.documentElement;
            if (msg.fontFamily) {
                root.style.setProperty("--content-font-family", msg.fontFamily);
            } else {
                // The "editor" preset: unset, so the CSS falls back to the
                // VS Code editor font (--vscode-editor-font-family).
                root.style.removeProperty("--content-font-family");
            }
            topbarTb?.setFontPreset(msg.preset, msg.stacks);
        },
        setFontSize(msg) {
            const size = clampFontSizePercent(msg.size);
            document.documentElement.style.setProperty("--content-font-scale", String(size / 100));
            topbarTb?.setFontSize(size);
        },
        setContentWidth(msg) {
            document.documentElement.style.setProperty("--editor-max-width", msg.cssValue);
            document.body.classList.toggle("editor-width-auto", msg.isAuto);
            // Pass the resolved css so the toolbar's cached fixed width tracks
            // external `maxContentWidth` changes (no stale-flash on re-toggle).
            topbarTb?.setContentWidth(msg.mode, msg.isAuto ? undefined : msg.cssValue);
        },
        setTocPosition(msg) {
            setTocPosition(msg.position);
        },
        setTocVisibility(msg) {
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
    };
}
