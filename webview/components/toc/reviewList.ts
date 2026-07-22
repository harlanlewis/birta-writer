/**
 * The shared body of the review sidebar's Proofreading and Notes tabs. Both are
 * the same thing: a flat, document-ordered list of tagged rows, each navigable,
 * with hover actions — differing only in what they collect (findings vs note
 * markers) and their empty-state copy. This owns the parts they share:
 *
 *   - a view-mode toggle (By type / In order). "By type" groups rows under a
 *     collapsible type header (full-width, so a long category name like "Long
 *     sentence" never truncates the way a per-row chip does) in document order
 *     within each group; "In order" is the flat document-ordered list. The mode
 *     is a persisted setting (birta.review.groupByType) so it survives the
 *     webview being disposed on tab switch-away.
 *   - the scrolling container + empty state;
 *   - a SIGNATURE DIFF so a rebuild happens only when the visible rows actually
 *     change. Ordinary typing shifts every anchor but changes no row's display,
 *     so the common case is an in-place anchor sync (dataset write per surviving
 *     row) with zero DOM teardown — the frugality the Contents outline has.
 *
 * An adapter calls `render(result)` each refresh; producing the `result` (the
 * scan / finding read) is the adapter's job, and its own caching keeps THAT
 * cheap (see notesList's incremental scan).
 */
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { revealRange } from "./navigate";
import { buildReviewItem, buildReviewEmpty, type ReviewAction } from "./reviewItem";

/** One row model the adapter hands in; identity/display drives the signature,
 *  from/to are the (frequently shifting) navigation anchor, `tag` is the type
 *  (the chip in flat mode, the group key in By-type mode). */
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
    /** Apply an external group-mode change (a settings echo) without re-persisting. */
    setGroupByType: (grouped: boolean) => void;
}

// Record/field/subfield separators for the render signature, built at runtime so
// no invisible control byte lands in this source file (a literal one makes it
// read as binary to git/grep). Row text can't contain them, so the signature is
// injective, and a sentinel prefixed with SEP_FIELD can't collide with a rows
// signature (whose first char is a row's tag / a group name).
const SEP_FIELD = String.fromCharCode(31);
const SEP_ROW = String.fromCharCode(30);
const SEP_SUB = String.fromCharCode(29);

/** The part of a row that, if changed, requires a DOM rebuild — everything the
 *  row DISPLAYS. Deliberately excludes from/to (synced in place). */
function rowSignature(row: ReviewRowModel): string {
    return [row.tag, row.label, row.title ?? "", row.actions.map((a) => a.label).join(",")].join(SEP_FIELD);
}

/** Rows grouped by tag, groups in first-appearance (document) order, rows in
 *  document order within each group. */
function groupByTag(rows: readonly ReviewRowModel[]): Array<{ tag: string; rows: ReviewRowModel[] }> {
    const order: string[] = [];
    const map = new Map<string, ReviewRowModel[]>();
    for (const row of rows) {
        let bucket = map.get(row.tag);
        if (!bucket) { bucket = []; map.set(row.tag, bucket); order.push(row.tag); }
        bucket.push(row);
    }
    return order.map((tag) => ({ tag, rows: map.get(tag)! }));
}

