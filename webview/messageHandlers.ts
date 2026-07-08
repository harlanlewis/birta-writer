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
import type { EditorView } from "@milkdown/prose/view";
import type { ToWebviewMessage, TableWrapMode } from "../shared/messages";
import { clampFontSizePercent } from "../shared/fontPresets";
import { setImageUriMap } from "./components/imageView";
import { dispatchPathSuggestions } from "./components/pathLink/pathComplete";
import { dispatchLinkTargetSuggestions, dispatchLinkTargetResolved } from "./components/pathLink/linkTargetComplete";
import { dispatchImgPathSuggestions, dispatchImagePathResolved } from "./components/imageView/imgPathComplete";
import { setLogTableSel, syncExternalContent } from "./editor";
import { setProofreadConfig } from "./plugins";
import { applyLintResults } from "./plugins/proofread";
import { notifySwitchToTextEditor, getWebviewState, setBaseSyncVersion } from "./messaging";
import { renderFrontmatterPanel } from "./components/frontmatter";
import { dispatchFmSuggestions } from "./components/frontmatter/suggestMenu";
import { runEditorCommand } from "./editorCommands";
import {
    handleImageUploaded,
    handleImageUploadError,
    handleProjectImagesList,
} from "./imageUpload";

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
    setDebugMode(enabled: boolean): void;
    /** Rebuild the toolbar for a changed per-item placement config. */
    applyConfig(config: import("../shared/messages").ToolbarConfig): void;
    /** Update the font picker's active-preset indicator (and, when provided, its per-preset stack previews). */
    setFontPreset(preset: import("../shared/messages").FontPreset, stacks?: import("../shared/messages").FontStacks): void;
    /** Update the font picker's size-stepper display (percent). */
    setFontSize(size: number): void;
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
}

/** Message-handler dependencies. */
export interface MessageHandlerDeps {
    state: EditorStateAccessor;
    actions: EditorActions;
    topbarTb: ToolbarController | null;
    themeOverrides: Set<string>;
}

// ── Message-handler factory ────────────────────────────────

/** Create the message handlers. */
export function createMessageHandlers(
    deps: MessageHandlerDeps,
): { [K in ToWebviewMessage["type"]]?: Handler<K> } {
    const { state, actions, topbarTb, themeOverrides } = deps;
    const { getEditor, setEditor, getLineMap, setLineMap, getMarkdownSource, setMarkdownSource } = state;
    const { scrollToSourceLine, getFirstVisibleSourceLine, initEditor, retryScroll, getEditorView, refreshToc, setTocPosition } = actions;

    return {
        async init(msg, container) {
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
        setTheme(msg) {
            const root = document.documentElement;
            for (const prop of themeOverrides) {
                root.style.removeProperty(prop);
            }
            themeOverrides.clear();
            for (const [key, value] of Object.entries(msg.colors)) {
                if (value) {
                    root.style.setProperty(key, value);
                    themeOverrides.add(key);
                }
            }
            window.dispatchEvent(new CustomEvent("theme-changed"));
        },
        setTableWrap(msg) {
            applyTableWrap(msg.wrap);
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
        setTocPosition(msg) {
            setTocPosition(msg.position);
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
    };
}
