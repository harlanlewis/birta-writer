/**
 * webview/readOnly.ts
 *
 * The read-only mode's single source of truth (MAR-53), and the classification
 * of every editor command as one that changes the document or one that only
 * reads it.
 *
 * The mode is a promise: with it on, no user gesture changes the document. A
 * mode that is not actually read-only is worse than no mode at all, so the
 * promise is kept in THREE independent layers rather than by an audit of the
 * chrome:
 *
 *   1. `editable` (editor.ts, via editorViewOptionsCtx). ProseMirror runs its
 *      edit handlers — keydown, beforeinput, paste, drop, cut, compositionstart
 *      — only while `view.editable` is true, so this one predicate retires
 *      native typing, IME, dictation, clipboard and drag input AND every keymap
 *      plugin and input rule in the tree, because all of them hang off
 *      `handleKeyDown` / `handleTextInput`. It also sets `contenteditable` to
 *      false, which is what removes the caret.
 *   2. `filterTransaction` (plugins/readOnly.ts). ProseMirror consults every
 *      plugin's filter for every transaction regardless of registration order,
 *      appended transactions included, so a doc-changing transaction from a
 *      chrome path layer 1 cannot see — a toolbar click, a NodeView button, a
 *      click handler — is dropped at the state boundary.
 *   3. The command gate below. Layer 2 makes a missed command a silent no-op;
 *      this makes it an honest one, so the chrome can dim the control instead
 *      of offering a button that does nothing.
 *
 * Layers 1 and 2 are the correctness story and neither enumerates anything.
 * Layer 3 is the affordance story and is exhaustive by construction: the
 * classification is `Record<EditorCommandId, CommandEffect>`, so a new command
 * fails to compile until it is classified, and `readOnly.test.ts` asserts the
 * partition's size against the shared command list rather than trusting it.
 *
 * All three layers reach only what ProseMirror owns. A surface that is neither
 * contenteditable nor a transaction sits outside every one of them and has to
 * ask `isReadOnly()` at its own sender: the fullscreen code editor's
 * `<textarea>` (`components/codeBlock/lightbox.ts`), the link popup's edit
 * verbs, the embed palette, the HTML block's click-to-edit, the code block's
 * language picker, the task checkbox. The chrome those surfaces show is
 * retired by `body.read-only` rules in `style.css` (the "Read-only chrome"
 * section), which is the ONE place a NodeView-owned control that only writes
 * (a table's insert bars and grips, an embed's edit verbs, an image's path
 * pencil) is hidden; a control that also reads stays and gates in code.
 *
 * What the mode deliberately does NOT block: anything that leaves the document
 * alone. Selection, copy, find, folding, the TOC, link navigation, block width
 * and every other presentation preference, and inbound external changes — the
 * file itself is still editable elsewhere (that is the point of "Edit Raw
 * Markdown"), and content arriving from outside is the author's text whatever
 * the mode says (docs/DESIGN_PRINCIPLES.md, "Never fight an external edit").
 */
import type { EditorCommandId } from "../shared/editorCommands";

/** Whether a command changes the document or only reads/views it. */
export type CommandEffect = "mutates" | "reads";

/**
 * Every editor command, classified. `mutates` is the default reading of an
 * entry: when in doubt a command belongs there, because a wrongly-blocked
 * command is a visibly dimmed control and a wrongly-allowed one is a broken
 * promise.
 *
 * `reads` therefore holds only commands that provably leave the document
 * alone: navigation and selection, the clipboard's read direction, view
 * chrome, settings, and folding (fold state is plugin state and decorations,
 * never a doc change). `editRawMarkdown` counts as reading because it does not
 * itself edit — it hands the user to the text editor, where the intent to edit
 * is explicit, which is the escape hatch the mode is designed around.
 */
