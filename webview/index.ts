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
import { notifyReady, notifyUpdate, notifySwitchToTextEditor, notifySetTocPosition, notifyFocusState, onMessage } from "./messaging";
import { mark, measure } from "./perf";
import type { ToWebviewMessage } from "../shared/messages";
import { computeLineMap } from "../shared/lineMap";
import { getTopbarBottom } from "./utils/headingUtils";
import { isTaskCheckboxClick } from "./utils/taskCheckbox";

import { setupLinkPopup, closeLinkEditor } from "./components/linkPopup";
import { setupPathLink } from "./components/pathLink";
import { initPathComplete } from "./components/pathLink/pathComplete";
import { initFindBar } from "./components/findBar";
import { initHeadingIds } from "./headingIds";
import { initToolbar } from "./components/toolbar";
import { setupSelectionToolbar } from "./components/selectionToolbar";
import { initToc } from "./components/toc";
import type { Editor } from "@milkdown/core";

import { renderFrontmatterPanel, focusFrontmatterPanel } from "./components/frontmatter";
import { runEditorCommand, setEditorCommandHost } from "./editorCommands";
import { setBlockMenuContext } from "./components/blockMenu";
import { openShortcutsHelp } from "./components/shortcutsHelp";
import { setSlashMenuHost } from "./plugins";
import { revealPosition } from "./plugins/headingFold";
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
import { syncMermaidCanvasClass } from "./components/codeBlock";

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
    // Goto-symbol / scroll-to-line is an explicit entry intent: a target
    // hidden inside a folded range unfolds it first (VS Code semantics) —
    // a display:none block would otherwise measure at y=0.
    if (blockIdx < view.state.doc.childCount) {
        let blockPos = 0;
        for (let i = 0; i < blockIdx; i++) {
            blockPos += view.state.doc.child(i).nodeSize;
        }
        revealPosition(view, blockPos);
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

// Floating selection palette (birta.floatingToolbar): a formatting bar above a
// text selection, and move/duplicate/delete above a whole-block (multi-block)
// selection. Gated on the master setting; per-item button visibility comes from
// the items map. Reuses the top toolbar's openLinkPrompt so both surfaces drive
// the single link-popup editor rather than stacking two.
const selectionTb = (window.__i18n?.floatingToolbar?.enabled ?? true)
    ? setupSelectionToolbar(
        getEditorView,
        () => currentEditor,
        () => topbarTb?.openLinkPrompt(),
        window.__i18n?.floatingToolbar?.items,
    )
    : null;

// Register the editor-command hooks the toolbar does not own (find-with-
// replace, find navigation, TOC toggle, frontmatter focus). The toolbar
// itself registers openLinkPrompt / openImagePanel / openFind (MAR-9).
// The find-navigation hooks back the contributed (user-rebindable)
// keybindings: Cmd+G / F3, Cmd+Shift+G / Shift+F3, and Cmd/Ctrl+D.
// The gutter block menu needs the Editor (commands + markdown serializer),
// not just the view its widget receives.
setBlockMenuContext({ getEditor: () => currentEditor });

setEditorCommandHost({
    openFindReplace: () => findBar.open(undefined, { showReplace: true }),
    findNext: () => findBar.findNext(),
    findPrevious: () => findBar.findPrev(),
    // Cmd+D: cycle the document selection through occurrences of the word/
    // selection (the bar handles seed-vs-advance internally).
    findSelection: () => findBar.cycleOccurrence(),
    // Shift+Cmd+L: highlight every occurrence, focused on the replace input.
    selectAllOccurrences: () => findBar.selectAllOccurrences(),
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
    // Shortcuts-help cheatsheet overlay (scaffold: no-op until it lands).
    openShortcutsHelp: () => openShortcutsHelp(),
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

// Selection drives two surfaces: the top toolbar tracks it to update its
// active-state, and (when birta.floatingToolbar.enabled) the floating palette
// shows/positions itself above the selection. Both are fed the same view.
registerSelectionChangeHandler((view) => {
    topbarTb?.onSelectionChange(view);
    selectionTb?.onSelectionChange(view);
});

// Focus can leave ProseMirror for a nested editable island — a callout/directive
// title (its own contenteditable whose events ProseMirror never sees via
// stopEvent), or a chrome input like the image caption. The PM selection freezes
// on the block the caret last sat in, so without this the bar would keep
// asserting that stale block (e.g. "P" while you type a callout title); blank it
// instead. Returning to PM fires a real selection change that restores the true
// state.
eventManager.onDocument(
    "focusin",
    (e) => {
        const target = e.target as Element | null;
        // Opening the block (handle) menu is a shift from inline/substring intent
        // to block-level intent, so clear the inline chrome (the formatting
        // palette AND the link editor) rather than stacking the menu over them.
        // The menu focuses its "Search actions…" input on open, so this fires for
        // both mouse and keyboard opens.
        if (target?.closest(".block-menu")) {
            selectionTb?.hide();
            closeLinkEditor();
            return;
        }
        // Focus entering the shared link editor hands editing off to it, so
        // dismiss the floating selection palette — otherwise the palette (above
        // the selection) and the popup (below it) sandwich the range with two
        // chromes. This is the single choke point every link surface routes
        // through (the palette's Link button, ⌘K, the slash menu, and pasting a
        // URL over a selection), so one hide covers them all.
        if (target?.closest(".lp-root")) {
            selectionTb?.hide();
            return;
        }
        const pm = target?.closest(".ProseMirror");
        if (!pm) {
            return; // focus went outside the editor entirely — leave the bar as-is
        }
        if (target?.matches("input, textarea")) {
            topbarTb?.setDetached();
            return;
        }
        const editable = target?.closest<HTMLElement>("[contenteditable]");
        if (editable && editable !== pm) {
            topbarTb?.setDetached();
        }
    },
    true,
);

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
        // Only a click on the checkbox itself toggles completion. In
        // particular, a click on the block handle (gutter chrome, out in the
        // left margin) must never mutate block content — the handle's own click
        // handler runs in the bubble phase and can't stop us here (this
        // listener is capture phase), so the exclusion lives in the hit-test.
        if (!isTaskCheckboxClick(target, taskItem, (e as MouseEvent).clientX)) {
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

// Report webview focus to the extension so it can gate document-mutating
// keybindings on real editor focus (MAR-104). We track the iframe window, not
// the ProseMirror editor: focus parked on toolbar chrome still counts, but
// focus leaving the webview for the Explorer/sidebar does not. Emit the current
// state up front in case the webview loads already focused (VS Code focuses the
// custom editor on activation, which may precede our listener).
eventManager.onWindow("focus", () => notifyFocusState(true));
eventManager.onWindow("blur", () => notifyFocusState(false));
notifyFocusState(document.hasFocus());

// Set the Mermaid canvas class up front (from the injected mode + current
// background) so the first diagram paints on the right surface, with no flash.
syncMermaidCanvasClass();

// WebView finished loading.
mark("ready-posted");
measure("eager-boot", "eval-start", "ready-posted");
notifyReady();
