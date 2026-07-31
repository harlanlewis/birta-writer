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
// chrome.css MUST come first: it is the base layer (tokens + primitives), and
// every surface rule — style.css included — overrides it on specificity ties.
import "./ui/chrome.css"; // shared ui-* chrome tokens (radius/spacing/type) + button/menu primitives
import "./ui/typography.css"; // shared ui-* chrome type scale (menus, panels, sidebars)
import "./style.css";
import "./ui/suggestList.css"; // suggest-dropdown surface deltas (must follow style.css, which owns the .fm-suggest-* base)
import { installCrashReporter } from "./crashReporter";

// Crash boundary (MAR-169): install before any component initializes, so an
// uncaught error / unhandled rejection anywhere below reaches the extension
// as a structured crash report instead of dying silently in the iframe.
installCrashReporter();
import {
    createEditor,
    getEditorView,
    registerSelectionChangeHandler,
    setLogTableSel,
} from "./editor";
import type { EditorView } from "./pm";
import { GapCursor, isGapCursorPosition, TextSelection } from "./pm";
import { t } from "./i18n";
import { notifyReady, notifyUpdate, notifySwitchToTextEditor, notifySetTocPosition, notifyFocusState, onMessage } from "./messaging";
import { mark, measure } from "./perf";
import type { ToWebviewMessage } from "../shared/messages";
import { computeLineMap } from "../shared/lineMap";
import { getTopbarBottom } from "./utils/headingUtils";
import {
    sourceCaretAt,
    docPosForSourceCaret,
    blockIndexForSourceLine,
    sourceLineForBlock,
    sourceSelectionEnds,
    sourceColumnForTextOffset,
} from "./utils/sourceCaret";
import { buildSelectionContext } from "./agentContext";
import type { EditorSelectionContext } from "../shared/agentContext";
import { isTaskCheckboxClick } from "./utils/taskCheckbox";
import { applyTaskToggle } from "./editing/checklistSink";

import { setupLinkPopup, closeLinkEditor } from "./components/linkPopup";
import { setupPathLink } from "./components/pathLink";
import { initPathComplete } from "./components/pathLink/pathComplete";
import { initFindBar } from "./components/findBar";
import { createLineNumbersGate } from "./utils/lineNumbersLoader";
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
import { initImageFileDrop } from "./editing/fileDrop";
import {
    handleGetProjectImages,
    handleImageFile,
} from "./imageUpload";
import { initScrollPersistence, rememberScrollNow } from "./scrollPersistence";
import { initPaneWidthVar } from "./blockWidth";
import { initKeyboardShortcuts } from "./keyboardShortcuts";
import { createMessageHandlers, type Handler } from "./messageHandlers";
import { reportWordCount } from "./wordCountReporter";
import { createEventManager } from "./eventManager";
import { observeNativeThemeChanges } from "./nativeThemeBridge";
import { syncMermaidCanvasClass } from "./components/codeBlock";

// ── Module-level state ─────────────────────────────────────
let currentEditor: Editor | null = null;
let currentLineMap: number[] = [];
// Source lines the frontmatter occupies. The line map (and everything derived
// from it) describes the BODY we render; every line on the wire is a document
// line, so this offset converts between them — see ToWebviewMessage's header.
let currentLineOffset = 0;

export function getLineMap(): number[] {
    return currentLineMap;
}

let markdownSource = "";
export function getMarkdownSource(): string {
    return markdownSource;
}

// ── Scroll helper functions ────────────────────────────────

/**
 * Scroll the block for a lineMap source line (1-indexed) to the viewport
 * center. Returns whether it actually moved the view — a caller that persists
 * the new position must not record one for a reveal that never happened.
 */