export const COMMAND_EFFECTS: Record<EditorCommandId, CommandEffect> = {
    // ── Inline marks and block type ─────────────────────────────────────────
    toggleBold: "mutates",
    toggleItalic: "mutates",
    toggleStrikethrough: "mutates",
    toggleHighlight: "mutates",
    toggleInlineCode: "mutates",
    clearFormatting: "mutates",
    setParagraph: "mutates",
    setHeading1: "mutates",
    setHeading2: "mutates",
    setHeading3: "mutates",
    setHeading4: "mutates",
    setHeading5: "mutates",
    setHeading6: "mutates",
    toggleBulletList: "mutates",
    toggleOrderedList: "mutates",
    toggleTaskList: "mutates",
    toggleBlockquote: "mutates",
    // ── Inserts ─────────────────────────────────────────────────────────────
    insertCodeBlock: "mutates",
    insertHorizontalRule: "mutates",
    insertTable: "mutates",
    insertLink: "mutates",
    insertSectionLink: "mutates",
    insertImage: "mutates",
    insertMath: "mutates",
    insertFootnote: "mutates",
    insertCallout: "mutates",
    toggleCallout: "mutates",
    insertParagraphAfter: "mutates",
    insertParagraphBefore: "mutates",
    // ── Block operations ────────────────────────────────────────────────────
    duplicateBlockUp: "mutates",
    duplicateBlockDown: "mutates",
    moveBlockUp: "mutates",
    moveBlockDown: "mutates",
    indentBlock: "mutates",
    outdentBlock: "mutates",
    deleteBlock: "mutates",
    joinLines: "mutates",
    transformToUppercase: "mutates",
    transformToLowercase: "mutates",
    transformToTitleCase: "mutates",
    uncheckAllTasks: "mutates",
    pasteAsPlainText: "mutates",
    // ── Tables ──────────────────────────────────────────────────────────────
    tableInsertRowAbove: "mutates",
    tableInsertRowBelow: "mutates",
    tableInsertColumnLeft: "mutates",
    tableInsertColumnRight: "mutates",
    tableAlignColumnLeft: "mutates",
    tableAlignColumnCenter: "mutates",
    tableAlignColumnRight: "mutates",
    tableDeleteRow: "mutates",
    tableDeleteColumn: "mutates",
    tableDeleteTable: "mutates",
    // ── Surfaces that exist to write ────────────────────────────────────────
    // Each opens a panel or menu whose whole purpose is a mutation. Blocking
    // the opener is what keeps the mode honest: a panel that opens and then
    // refuses on Apply is a worse promise than one that never opens.
    editBlockSource: "mutates",
    editFrontmatter: "mutates",
    // Replace is the mutating half of find; plain Find is below.
    openFindReplace: "mutates",
    selectAllOccurrences: "mutates",
    // ── Reading, navigation and selection ───────────────────────────────────
    openLink: "reads",
    openFind: "reads",
    // The block menu is NOT a writing surface the way the two panels above
    // are: it also folds, copies a block as Markdown, and copies a link to a
    // section, which is exactly the work a reader does. Its mutating rows go
    // dead against the transaction filter and the gate on the commands they
    // call. Refusing the command would also have been inconsistent rather than
    // strict, because the gutter handle opens the same menu without passing
    // through here.
    openBlockMenu: "reads",
    findNext: "reads",
    findPrevious: "reads",
    findSelection: "reads",
    expandSelection: "reads",
    shrinkSelection: "reads",
    copyAsHtml: "reads",
    copyAsMarkdown: "reads",
    copyAsRichText: "reads",
    editRawMarkdown: "reads",
    // ── Folding (plugin state and decorations; never a doc change) ──────────
    fold: "reads",
    unfold: "reads",
    foldAll: "reads",
    unfoldAll: "reads",
    foldLevel1: "reads",
    foldLevel2: "reads",
    foldLevel3: "reads",
    foldLevel4: "reads",
    foldLevel5: "reads",
    foldLevel6: "reads",
    foldLevel7: "reads",
    // ── View chrome and settings ────────────────────────────────────────────
    toggleToc: "reads",
    swapTocSide: "reads",
    focusReviewSidebar: "reads",
    toggleToolbar: "reads",
    // The mode's own toggle. Classified as reading BECAUSE it is: it changes
    // no document byte, and gating it while read-only would be a lock with no
    // key on the palette side.
    toggleReadOnly: "reads",
    toggleFocusMode: "reads",
    hideToolbar: "reads",
    showToolbar: "reads",
    customizeToolbar: "reads",
    openExtensionSettings: "reads",
    openKeyboardShortcuts: "reads",
    openShortcutsHelp: "reads",
    openWhatsNew: "reads",
    fontEditor: "reads",
    fontSans: "reads",
    fontSerif: "reads",
    fontMono: "reads",
    increaseFontSize: "reads",
    decreaseFontSize: "reads",
    toggleSpellCheck: "reads",
    toggleGrammarCheck: "reads",
    toggleStyleCheck: "reads",
    toggleNoteHighlights: "reads",
    // Export reads the rendered document and writes a file elsewhere; the
    // document itself is untouched, and a locked document is still exportable.
    exportHtml: "reads",
};

/** True when this command changes the document and read-only must refuse it. */
export function commandMutates(id: string): boolean {
    return (COMMAND_EFFECTS as Record<string, CommandEffect | undefined>)[id] === "mutates";
}

// ── The mode ────────────────────────────────────────────────────────────────

// The bootstrap value is baked into the HTML before this script runs (the
// `calcEnabled` pattern), so the very first paint is already in the right mode
// and no transaction ever lands under the wrong one.
let _readOnly = Boolean(window.__i18n?.readOnly);

const _listeners = new Set<(readOnly: boolean) => void>();

