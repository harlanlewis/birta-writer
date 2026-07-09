/**
 * webview/index.ts
 *
 * WebView entry point: initializes and wires together the modules.
 *
 * This is the WebView's core entry file. It:
 * - initializes the Milkdown editor instance
 * - composes and initializes the UI components (toolbar, TOC, find bar, etc.)
 * - registers global event listeners (image drop, image paste, checkbox toggle)
 * - coordinates the message handlers, keyboard shortcuts, and scroll persistence
 * - manages module-level state (current editor, line map, theme overrides, etc.)
 *
 * Module layout:
 * - components/frontmatter: Frontmatter panel
 * - imageUpload: image upload management
 * - keyboardShortcuts: keyboard shortcuts
 * - messageHandlers: message dispatch
 * - scrollPersistence: scroll-position persistence
 */

import "./perfBoot"; // MUST stay first: stamps mdw:eval-start before any other module evaluates.
import "./style.css";
import {
    createEditor,
    getEditorView,
    registerSelectionChangeHandler,
    setLogTableSel,
} from "./editor";
import type { EditorView } from "@milkdown/prose/view";
import { TextSelection } from "@milkdown/prose/state";
import { t } from "./i18n";
import { notifyReady, notifyUpdate, notifySwitchToTextEditor, notifySetTocPosition, onMessage } from "./messaging";
import { mark, measure } from "./perf";
import type { ToWebviewMessage } from "../shared/messages";
import { computeLineMap } from "../shared/lineMap";
import { getTopbarBottom } from "./utils/headingUtils";

import { setupLinkPopup } from "./components/linkPopup";
import { setupPathLink } from "./components/pathLink";
import { initPathComplete } from "./components/pathLink/pathComplete";
import { initFindBar, selectionOrWordQuery } from "./components/findBar";
import { initHeadingIds } from "./headingIds";
import { initToolbar } from "./components/toolbar";
import { initToc } from "./components/toc";
import type { Editor } from "@milkdown/core";

import { renderFrontmatterPanel, focusFrontmatterPanel } from "./components/frontmatter";
import { runEditorCommand, setEditorCommandHost } from "./editorCommands";
import { setSlashMenuHost } from "./plugins";
import { initContextMenu } from "./components/contextMenu";
import {
    handleGetProjectImages,
    handleImageFile,
    insertImageNode,
} from "./imageUpload";
import { initScrollPersistence } from "./scrollPersistence";
import { initKeyboardShortcuts } from "./keyboardShortcuts";
import { createMessageHandlers, type Handler } from "./messageHandlers";
import { createEventManager } from "./eventManager";
import { observeNativeThemeChanges } from "./nativeThemeBridge";

// ── Module-level state ─────────────────────────────────────
let currentEditor: Editor | null = null;
let currentLineMap: number[] = [];

export function getLineMap(): number[] {
    return currentLineMap;
}

let markdownSource = "";
export function getMarkdownSource(): string {
    return markdownSource;
}

// ── Scroll helper functions ────────────────────────────────

/** Scroll the block for a lineMap source line (1-indexed) to the viewport center. */
function scrollToSourceLine(
    view: EditorView,
    lineMap: number[],
    targetLine: number,
): void {
    if (!lineMap.length) {
        return;
    }
    let blockIdx = 0;
    for (let i = 0; i < lineMap.length; i++) {
        if (lineMap[i] <= targetLine) {
            blockIdx = i;
        } else {
            break;
        }
    }
    const children = view.dom.children;
    if (blockIdx >= children.length) {
        return;
    }
    const el = children[blockIdx] as HTMLElement;
    if (!el) {
        return;
    }

    const blockStartLine = lineMap[blockIdx];
    const nextBlockLine =
        blockIdx + 1 < lineMap.length ? lineMap[blockIdx + 1] : undefined;
    const blockLineCount = nextBlockLine ? nextBlockLine - blockStartLine : 1;
    const lineOffsetInBlock = targetLine - blockStartLine;
    const offsetRatio =
        blockLineCount > 1 ? lineOffsetInBlock / (blockLineCount - 1) : 0;

    const elRect = el.getBoundingClientRect();
    const blockTop = elRect.top + window.scrollY;
    const blockHeight = elRect.height;
    const targetLineTop = blockTop + blockHeight * offsetRatio;
    const viewportHeight = window.innerHeight;
    const targetScrollTop = targetLineTop - viewportHeight / 2;

    window.scrollTo({ top: Math.max(0, targetScrollTop) });
}

