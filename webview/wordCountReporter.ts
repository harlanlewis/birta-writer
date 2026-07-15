import type { EditorView } from "@milkdown/prose/view";
import { countText } from "./utils/wordCount";
import { notifyWordCount } from "./messaging";

/**
 * Debounced word-count reporter (MAR-29). Selection changes and edits both fire
 * the editor's selection-change handler; this coalesces those bursts and, once
 * they settle, extracts plain text from the live ProseMirror state and posts
 * counts to the extension for the status bar item.
 *
 * Counting runs on the document's PLAIN TEXT (via `doc.textBetween`), not its
 * serialized markdown, so syntax markers (`#`, `*`, backticks, …) are never
 * counted. Serialization is skipped entirely — this only walks text nodes.
 */

// Long enough to coalesce a typing burst, off the keystroke path; short enough
// that the count feels live once the user pauses. Independent of the save
// scheduler's debounce — this never serializes or touches the document.
const DEBOUNCE_MS = 250;

let timer: ReturnType<typeof setTimeout> | undefined;

/** Extract counts from the view and post them now (no debounce). Exported for tests. */
export function computeAndPost(view: EditorView): void {
    const { doc, selection } = view.state;
    const docText = doc.textBetween(0, doc.content.size, "\n", "\n");
    const docCounts = countText(docText);
    const { from, to } = selection;
    const selectionCounts =
        to > from ? countText(doc.textBetween(from, to, "\n", "\n")) : null;
    notifyWordCount(docCounts, selectionCounts);
}

/** Schedule a debounced word-count report for the given editor view. */
export function reportWordCount(view: EditorView): void {
    if (timer !== undefined) { clearTimeout(timer); }
    timer = setTimeout(() => {
        timer = undefined;
        computeAndPost(view);
    }, DEBOUNCE_MS);
}