/** Whether edits are currently locked. */
export function isReadOnly(): boolean {
    return _readOnly;
}

/**
 * Subscribe to mode changes. Returns the unsubscribe. Every mirroring control
 * repaints from this one event — a surface holding a private copy, or
 * re-reading defensively on open, is the failure "One switch, one
 * announcement" names (docs/DESIGN_PRINCIPLES.md).
 */
export function subscribeReadOnly(fn: (readOnly: boolean) => void): () => void {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
}

/**
 * Mirror the mode onto the body, which is how CSS reaches chrome that has no
 * subscriber of its own. Applied on editor mount as well as on every change,
 * so a fresh editor (a revert, a format re-init) is never painted editable.
 */
export function syncReadOnlyBodyClass(): void {
    document.body.classList.toggle("read-only", _readOnly);
}

// ── Editable islands ────────────────────────────────────────────────────────

/**
 * A few surfaces set `contentEditable` on an element of their own rather than
 * relying on ProseMirror's: a callout's title, a directive's title, the
 * frontmatter panel's cells. They are the ONE class of editable surface layer
 * 1 cannot reach, because `view.editable` stamps the editor root and an
 * explicit `contentEditable="true"` on a descendant overrides that inheritance.
 * Their commits are still caught downstream, so the file was never at risk —
 * but the user watched their typing appear and then vanish, which is the
 * visible half of the same broken promise.
 *
 * The attribute is the registry, so the sweep below needs no subscription and
 * therefore no unsubscribe: a NodeView that was destroyed is simply not found,
 * which matters because several of these views have no `destroy` hook to
 * unsubscribe from (`components/directive`).
 */
const ISLAND_ATTR = "data-editable-island";

/**
 * Declare an element an editable island and set its initial editability for
 * the current mode. Prefers `plaintext-only` and falls back to `true`, since
 * jsdom throws on the value Chromium wants.
 */
export function markEditableIsland(el: HTMLElement, plaintextOnly = true): void {
    let mode = "true";
    if (plaintextOnly) {
        try {
            el.contentEditable = "plaintext-only";
            mode = "plaintext-only";
        } catch {
            // jsdom: fall through to plain "true".
        }
    }
    el.setAttribute(ISLAND_ATTR, mode);
    applyIsland(el, mode);
}

/**
 * The attribute is written alongside the property because jsdom does not
 * reflect `contentEditable`, and without it a cell is not focusable there.
 */
function applyIsland(el: HTMLElement, mode: string): void {
    const value = _readOnly ? "false" : mode;
    el.contentEditable = value;
    el.setAttribute("contenteditable", value);
}

function syncEditableIslands(): void {
    for (const el of document.querySelectorAll<HTMLElement>(`[${ISLAND_ATTR}]`)) {
        applyIsland(el, el.getAttribute(ISLAND_ATTR) ?? "true");
    }
}

// ── Form controls that write ────────────────────────────────────────────────

/**
 * The other class of surface outside layers 1 and 2: a real `<input>` or
 * `<textarea>` a NodeView owns (an image's caption, title and path fields),
 * or a `<button>` whose whole job is a mutation. Their commits are refused
 * downstream, but a field that takes typing and then drops it is the same
 * visible half of the broken promise the islands are. Same registry
 * discipline as the islands: the attribute is the list, the sweep needs no
 * subscription, and a destroyed view is simply not found.
 */
const LOCKS_ATTR = "data-locks-with-document";

type LockableControl = HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement;

/**
 * Register a control that must go inert while the document is read-only.
 * Inputs and textareas become `readOnly` (still focusable, selectable and
 * copyable, which is what a reader wants from a caption); buttons and
 * selects become `disabled`.
 */
export function lockWithDocument(el: LockableControl): void {
    el.setAttribute(LOCKS_ATTR, "");
    applyLock(el);
}

function applyLock(el: LockableControl): void {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.readOnly = _readOnly;
    } else {
        el.disabled = _readOnly;
    }
}

function syncLockedControls(): void {
    for (const el of document.querySelectorAll<LockableControl>(`[${LOCKS_ATTR}]`)) {
        applyLock(el);
    }
}

/**
 * Set the mode and announce it. Idempotent: setting the current value notifies
 * nobody, so a control that echoes its own change cannot loop.
 *
 * The body class and the islands are written here rather than by subscribers
 * so they can never lag the predicate the transaction filter reads: the CSS
 * that hides editing chrome, the islands, and the lock itself all flip in the
 * same synchronous step.
 */
export function setReadOnly(next: boolean): void {
    if (next === _readOnly) { return; }
    _readOnly = next;
    syncReadOnlyBodyClass();
    syncEditableIslands();
    syncLockedControls();
    for (const fn of _listeners) { fn(next); }
}