function scrollToSourceLine(
    view: EditorView,
    lineMap: number[],
    targetLine: number,
): boolean {
    if (!lineMap.length) {
        return false;
    }
    // Same reconciliation the caret uses, so the two can never disagree about
    // which block a line is in (see utils/sourceCaret.ts).
    const block = blockIndexForSourceLine(
        view.state.doc,
        lineMap,
        getMarkdownSource().split("\n"),
        targetLine,
    );
    if (!block) {
        return false;
    }
    const blockIdx = block.index;
    const children = view.dom.children;
    if (blockIdx >= children.length) {
        return false;
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
        return false;
    }

    // The intra-block offset is read off the SOURCE side (which line of the
    // block was asked for), so it follows the reconciled start line rather than
    // this block's nominal entry.
    const blockStartLine = block.blockLine;
    const nextBlockLine = lineMap.find((l) => l > blockStartLine);
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
    return true;
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

    const sourceLines = getMarkdownSource().split("\n");
    for (let i = 0; i < children.length && i < lineMap.length; i++) {
        const rect = (children[i] as HTMLElement).getBoundingClientRect();
        if (rect.top <= viewportCenter && rect.bottom >= viewportCenter) {
            // Reconciled, like every other line the two sides exchange.
            const blockStartLine =
                sourceLineForBlock(view.state.doc, lineMap, sourceLines, i) ?? 1;
            const nextBlockLine = lineMap.find((l) => l > blockStartLine);
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
    return sourceLineForBlock(view.state.doc, lineMap, sourceLines, closestIdx) ?? 1;
}

// ── Caret handoff across a mode switch (MAR-23) ────────────
//
// Both directions of Cmd+Shift+M speak DOCUMENT lines (what the raw editor
// shows); `currentLineOffset` converts those to the body lines `lineMap`
// describes. Column fidelity is decided in utils/sourceCaret.ts.

/** Body line (1-indexed) for a document line, or 0 when it precedes the body. */
function toBodyLine(documentLine: number): number {
    return documentLine - currentLineOffset;
}

/** Focus the editor unless the user is typing in the chrome (find bar, metadata panel). */
function focusEditorIfIdle(view: EditorView): void {
    const active = document.activeElement;
    if (active && active !== document.body && !view.dom.contains(active)) {
        return;
    }
    view.focus();
}

/**
 * Put the caret at a document line/column — or restore a whole selection when
 * `anchor` carries the other end (a raw-editor selection surviving the mode
 * switch). Needs the document only — no layout — so it can run before the
 * first paint has settled.
 */
function placeCaretAtLine(
    documentLine: number,
    column?: number,
    anchor?: { line: number; column?: number },
): void {
    const view = getEditorView();
    const bodyLine = toBodyLine(documentLine);
    if (!view || bodyLine < 1) { return; }
    const sourceLines = getMarkdownSource().split("\n");
    const headPos = docPosForSourceCaret(
        view.state.doc,
        currentLineMap,
        sourceLines,
        { line: bodyLine, column: column ?? 0 },
    );
    if (headPos === undefined) { return; }
    const { doc, tr } = view.state;
    const clampPos = (p: number): number => Math.min(Math.max(p, 0), doc.content.size);
    const $head = doc.resolve(clampPos(headPos));
    const anchorBody = anchor ? toBodyLine(anchor.line) : 0;
    const anchorPos = anchor && anchorBody >= 1
        ? docPosForSourceCaret(doc, currentLineMap, sourceLines, { line: anchorBody, column: anchor.column ?? 0 })
        : undefined;
    // Selection-only: no doc change, so this never dirties the document or
    // enters the sync pipeline. `near`/`between` snap to valid text positions;
    // `between` keeps the anchor→head drag direction.
    const selection = anchorPos !== undefined
        ? TextSelection.between(doc.resolve(clampPos(anchorPos)), $head)
        : TextSelection.near($head);
    view.dispatch(tr.setSelection(selection));
    focusEditorIfIdle(view);
}

/**
 * The live selection context for a coding-agent bridge pull (src/agentBridge/),
 * or null when no editor exists / the position can't be mapped. Called only on
 * an agent's request — never on the editor's own selection path.
 */
function getSelectionContext(): EditorSelectionContext | null {
    const view = getEditorView();
    if (!view) { return null; }
    return buildSelectionContext(view, currentLineMap, getMarkdownSource().split("\n"), currentLineOffset);
}

/**
 * The source position a switch to the raw editor should carry.
 *
 * A selection is the user's explicit statement of what matters, so it is
 * carried whole — both ends, in drag order — even when scrolled off screen. A
 * selection whose ends sit on depth-0 boundaries (a block-range, node, or
 * select-all) covers whole blocks, so it maps to whole source lines; mapping
 * its trailing boundary as a caret would land in the NEXT block and
 * over-select.
 *
 * A bare caret wins only while it is on screen — that is where the user is
 * working, and it is the only reading that can carry a column. Once they have
 * scrolled away from it, "take me to what I am looking at" is the honest
 * answer instead.
 */
/**
 * A switch target read from the DOM selection when it sits in read-only
 * preview chrome INSIDE the editor — the calc ledger, a rendered diagram or
 * formula, a NodeView's title bar. Those surfaces deliberately keep
 * ProseMirror's own selection parked elsewhere (and stale), so the DOM
 * selection is the only honest record of where the user is. The calc ledger
 * maps precisely — its rows mirror the fence's interior source lines
 * one-to-one and a row's source cell IS the source line — and any other
 * chrome maps to its block's first line. Returns BODY lines (no frontmatter
 * offset).
 */
function domChromeTarget(
    view: EditorView,
    sourceLines: string[],
): { line: number; column?: number; anchorLine?: number; anchorColumn?: number } | undefined {
    const sel = document.getSelection();
    if (!sel || !sel.anchorNode) { return undefined; }
    const toElement = (n: globalThis.Node | null): Element | null =>
        n instanceof Element ? n : n?.parentElement ?? null;
    const anchorEl = toElement(sel.anchorNode);
    if (!anchorEl || !view.dom.contains(anchorEl)) { return undefined; }
    const chrome = anchorEl.closest('[contenteditable="false"]');
    if (!chrome || !view.dom.contains(chrome)) { return undefined; }
    // The top-level block element owning the chrome → its block index.
    let el: Element = chrome;
    while (el.parentElement && el.parentElement !== view.dom) { el = el.parentElement; }
    const index = Array.prototype.indexOf.call(view.dom.children, el);
    if (index < 0 || index >= view.state.doc.childCount) { return undefined; }
    const blockLine = sourceLineForBlock(view.state.doc, currentLineMap, sourceLines, index);
    if (blockLine === undefined) { return undefined; }
    // Calc ledger: row index = interior line offset (the fence opener is
    // blockLine); a position in the source cell carries its exact column.
    const rowCaret = (n: globalThis.Node | null, offset: number): { line: number; column?: number } | undefined => {
        const rowEl = toElement(n)?.closest(".calc-row");
        if (!rowEl?.parentElement) { return undefined; }
        const line = blockLine + 1 +
            Array.prototype.indexOf.call(rowEl.parentElement.children, rowEl);
        const srcEl = rowEl.querySelector(".calc-row-src");
        const column = n && srcEl?.contains(n) && n.nodeType === 3
            ? Math.min(offset, (srcEl.textContent ?? "").length)
            : undefined;
        return { line, column };
    };
    const anchor = rowCaret(sel.anchorNode, sel.anchorOffset);
    const head = rowCaret(sel.focusNode, sel.focusOffset) ?? anchor;
    if (head && anchor) {
        return sel.isCollapsed
            ? { line: head.line, column: head.column }
            : {
                line: head.line, column: head.column,
                anchorLine: anchor.line, anchorColumn: anchor.column,
            };
    }
    // An editable title island (a callout's or directive's role="textbox"
    // span): the title lives ON the block's marker line, so offsets in it
    // align into that source line under the same subsequence rules as any
    // rendered-vs-source divergence. Mid-edit text not yet committed to the
    // source simply fails alignment and degrades to the line.
    const titleEl = anchorEl.closest('[role="textbox"]');
    if (titleEl && chrome.contains(titleEl)) {
        const sourceLine = sourceLines[blockLine - 1] ?? "";
        const text = titleEl.textContent ?? "";
        const titleCaret = (n: globalThis.Node | null, offset: number): { line: number; column?: number } => {
            let column: number | undefined;
            if (n && titleEl.contains(n) && n.nodeType === 3) {
                // Offset within the WHOLE title text (an edited span can
                // hold several text nodes).
                let before = 0;
                const walker = document.createTreeWalker(titleEl, NodeFilter.SHOW_TEXT);
                for (let t = walker.nextNode(); t; t = walker.nextNode()) {
                    if (t === n) {
                        column = sourceColumnForTextOffset(
                            sourceLine, text, Math.min(before + offset, text.length));
                        break;
                    }
                    before += t.textContent?.length ?? 0;
                }
            }
            return { line: blockLine, ...(column !== undefined ? { column } : {}) };
        };
        const a = titleCaret(sel.anchorNode, sel.anchorOffset);
        const h = titleCaret(sel.focusNode, sel.focusOffset);
        return sel.isCollapsed || a.column === undefined || h.column === undefined
            ? { line: h.line, column: h.column }
            : { line: h.line, column: h.column, anchorLine: a.line, anchorColumn: a.column };
    }
    return { line: blockLine };
}

function getSwitchTarget():
    | { line: number; column?: number; anchorLine?: number; anchorColumn?: number }
    | undefined {
    const view = getEditorView();
    if (!view) { return undefined; }
    const { doc, selection } = view.state;
    const { head, empty } = selection;
    const sourceLines = getMarkdownSource().split("\n");
    // A DOM selection in preview chrome outranks the editor selection — the
    // chrome parks the editor, so its selection is stale by construction.
    const chromeTarget = domChromeTarget(view, sourceLines);
    if (chromeTarget) {
        return {
            ...chromeTarget,
            line: chromeTarget.line + currentLineOffset,
            ...(chromeTarget.anchorLine !== undefined
                ? { anchorLine: chromeTarget.anchorLine + currentLineOffset }
                : {}),
        };
    }
    if (!empty) {
        const ends = sourceSelectionEnds(doc, currentLineMap, sourceLines, selection);
        if (ends) {
            return {
                line: ends.head.line + currentLineOffset,
                column: ends.head.column,
                anchorLine: ends.anchor.line + currentLineOffset,
                anchorColumn: ends.anchor.column,
            };
        }
        // An unmappable range falls through to the caret path below.
    }
    let caretVisible = false;
    try {
        const coords = view.coordsAtPos(head);
        caretVisible = coords.bottom >= getTopbarBottom() && coords.top <= window.innerHeight;
    } catch {
        caretVisible = false; // A position the view can't measure yet.
    }
    const caret = caretVisible
        ? sourceCaretAt(doc, currentLineMap, sourceLines, head)
        : undefined;
    if (caret) {
        return { line: caret.line + currentLineOffset, column: caret.column };
    }
    return { line: getFirstVisibleSourceLine(view, currentLineMap) + currentLineOffset };
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
    // First attempt is synchronous: by the time the init handler runs, the
    // editor DOM is attached and measurable (getBoundingClientRect forces
    // layout), so an arriving scroll lands BEFORE the first visible paint —
    // the raw editor opens at the right place, and so should we. The timers
    // remain as the fallback for a document whose first block isn't
    // measurable yet.
    tryFn();
    if (done) return;
    for (const delay of [300, 600, 1100, 2000]) {
        setTimeout(tryFn, delay);
    }
}

// ── Outline refresh scheduling ─────────────────────────────
// The TOC tracks the document, so it must not ride the save debounce (see
// _onDocChange in editor.ts). It also must not run per TRANSACTION: the
// outline walk is O(document size) and a burst of typing is many transactions
// per frame. One rAF-coalesced refresh per painted frame is the honest
// ceiling: the outline can't visibly update more often than that anyway, so
// anything finer is work the user cannot perceive.
//
// This calls refreshContent (NOT refresh): a doc change can only change the
// outline, so it must not re-commit the panel's presentation — that path
// re-parses the tab's SVG and cycles a document listener, which on a keystroke
// is pure waste. See the contract on those two functions before repointing
// this at refresh().
let tocRefreshRaf: number | null = null;

function scheduleTocRefresh(): void {
    if (tocRefreshRaf !== null) {
        return;
    }
    tocRefreshRaf = requestAnimationFrame(() => {
        tocRefreshRaf = null;
        toc.refreshContent();
    });
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
            // The gutter's numbers come from this cached source, so this is the
            // moment they become correct again after an edit that added or
            // removed lines (see the staleness note in components/lineNumbers).
            lineNumbers.refresh();
            notifyUpdate(updated);
        },
        // Views of the document refresh on document changes — NOT on the
        // save/serialize cadence the callback above rides (see _onDocChange
        // in editor.ts for what that coupling cost). The find bar's note is
        // O(1) when the bar is closed or empty.
        () => {
            scheduleTocRefresh();
            findBar.noteDocChanged();
            // O(1) while the gutter is off, and idle-coalesced while it is on —
            // never work on the keystroke itself.
            lineNumbers.refresh();
        },
    );
    toc.refresh();
    // Seed the status-bar word count for the freshly loaded document (MAR-29):
    // the selection-change handler only fires on later edits/selection moves, so
    // without this the count would stay blank until the first interaction. The
    // reporter debounces, keeping this off the first-paint path.
    const initialView = getEditorView();
    if (initialView) { reportWordCount(initialView); }
    // First frame with rendered content on screen: wait two RAFs so the mark
    // lands after the browser has actually painted the mounted ProseMirror doc.
    requestAnimationFrame(() =>
        requestAnimationFrame(() => {
            mark("editor-painted");
            measure("launch", undefined, "editor-painted");
            // A fresh view means a fresh binding for the line-number gutter: it
            // resolves the view lazily (the setting can be on before any editor
            // exists, and a re-init replaces the view wholesale), so this is
            // what tells it to look again — without it, a gutter enabled at
            // panel load never finds a view and stays empty for the life of the
            // document. It sits INSIDE the paint callback rather than beside
            // toc.refresh() above so it cannot run before the paint mark:
            // called from the mount path, its idle callback landed in front of
            // `editor-painted` and put the whole layer's measure/insert/paint
            // there too (caught by e2e/lineNumbers).
            lineNumbers.refresh();
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

// Source line-number gutter (birta.lineNumbers, default OFF). Creating the gate
// loads nothing — the gutter's whole module sits behind a dynamic import that is
// only fetched if the setting is on (utils/lineNumbersLoader.ts).
const lineNumbers = createLineNumbersGate({
    getView: () => getEditorView(),
    getLineMap,
    getMarkdownSource,
    getLineOffset: () => currentLineOffset,
});
lineNumbers.setEnabled(window.__i18n?.lineNumbers === true);

const topbar = document.querySelector<HTMLElement>(".editor-topbar");
// "Edit Raw Markdown" (toolbar button AND right-click menu): same switch path
// as Cmd+Shift+M, carrying the caret (or the viewport, when the caret is off
// screen) so the raw editor opens where the user was.
const switchToSource = (): void => {
    notifySwitchToTextEditor(getSwitchTarget());
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
        () => toc.showProofreadingTab(),
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
    // Cmd+F2 (and Shift+Cmd+L): highlight every occurrence, focused on the
    // replace input.
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
    // Returns a detach function; nothing disposes it here because the webview
    // is torn down wholesale with its panel. It exists so the listeners are
    // removable at all — and so the behavior is unit-testable (MAR-220).
    initPathComplete(() => getEditorView());
    // Table row/column affordances (grips, insert bars, drag-reorder) now live
    // inside the table NodeView overlay — see components/table/tableView.ts.

    // Click the empty area above/below the content -> put the caret at the
    // document start/end. The band above the first block is the padding
    // `#editor` carries between the toolbar and `view.dom`; a leading block's
    // own top margin collapses out of the editor, so that padding is the only
    // pixel row above the content that belongs to the editor at all — and with
    // a leading table it is the ONLY pointer route to the position above it
    // (MAR-252).
    eventManager.onElement(editorContainer, "mousedown", (e) => {
        const view = getEditorView();
        if (!view) {
            return;
        }
        if (view.dom.contains(e.target as Node)) {
            return;
        }
        const first = view.dom.firstElementChild;
        const last = view.dom.lastElementChild;
        if (!first || !last) {
            return;
        }
        let side: -1 | 1;
        if (e.clientY > last.getBoundingClientRect().bottom) {
            side = 1;
        } else if (e.clientY < first.getBoundingClientRect().top) {
            side = -1;
        } else {
            return;
        }
        e.preventDefault();
        const { state } = view;
        // Prefer a gap cursor at that document edge when one is valid: a
        // document that starts or ends with a block leaf has no text position
        // outside it, so TextSelection.atStart/atEnd lands INSIDE the leaf —
        // clicking below a trailing table put the caret in its last cell and
        // the next keystroke edited that cell. isGapCursorPosition is false
        // whenever a text position really is there (the common case: a leading
        // or trailing paragraph), so this only changes what was wrong.
        const $edge = state.doc.resolve(side > 0 ? state.doc.content.size : 0);
        const sel = isGapCursorPosition($edge)
            ? new GapCursor($edge)
            : side > 0
                ? TextSelection.atEnd(state.doc)
                : TextSelection.atStart(state.doc);
        view.dispatch(state.tr.setSelection(sel));
        view.focus();
    });

    // Drag-and-drop images: the drag-time aim — the accent drop line at the
    // block boundary under the pointer, plus edge auto-scroll — and the
    // preventDefault that lets a drop fire in this document at all.
    initImageFileDrop(eventManager, {
        container: editorContainer,
        getView: () => getEditorView(),
    });

    // The DROP itself is the handleDrop prop in plugins/imagePaste.ts, which
    // reads the aim above. A listener out here sits OUTSIDE ProseMirror's own
    // drop handling, which runs first on the editor element and would insert
    // the payload's HTML flavor before this ever saw the event (MAR-277).
}

// Image PASTE is handled by the handlePaste prop in plugins/imagePaste.ts —
// see the drop note above: a document-level listener bubbles AFTER
// ProseMirror's, so the clipboard's HTML <img> was pasted first and the saved
// file inserted second, leaving two half-broken images (MAR-277).

// Selection drives two surfaces: the top toolbar tracks it to update its
// active-state, and (when birta.floatingToolbar.enabled) the floating palette
// shows/positions itself above the selection. Both are fed the same view.
registerSelectionChangeHandler((view) => {
    topbarTb?.onSelectionChange(view);
    selectionTb?.onSelectionChange(view);
    // Status-bar word count (MAR-29): fires on every selection OR doc change,
    // debounced inside the reporter so it never rides the keystroke path.
    reportWordCount(view);
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
                // Self-sinking checklists (birta.checklist.sinkChecked, baked at
                // load): when ON, the flip AND the relocation land as one undo
                // step; when OFF, applyTaskToggle does exactly the plain
                // in-place flip this site did before (zero extra work).
                const sink = window.__i18n?.checklistSinkChecked ?? false;
                applyTaskToggle(view, nodePos, !checked, sink);
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
// Publishes --bw-pane (the pane's scrollbar-free width) for the per-block
// full-width breakout CSS — one rAF-throttled resize listener (blockWidth.ts).
initPaneWidthVar();

// ── Message handlers ───────────────────────────────────────
const handlers = createMessageHandlers({
    state: {
        getEditor: () => currentEditor,
        setEditor: (editor) => {
            currentEditor = editor;
        },
        setLineMap: (lineMap) => {
            currentLineMap = lineMap;
        },
        getMarkdownSource,
        setMarkdownSource: (source) => {
            markdownSource = source;
        },
    },
    actions: {
        placeCaretAtLine,
        scrollToDocumentLine: (line) => {
            const view = getEditorView();
            if (!view) { return; }
            // A reveal that lands claims the remembered scroll position at
            // once, so the panel's own restore can't undo it (MAR-268 — see
            // rememberScrollNow).
            if (scrollToSourceLine(view, currentLineMap, toBodyLine(line))) {
                rememberScrollNow();
            }
        },
        getSwitchTarget,
        getSelectionContext,
        setLineOffset: (offset) => {
            currentLineOffset = offset;
        },
        initEditor,
        retryScroll,
        getEditorView,
        // An external edit changes the document, not the panel's own state.
        refreshToc: () => toc.refreshContent(),
        setTocPosition: (position) => toc.setPosition(position),
        setTocVisibility: (visibility) => toc.applyVisibility(visibility),
        setTocWidth: (width) => toc.setWidth(width),
        setNotesMarkers: (markers) => toc.setNotesMarkers(markers),
        setReviewGroupByType: (grouped) => toc.setReviewGroupByType(grouped),
        setLineNumbers: (enabled) => lineNumbers.setEnabled(enabled),
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
