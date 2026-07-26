/**
 * shared/agentContext.ts
 *
 * The canonical shape of "what the user has open and selected in a Birta
 * editor" — the neutral core every coding-agent bridge reads. It is produced by
 * the webview (webview/agentContext.ts), carried over the protocol
 * (shared/messages.ts: requestEditorContext / editorContextResult), and
 * projected onto each agent's ingestion surface by the adapters in
 * src/agentBridge/.
 *
 * Why it exists: VS Code deliberately leaves `window.activeTextEditor`
 * undefined while a custom editor is focused (microsoft/vscode#102110,
 * as-designed). A coding agent that reads that API — Copilot, Cursor, the
 * Claude/Codex sidebars — therefore sees nothing when the user is in Birta.
 * This type is what they read instead.
 *
 * Coordinates follow the rest of the WYSIWYG↔source wire (see
 * webview/utils/sourceCaret.ts): `line` is a 1-indexed DOCUMENT line
 * (frontmatter included) and `column` is 0-indexed. Column is best-effort — it
 * degrades to 0 when the webview cannot map it honestly (inside inline markup a
 * reader can't see), never a guess.
 */

/** A caret position in the document. 1-indexed line, 0-indexed column. */
export interface DocPosition {
    line: number;
    column: number;
}

/**
 * One selected range. `anchor` is where the selection began and `active` is the
 * moving caret end; for a bare caret the two are equal and `text` is empty.
 * `text` is the selection's PLAIN text (markup stripped) — the precise source
 * pointer is the line span, which addresses the real markdown on disk.
 */
export interface DocSelection {
    anchor: DocPosition;
    active: DocPosition;
    text: string;
}

/** The live selection state of a Birta editor, in document coordinates. */
export interface EditorSelectionContext {
    /**
     * The selected ranges. Today this always holds exactly one entry (the
     * editor has a single selection); the array shape is deliberate so a future
     * multi-cursor editor needs no protocol change.
     */
    selections: DocSelection[];
    /** Index of the primary selection within `selections`. */
    primary: number;
    /** True when the primary selection is a bare caret (no selected text). */
    isEmpty: boolean;
}

/** Order two positions: negative when `a` precedes `b`. */
export function comparePos(a: DocPosition, b: DocPosition): number {
    return a.line !== b.line ? a.line - b.line : a.column - b.column;
}

/** A selection as an ordered range (start ≤ end), regardless of drag direction. */
export function orderedRange(sel: DocSelection): { start: DocPosition; end: DocPosition } {
    return comparePos(sel.anchor, sel.active) <= 0
        ? { start: sel.anchor, end: sel.active }
        : { start: sel.active, end: sel.anchor };
}

/** Ordered 1-indexed line span a selection covers (start ≤ end). */
export function selectionLineSpan(sel: DocSelection): { startLine: number; endLine: number } {
    const { start, end } = orderedRange(sel);
    return { startLine: start.line, endLine: end.line };
}

/**
 * GitHub / agent-style line-reference suffix: `#L12` for a single line,
 * `#L12-L20` for a range. The form every major coding agent accepts in an
 * @-mention or file reference.
 */
export function lineRefSuffix(startLine: number, endLine: number): string {
    return startLine === endLine ? `#L${startLine}` : `#L${startLine}-L${endLine}`;
}