/** Detect the source line (1-indexed) at the viewport center. */
function getFirstVisibleSourceLine(
    view: EditorView,
    lineMap: number[],
): number {
    if (!lineMap.length) {
        return 1;
    }
    const topbarH = getTopbarBottom();
    const children = view.dom.children;
    const viewportHeight = window.innerHeight;
    const viewportCenter = topbarH + (viewportHeight - topbarH) / 2;

    for (let i = 0; i < children.length && i < lineMap.length; i++) {
        const rect = (children[i] as HTMLElement).getBoundingClientRect();
        if (rect.top <= viewportCenter && rect.bottom >= viewportCenter) {
            const blockStartLine = lineMap[i] ?? 1;
            const nextBlockLine =
                i + 1 < lineMap.length ? lineMap[i + 1] : undefined;
            const blockLineCount = nextBlockLine
                ? nextBlockLine - blockStartLine
                : 1;
            const blockTop = rect.top;
            const blockHeight = rect.height;
            const offsetInBlock = viewportCenter - blockTop;
            const offsetRatio =
                blockHeight > 0 ? offsetInBlock / blockHeight : 0;
            const lineOffset = Math.round(offsetRatio * (blockLineCount - 1));
            return blockStartLine + lineOffset;
        }
    }

    let closestIdx = 0;
    let closestDistance = Infinity;
    for (let i = 0; i < children.length && i < lineMap.length; i++) {
        const rect = (children[i] as HTMLElement).getBoundingClientRect();
        const blockCenter = rect.top + rect.height / 2;
        const distance = Math.abs(blockCenter - viewportCenter);
        if (distance < closestDistance) {
            closestDistance = distance;
            closestIdx = i;
        }
    }
    return lineMap[closestIdx] ?? 1;
}

// ── Retry scroll ───────────────────────────────────────────
function retryScroll(fn: () => void): void {
    let done = false;
    const tryFn = () => {
        if (done) return;
        const view = getEditorView();
        if (!view) return;
        const firstChild = view.dom.children[0] as HTMLElement | undefined;
        if (!firstChild || firstChild.getBoundingClientRect().height === 0)
            return;
        fn();
        done = true;
    };
    for (const delay of [300, 600, 1100, 2000]) {
        setTimeout(tryFn, delay);
    }
}

// ── Editor initialization ──────────────────────────────────
async function initEditor(
    container: HTMLElement,
    markdown: string,
): Promise<void> {
    if (currentEditor) {
        currentEditor.destroy();
        currentEditor = null;
        container.innerHTML = "";
    }

    currentEditor = await createEditor(
        container,
        markdown,
        (updated) => {
            // Keep the cached source (and its line map) in sync with every
            // edit so source-based search stays accurate; the extension later
            // echoes an authoritative lineMapUpdate after saving (MAR-8).
            markdownSource = updated;
            currentLineMap = computeLineMap(updated);
            notifyUpdate(updated);
            toc.refresh();
        },
    );
    toc.refresh();
    // First frame with rendered content on screen: wait two RAFs so the mark
    // lands after the browser has actually painted the mounted ProseMirror doc.
    requestAnimationFrame(() =>
        requestAnimationFrame(() => {
            mark("editor-painted");
            measure("launch", undefined, "editor-painted");
        }),
    );
}

// ── Initialize the event manager ───────────────────────────
const eventManager = createEventManager();

// ── UI component initialization ────────────────────────────
mark("toc-start");
const toc = initToc(eventManager, () => getEditorView());
document.body.appendChild(toc.panel);
mark("toc-end");
measure("initToc", "toc-start", "toc-end");

const findBar = initFindBar(() => getEditorView(), getMarkdownSource, eventManager);

