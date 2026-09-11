/**
 * Replace a range with text that keeps the range's own marks.
 *
 * `tr.insertText(text, from, to)` derives the new text node's marks from
 * `$from.marksAcross($to)`, which drops any mark whose spec is
 * `inclusive: false` unless that mark is also present at `to`. A range that
 * ends exactly at such a mark's end boundary is precisely the case where it is
 * not, so replacing a whole marked run writes the replacement unmarked and the
 * construct is destroyed: a code span holding `2+3=` comes back as plain text,
 * taking the user's backticks with it. That is a fidelity loss rather than a
 * placement one.
 *
 * Two marks in this schema are `inclusive: false` and so are in the blast
 * radius: `link` (plugins/linkBoundary.ts, our own decision) and `inlineCode`
 * (Milkdown's, since 7.22.1). Any mark that joins them inherits this, which is
 * why the fix belongs in one helper rather than at each call site.
 *
 * The region's own marks are what "rewrite this text in place" means, so they
 * are read off the node the region starts in and set as the transaction's
 * stored marks, which is the one input `insertText` prefers over its own
 * derivation. Everything else about the call stays upstream's.
 *
 * Setting stored marks leaves nothing behind: `Transaction.addStep` nulls them
 * once the step is applied, so this decides the new text node's marks and not
 * what the user's next keystroke carries. It also means a caller replacing
 * several ranges in one transaction must come back through here for each one,
 * which it does by construction.
 *
 * A region spanning more than one marked run flattens to the first run's marks,
 * so replacing all of ``**2**+3`` confirms to a wholly bold result. That is not
 * new: upstream's `marksAcross` returns one mark set too, and keeps an
 * inclusive mark such as `strong` for exactly the same span. Preserving each
 * run would mean rebuilding the region rather than replacing it, which is a
 * different job from this one.
 */
import type { EditorView, Transaction } from "../pm";

/**
 * `tr.insertText(text, from, to)` with the range's own marks preserved.
 * Returns the same transaction, so it chains where `insertText` does.
 */
export function insertTextKeepingMarks(
    tr: Transaction,
    text: string,
    from: number,
    to: number,
): Transaction {
    const $from = tr.doc.resolve(from);
    const marks = $from.nodeAfter?.marks ?? $from.marks();
    return tr.setStoredMarks(marks).insertText(text, from, to);
}

/** The same replacement as its own dispatched transaction, scrolled into view. */
export function replaceKeepingMarks(
    view: EditorView,
    from: number,
    to: number,
    text: string,
): void {
    view.dispatch(insertTextKeepingMarks(view.state.tr, text, from, to).scrollIntoView());
}
