import type { EditorView } from "./pm";
import type { Node as ProseNode } from "./pm";
import type { TextCount } from "../shared/messages";
import { countText } from "./utils/wordCount";
import { requestIdle } from "./utils/idle";
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
 *
 * Two things keep this off the critical path, because counting the whole
 * document is O(document size) and the handler above fires on mere caret moves:
 *
 * 1. The document counts are cached against the doc node itself. ProseMirror
 *    nodes are immutable, so `doc !== lastDoc` is an exact "the text changed"
 *    test — moving the caret reuses the cached counts and only the selection
 *    range (O(selection)) is recounted.
 * 2. The compute runs in an idle window after the debounce settles, so it fills
 *    a gap between frames instead of blocking one.
 */

// Long enough to coalesce a typing burst, off the keystroke path; short enough
// that the count feels live once the user pauses. Independent of the save
// scheduler's debounce — this never serializes or touches the document.
const DEBOUNCE_MS = 250;

// Upper bound on how long the count may wait for an idle window before running
// anyway, so a busy main thread delays the readout but never starves it.
const IDLE_TIMEOUT_MS = 1000;

let timer: ReturnType<typeof setTimeout> | undefined;
let idle: { cancel: () => void } | undefined;

// Cache keyed on the doc node's identity (see note 1 above).
let lastDoc: ProseNode | undefined;
let lastDocCounts: TextCount | undefined;

/**
 * Counts for the whole document, recomputed only when the doc node changed.
 * Reference equality is sound here precisely because PM docs are persistent:
 * any edit produces a new node, and an unchanged doc is always the same object.
 */
function documentCounts(doc: ProseNode): TextCount {
    if (doc !== lastDoc) {
        lastDocCounts = countText(doc.textBetween(0, doc.content.size, "\n", "\n"));
        lastDoc = doc;
    }
    return lastDocCounts!;
}

/** Extract counts from the view and post them now (no debounce). Exported for tests. */
export function computeAndPost(view: EditorView): void {
    const { doc, selection } = view.state;
    const docCounts = documentCounts(doc);
    const { from, to } = selection;
    const selectionCounts =
        to > from ? countText(doc.textBetween(from, to, "\n", "\n")) : null;
    notifyWordCount(docCounts, selectionCounts);
}

/**
 * Schedule a debounced word-count report for the given editor view. The counts
 * are read from `view.state` when the callback finally runs, not when it was
 * scheduled, so a superseded report never posts stale numbers.
 */
export function reportWordCount(view: EditorView): void {
    if (timer !== undefined) { clearTimeout(timer); }
    idle?.cancel();
    idle = undefined;
    timer = setTimeout(() => {
        timer = undefined;
        idle = requestIdle(() => {
            idle = undefined;
            computeAndPost(view);
        }, IDLE_TIMEOUT_MS);
    }, DEBOUNCE_MS);
}

/**
 * Drop any pending report and the cached counts. Exported for tests, so module
 * state from one case can't leak into the next.
 */
export function resetWordCountReporter(): void {
    if (timer !== undefined) { clearTimeout(timer); }
    timer = undefined;
    idle?.cancel();
    idle = undefined;
    lastDoc = undefined;
    lastDocCounts = undefined;
}