const topbar = document.querySelector<HTMLElement>(".editor-topbar");
// "Edit Raw Markdown" (toolbar button AND right-click menu): same switch path
// as Cmd+Shift+M, carrying the first visible source line to preserve the
// viewport.
const switchToSource = (): void => {
    const view = getEditorView();
    const line = view
        ? getFirstVisibleSourceLine(view, getLineMap())
        : undefined;
    notifySwitchToTextEditor(line);
};
mark("toolbar-start");
const topbarTb = topbar
    ? initToolbar(
        topbar,
        () => currentEditor,
        { getLineMap, getMarkdownSource },
        async (file: File, altText: string) => handleImageFile(file, altText),
        async (id: string) => handleGetProjectImages(id),
        () => findBar.open(),
        switchToSource,
    )
    : null;
mark("toolbar-end");
measure("initToolbar", "toolbar-start", "toolbar-end");

// Register the editor-command hooks the toolbar does not own (find-with-
// replace, find navigation, TOC toggle, frontmatter focus). The toolbar
// itself registers openLinkPrompt / openImagePanel / openFind (MAR-9).
// The find-navigation hooks back the contributed (user-rebindable)
// keybindings: Cmd+G / F3, Cmd+Shift+G / Shift+F3, and Cmd/Ctrl+D.
setEditorCommandHost({
    openFindReplace: () => findBar.open(undefined, { showReplace: true }),
    findNext: () => findBar.findNext(),
    findPrevious: () => findBar.findPrev(),
    findSelection: () => {
        const view = getEditorView();
        findBar.open(view ? selectionOrWordQuery(view) : undefined, {
            showReplace: true,
            focusReplace: true,
        });
    },
    toggleToc: () => toc.toggle(),
    // Side-switch: flip to the opposite edge, mirroring the panel's own flip
    // button (optimistic apply + persist the tocPosition setting).
    swapTocSide: () => {
        const next = toc.isRight() ? "left" : "right";
        toc.setPosition(next);
        notifySetTocPosition(next);
    },
    editFrontmatter: () => focusFrontmatterPanel(),
    editRawMarkdown: switchToSource,
});

// The slash menu executes every pick through the same editor-command registry
// the toolbar and command palette use, so each row behaves identically on all
// three surfaces (font/proofread/TOC included — they are now real commands).
// getState feeds the dynamic labels of the toggle rows (a fresh snapshot is
// read each time the menu opens).
setSlashMenuHost({
    runCommand: (id, args) => runEditorCommand(id, () => currentEditor, args),
    getState: () => ({
        tocOpen: toc.isOpen(),
        tocRight: toc.isRight(),
        toolbarVisible: topbarTb?.isVisible() ?? false,
    }),
});

if (topbar) {
    const updateTopbarHeight = () => {
        document.documentElement.style.setProperty(
            "--editor-topbar-height",
            `${topbar.getBoundingClientRect().height || 40}px`,
        );
    };
    updateTopbarHeight();
    new ResizeObserver(updateTopbarHeight).observe(topbar);
}

// ── Editor container event bindings ────────────────────────
const editorContainer = document.getElementById("editor");
if (editorContainer) {
    initContextMenu(editorContainer, () => getEditorView(), topbar);
    setupLinkPopup(editorContainer, () => getEditorView());
    setupPathLink(editorContainer);
    initHeadingIds(editorContainer);
    initPathComplete(() => getEditorView());
    // Table row/column affordances (grips, insert bars, drag-reorder) now live
    // inside the table NodeView overlay — see components/table/tableView.ts.

    // Click the empty area below the content -> move the caret to the document end
    eventManager.onElement(editorContainer, "mousedown", (e) => {
        const view = getEditorView();
        if (!view) {
            return;
        }
        if (view.dom.contains(e.target as Node)) {
            return;
        }
        const lastChild = view.dom.lastElementChild;
        if (!lastChild) {
            return;
        }
        const lastRect = lastChild.getBoundingClientRect();
        if (e.clientY <= lastRect.bottom) {
            return;
        }
        e.preventDefault();
        const { state } = view;
        const sel = TextSelection.atEnd(state.doc);
        view.dispatch(state.tr.setSelection(sel));
        view.focus();
    });

    // Drag-and-drop images
    eventManager.onElement(editorContainer, "dragover", (e) => {
        const items = e.dataTransfer?.items;
        if (
            items &&
            Array.from(items).some(
                (i) => i.kind === "file" && i.type.startsWith("image/"),
            )
        ) {
            e.preventDefault();
            e.stopPropagation();
        }
    });

    eventManager.onElement(editorContainer, "drop", (e) => {
        const files = e.dataTransfer?.files;
        if (!files?.length) {
            return;
        }
        const imageFile = Array.from(files).find((f) =>
            f.type.startsWith("image/"),
        );
        if (!imageFile) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        handleImageFile(imageFile, "")
            .then((url) => insertImageNode(currentEditor, url, ""))
            .catch((err: Error) =>
                console.error("[ImageUpload] drop failed:", err),
            );
    });
}

