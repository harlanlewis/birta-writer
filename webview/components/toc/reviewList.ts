/**
 * The shared body of the review sidebar's Proofreading and Notes tabs. Both are
 * the same thing: a flat, document-ordered list of tagged rows, each navigable,
 * with hover actions — differing only in what they collect (findings vs note
 * markers) and their empty-state copy. This owns the parts they share:
 *
 *   - the scrolling container + empty state;
 *   - a SIGNATURE DIFF so a rebuild happens only when the visible rows actually
 *     change. Ordinary typing shifts every anchor but changes no row's tag or
 *     label, so the common case is an in-place anchor sync (dataset write per
 *     surviving row) with zero DOM teardown — the same frugality the Contents
 *     outline has (renderHeadings' signature short-circuit).
 *
 * An adapter calls `render(result)` each refresh; producing the `result` (the
 * scan / finding read) is the adapter's job, and its own caching keeps THAT
 * cheap (see notesList's incremental scan).
 */
import type { EditorView } from "@/pm";
import { revealRange } from "./navigate";
import { buildReviewItem, buildReviewEmpty, type ReviewAction } from "./reviewItem";

/** One row model the adapter hands in; identity/display drives the signature,
 *  from/to are the (frequently shifting) navigation anchor. */
export interface ReviewRowModel {
    tag: string;
    label: string;
    title?: string;
    from: number;
    to: number;
    actions: ReviewAction[];
}

/** What a refresh resolves to: rows, an empty-state message, or nothing (no
 *  editor yet). */
export type ReviewResult =
    | { rows: ReviewRowModel[] }
    | { empty: string }
    | null;

export interface ReviewListRenderer {
    element: HTMLElement;
    /** Rebuild-or-sync from a freshly produced result. */
    render: (result: ReviewResult) => void;
}

// Record/field separators for the render signature, built at runtime so no
// invisible control byte ever lands in this source file (a literal one makes
// the file read as binary to git/grep). Row text can't contain them, so the
// signature is injective — and a sentinel prefixed with SEP_FIELD (below) can
// never collide with a rows signature, whose first char is a row's tag.
const SEP_FIELD = String.fromCharCode(31);
const SEP_ROW = String.fromCharCode(30);

/** The part of a row that, if changed, requires a DOM rebuild — everything the
 *  row DISPLAYS. Deliberately excludes from/to (synced in place). */
function rowSignature(row: ReviewRowModel): string {
    return [row.tag, row.label, row.title ?? "", row.actions.map((a) => a.label).join(",")].join(SEP_FIELD);
}

function resultSignature(result: ReviewResult): string {
    if (result === null) { return SEP_FIELD + "null"; }
    if ("empty" in result) { return SEP_FIELD + "empty" + SEP_FIELD + result.empty; }
    return result.rows.map(rowSignature).join(SEP_ROW);
}

export function initReviewList(className: string, getView: () => EditorView | null): ReviewListRenderer {
    const element = document.createElement("div");
    element.className = className;

    // The signature of what's currently in the DOM; null forces the first render.
    let renderedSignature: string | null = null;

    const navigate = (from: number, to: number): void => {
        const view = getView();
        if (view) { revealRange(view, from, to); }
    };

    /** Carry shifted anchors onto the rows already on screen — the common case,
     *  since typing moves every anchor without changing a row's display. */
    function syncAnchors(rows: ReviewRowModel[]): void {
        const items = element.querySelectorAll<HTMLElement>(".review-item");
        if (items.length !== rows.length) { return; } // signature drift; never sync blind
        rows.forEach((row, i) => {
            const item = items[i]!;
            item.dataset["from"] = String(row.from);
            item.dataset["to"] = String(row.to);
        });
    }

    function render(result: ReviewResult): void {
        const signature = resultSignature(result);
        if (signature === renderedSignature) {
            // Identical display ⇒ identical DOM; only the anchors may have moved.
            if (result && "rows" in result) { syncAnchors(result.rows); }
            return;
        }
        renderedSignature = signature;
        if (result === null) {
            element.replaceChildren();
            return;
        }
        if ("empty" in result) {
            element.replaceChildren(buildReviewEmpty(result.empty));
            return;
        }
        element.replaceChildren(
            ...result.rows.map((row) => buildReviewItem({ ...row, navigate })),
        );
    }

    return { element, render };
}