export function initReviewList(
    className: string,
    getView: () => EditorView | null,
    opts: { initialGroupByType: boolean; onToggleGroupByType: (grouped: boolean) => void },
): ReviewListRenderer {
    const element = document.createElement("div");
    element.className = className;

    let groupByType = opts.initialGroupByType;
    // Session-scoped collapsed group tags (view-only; not persisted, like the
    // proofread popup's Ignore).
    const collapsed = new Set<string>();
    // The last produced result, replayed when the mode or a collapse toggles
    // (those change the DOM without a new scan/finding read).
    let lastResult: ReviewResult = null;
    // The signature of what's currently in the body; null forces a rebuild.
    let renderedSignature: string | null = null;

    // ── View-mode toggle (persistent chrome, built once) ──────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "review-toolbar";
    const segByType = makeSeg(t("By type"), true);
    const segInOrder = makeSeg(t("In order"), false);
    toolbar.append(segByType, segInOrder);
    const bodyEl = document.createElement("div");
    bodyEl.className = "review-body";
    element.append(toolbar, bodyEl);

    function makeSeg(label: string, grouped: boolean): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.className = "review-seg";
        btn.textContent = label;
        btn.tabIndex = -1;
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            setMode(grouped, true);
        });
        return btn;
    }
    function updateSegActive(): void {
        segByType.classList.toggle("review-seg--active", groupByType);
        segInOrder.classList.toggle("review-seg--active", !groupByType);
    }
    updateSegActive();

    /** Switch modes and re-render. `persist` distinguishes a user click (echo the
     *  setting) from an external settings echo (already persisted). */
    function setMode(grouped: boolean, persist: boolean): void {
        if (grouped === groupByType) { return; }
        groupByType = grouped;
        updateSegActive();
        if (persist) { opts.onToggleGroupByType(grouped); }
        renderedSignature = null; // structure changed: force a rebuild
        renderInto(lastResult);
    }

    const navigate = (from: number, to: number): void => {
        const view = getView();
        if (view) { revealRange(view, from, to); }
    };

    /** The rows currently ON SCREEN, in DOM order — flat rows, or the rows of
     *  expanded groups. Kept in lockstep with what renderInto builds so anchor
     *  sync can align by index. */
    function visibleRows(result: ReviewResult): ReviewRowModel[] {
        if (!result || "empty" in result) { return []; }
        if (!groupByType) { return result.rows; }
        return groupByTag(result.rows).filter((g) => !collapsed.has(g.tag)).flatMap((g) => g.rows);
    }

    function signatureOf(result: ReviewResult): string {
        if (result === null) { return SEP_FIELD + "null"; }
        if ("empty" in result) { return SEP_FIELD + "empty" + SEP_FIELD + result.empty; }
        if (!groupByType) {
            return "F" + result.rows.map(rowSignature).join(SEP_ROW);
        }
        return "G" + groupByTag(result.rows).map((g) => {
            const head = g.tag + SEP_FIELD + g.rows.length + SEP_FIELD + (collapsed.has(g.tag) ? "c" : "e");
            const body = collapsed.has(g.tag) ? "" : SEP_FIELD + g.rows.map(rowSignature).join(SEP_SUB);
            return head + body;
        }).join(SEP_ROW);
    }

    /** Carry shifted anchors onto the rows already on screen — the common case,
     *  since typing moves every anchor without changing a row's display. */
    function syncAnchors(result: ReviewResult): void {
        const rows = visibleRows(result);
        const items = bodyEl.querySelectorAll<HTMLElement>(".review-item");
        if (items.length !== rows.length) { return; } // signature drift; never sync blind
        rows.forEach((row, i) => {
            const item = items[i]!;
            item.dataset["from"] = String(row.from);
            item.dataset["to"] = String(row.to);
        });
    }

    function makeGroupHeader(tag: string, count: number): HTMLElement {
        const header = document.createElement("button");
        header.className = "review-group";
        header.tabIndex = -1;
        const isCollapsed = collapsed.has(tag);
        header.classList.toggle("review-group--collapsed", isCollapsed);
        header.setAttribute("aria-expanded", String(!isCollapsed));

        const caret = document.createElement("span");
        caret.className = "review-group__caret";
        const name = document.createElement("span");
        name.className = "review-group__name";
        name.textContent = tag;
        const num = document.createElement("span");
        num.className = "review-group__count";
        num.textContent = String(count);
        header.append(caret, name, num);

        header.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (collapsed.has(tag)) { collapsed.delete(tag); } else { collapsed.add(tag); }
            renderedSignature = null;
            renderInto(lastResult);
        });
        return header;
    }

    function buildRows(rows: readonly ReviewRowModel[]): HTMLElement[] {
        return rows.map((row) => buildReviewItem({ ...row, navigate }));
    }

    function renderInto(result: ReviewResult): void {
        lastResult = result;
        const hasRows = !!result && "rows" in result && result.rows.length > 0;
        toolbar.hidden = !hasRows; // the toggle only makes sense with content

        const signature = (groupByType ? "G" : "F") + signatureOf(result);
        if (signature === renderedSignature) {
            if (hasRows) { syncAnchors(result); }
            return;
        }
        renderedSignature = signature;
        element.classList.toggle("review-list--grouped", groupByType && hasRows);

        if (result === null) { bodyEl.replaceChildren(); return; }
        if ("empty" in result) { bodyEl.replaceChildren(buildReviewEmpty(result.empty)); return; }

        if (!groupByType) {
            bodyEl.replaceChildren(...buildRows(result.rows));
            return;
        }
        const nodes: HTMLElement[] = [];
        for (const group of groupByTag(result.rows)) {
            nodes.push(makeGroupHeader(group.tag, group.rows.length));
            if (!collapsed.has(group.tag)) { nodes.push(...buildRows(group.rows)); }
        }
        bodyEl.replaceChildren(...nodes);
    }

    return {
        element,
        render: (result) => renderInto(result),
        setGroupByType: (grouped) => setMode(grouped, false),
    };
}