// Paste images
eventManager.onDocument("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) {
        return;
    }
    const imageItem = Array.from(items).find((i) =>
        i.type.startsWith("image/"),
    );
    if (!imageItem) {
        return;
    }
    const file = imageItem.getAsFile();
    if (!file) {
        return;
    }
    e.preventDefault();
    handleImageFile(file, "")
        .then((url) => insertImageNode(currentEditor, url, ""))
        .catch((err: Error) =>
            console.error("[ImageUpload] paste failed:", err),
        );
});

// The floating selection/table popovers were removed: text formatting lives on
// the top toolbar + keyboard, and table structure editing lives in the
// right-click menu + hover affordances. The main toolbar still tracks selection
// to update its active-state.
registerSelectionChangeHandler((view) => {
    topbarTb?.onSelectionChange(view);
});

// Checkbox toggle
eventManager.onDocument(
    "click",
    (e) => {
        const target = e.target as Element;
        const taskItem = target.closest(
            'li[data-item-type="task"]',
        ) as HTMLElement | null;
        if (!taskItem) {
            return;
        }
        const rect = taskItem.getBoundingClientRect();
        if ((e as MouseEvent).clientX - rect.left > 24) {
            return;
        }
        const view = getEditorView();
        if (!view) {
            return;
        }
        let domPos: number;
        try {
            domPos = view.posAtDOM(taskItem, 0);
        } catch {
            return;
        }
        const { state } = view;
        const $pos = state.doc.resolve(
            Math.min(domPos, state.doc.content.size),
        );
        for (let d = $pos.depth; d >= 0; d--) {
            const node = $pos.node(d);
            if (
                node.type.name === "task_list_item" ||
                node.type.name === "list_item"
            ) {
                const nodePos = $pos.before(d);
                const checked = node.attrs.checked as boolean;
                view.dispatch(
                    state.tr.setNodeMarkup(nodePos, null, {
                        ...node.attrs,
                        checked: !checked,
                    }),
                );
                return;
            }
        }
    },
    true,
);

// ── Initialize keyboard shortcuts and scroll persistence ───
// Workbench key-leak guard only: every rebindable editor shortcut (find
// family, insert link, switch to text editor) is a contributed keybinding
// in package.json routed back here through the editorCommand message.
initKeyboardShortcuts(eventManager);
initScrollPersistence(eventManager);

// ── Message handlers ───────────────────────────────────────
const handlers = createMessageHandlers({
    state: {
        getEditor: () => currentEditor,
        setEditor: (editor) => {
            currentEditor = editor;
        },
        getLineMap,
        setLineMap: (lineMap) => {
            currentLineMap = lineMap;
        },
        getMarkdownSource,
        setMarkdownSource: (source) => {
            markdownSource = source;
        },
    },
    actions: {
        scrollToSourceLine,
        getFirstVisibleSourceLine,
        initEditor,
        retryScroll,
        getEditorView,
        refreshToc: () => toc.refresh(),
        setTocPosition: (position) => toc.setPosition(position),
    },
    topbarTb,
});

onMessage(async (msg) => {
    const container = document.getElementById("editor");
    if (!container) {
        return;
    }
    const handler = handlers[msg.type as ToWebviewMessage["type"]];
    if (handler) {
        // Type-safe call: msg is already a ToWebviewMessage and the handler accepts the matching type
        await (handler as Handler)(msg, container);
    }
});

// VS Code drives colors via its native --vscode-* variables; bridge its live
// theme-class swaps to the "theme-changed" event so JS-driven consumers
// (Mermaid, etc.) refresh on every theme change, including OS light/dark
// switching that never reaches the extension host.
observeNativeThemeChanges();

// WebView finished loading.
mark("ready-posted");
measure("eager-boot", "eval-start", "ready-posted");
notifyReady();
