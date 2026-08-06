/**
 * The shared body of the review sidebar's Proofreading and Notes tabs. Both are
 * the same thing: a flat, document-ordered list of tagged rows, each navigable,
 * with hover actions — differing only in what they collect (findings vs note
 * markers) and their empty-state copy. This owns the parts they share:
 *
 *   - the "By type / In order" toggle. "By type" groups rows under a
 *     collapsible type header, ordered by a per-row rank the adapter sets
 *     (correctness first for proofreading); "In order" is the flat
 *     document-ordered list. The mode is one shared persisted setting
 *     (birta.review.groupByType) across all review tabs.
 *   - per-group SHOW-MORE: a big group shows the first N rows and a
 *     "Show K more" toggle, so no single category walls off the rest.
 *   - the scrolling container + empty state;
 *   - a SIGNATURE DIFF so a rebuild happens only when the visible rows actually
 *     change. Ordinary typing shifts every anchor but changes no row's display,
 *     so the common case is an in-place anchor sync (dataset write per surviving
 *     row) with zero DOM teardown.
 *
 * An adapter calls `render(result)` each refresh; producing the `result` (the
 * scan / finding read) is the adapter's job.
 */
import { bindActivate } from "@/ui/dom";
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { revealRange } from "./navigate";
import { wireRoving } from "./keyboardNav";
import { buildReviewItem, buildReviewEmpty, type ReviewAction } from "./reviewItem";

/** One row model the adapter hands in; identity/display drives the signature,
 *  from/to are the (frequently shifting) navigation anchor, `tag` is the type. */
export interface ReviewRowModel {
    tag: string;
    label: string;
    title?: string;
    /** Secondary detail (a link's URL) shown right of the label on row hover. */
    meta?: string;
    /** Makes the meta text itself clickable (follow the URL) — distinct from
     *  the row click, which navigates to the link's place in the document. */
    onMeta?: () => void;
    from: number;
    to: number;
    actions: ReviewAction[];
    /** By-type group order: groups sort by their rows' min rank (lower = first),
     *  ties broken by first appearance. Default 0. */
    rank?: number;
    /** Optional [start,end) offsets within `label` to emphasize (the flagged
     *  span, for a context-snippet label). */
    emphasis?: { start: number; end: number };
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
    /** Move focus onto the list body's first row — the deliberate keyboard
     *  entry into this view (MAR-294). A no-op on an empty list (the empty
     *  state has no focusable rows); the caller handles the fallback. */
    focusFirst: () => void;
}

// How many rows a By-type group shows before the "Show K more" toggle.
const GROUP_CAP = 6;

// Record/field/subfield separators for the render signature, built at runtime so
// no invisible control byte lands in this source file. Row text can't contain
// them, so the signature is injective.
const SEP_FIELD = String.fromCharCode(31);
const SEP_ROW = String.fromCharCode(30);
const SEP_SUB = String.fromCharCode(29);

/** The part of a row that, if changed, requires a DOM rebuild — everything the
 *  row DISPLAYS. Deliberately excludes from/to (synced in place). */
function rowSignature(row: ReviewRowModel): string {
    return [row.tag, row.label, row.title ?? "", row.meta ?? "", row.actions.map((a) => a.label).join(",")].join(SEP_FIELD);
}

/** Rows grouped by tag, groups ordered by their min rank (correctness-first, set
 *  by the adapter) with ties broken by first appearance; rows keep document
 *  order within each group. */
function groupByTag(rows: readonly ReviewRowModel[]): Array<{ tag: string; rows: ReviewRowModel[] }> {
    const map = new Map<string, { tag: string; rows: ReviewRowModel[]; rank: number; index: number }>();
    rows.forEach((row, i) => {
        let bucket = map.get(row.tag);
        if (!bucket) { bucket = { tag: row.tag, rows: [], rank: row.rank ?? 0, index: i }; map.set(row.tag, bucket); }
        bucket.rows.push(row);
    });
    return [...map.values()].sort((a, b) => a.rank - b.rank || a.index - b.index);
}

export function initReviewList(
    className: string,
    getView: () => EditorView | null,
    opts: {
        initialGroupByType: boolean;
        onToggleGroupByType: (grouped: boolean) => void;
        /** A tab-specific control pinned to the toolbar's trailing edge (the
         *  Notes tab's in-text highlight toggle). Owned by the adapter. */
        trailing?: HTMLElement;
    },
): ReviewListRenderer {
    const element = document.createElement("div");
    element.className = className;

    let groupByType = opts.initialGroupByType;
    // Session-scoped view state (not persisted): which groups are collapsed, and
    // which are expanded past the GROUP_CAP.
    const collapsed = new Set<string>();
    const expanded = new Set<string>();
    let lastResult: ReviewResult = null;
    let renderedSignature: string | null = null;

    // ── The sort toggle (persistent chrome, built once) ───────────────────
    // role=toolbar + roving tabindex is the APG toolbar pattern verbatim: one Tab
    // stop for the whole row, Left/Right walk it, Enter/Space activate. It is the
    // same shape the tab strip above and the list below already use — one group
    // per region rather than one tab stop per button (MAR-291).
    const toolbar = document.createElement("div");
    toolbar.className = "review-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-orientation", "horizontal");
    toolbar.setAttribute("aria-label", t("Review list options"));
    const segGroup = document.createElement("div");
    segGroup.className = "review-segmented";
    // A plain grouping, deliberately NOT role=radiogroup: a radiogroup's arrows
    // are expected to SELECT as they move, which would fight the toolbar's
    // move-then-activate contract and flip the whole list on the way past to the
    // trailing switch. The price, paid knowingly: two aria-pressed toggle buttons
    // don't announce that they're mutually EXCLUSIVE — a reader learns that by
    // pressing one. Worth it to keep one arrow contract across the whole row.
    segGroup.setAttribute("role", "group");
    segGroup.setAttribute("aria-label", t("Sort order"));
    const segByType = makeSeg(t("By type"), true);
    const segInOrder = makeSeg(t("In order"), false);
    segGroup.append(segByType, segInOrder);
    toolbar.append(segGroup);
    if (opts.trailing) { toolbar.append(opts.trailing); }
    const bodyEl = document.createElement("div");
    bodyEl.className = "review-body";
    bodyEl.setAttribute("role", "listbox");
    element.append(toolbar, bodyEl);

    function makeSeg(label: string, grouped: boolean): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.className = "ui-btn review-seg";
        btn.textContent = label;
        // Tabbability is the roving group's to hand out (wireRoving below).
        btn.tabIndex = -1;
        bindActivate(btn, () => {
            setMode(grouped, true);
        });
        return btn;
    }
    function updateSegActive(): void {
        segByType.classList.toggle("review-seg--active", groupByType);
        segInOrder.classList.toggle("review-seg--active", !groupByType);
        // The active-state channel a screen reader reads; the class is only paint.
        segByType.setAttribute("aria-pressed", String(groupByType));
        segInOrder.setAttribute("aria-pressed", String(!groupByType));
    }
    updateSegActive();

    // The toolbar row's own group: every <button> in it, in DOM (= visual) order,
    // so an adapter's trailing control joins without knowing this exists.
    wireRoving({
        container: toolbar,
        items: () => [...toolbar.querySelectorAll<HTMLElement>("button")],
        orientation: "horizontal",
        onEscape: () => getView()?.focus(),
    });

    /** The roving items currently in the body, in DOM order — group headers,
     *  row bodies, and show-more toggles. Shared by the keyboard group and the
     *  rebuild focus restore below. */
    const bodyItems = (): HTMLElement[] =>
        [...bodyEl.querySelectorAll<HTMLElement>(".review-group, .review-item__main, .review-more")];

    // Keyboard navigation: arrow through the group headers, rows, and show-more
    // toggles; Enter activates (all are <button>s); Escape returns to the editor.
    const roving = wireRoving({
        container: bodyEl,
        items: bodyItems,
        onEscape: () => getView()?.focus(),
        // MAR-295: ArrowRight from a row body enters its trailing action
        // cluster (Ignore / Learn) — a horizontal spur off the vertical list.
        // The cluster's own keys are handled below; its buttons stay at
        // tabIndex -1, so the list keeps exactly one Tab stop.
        onHorizontal: (item, dir) => dir === 1 && enterRowActions(item),
    });

    /** Focus the first trailing action of the row whose body is `item`; false
     *  when the row has none (Notes rows), letting the arrow fall through. */
    function enterRowActions(item: HTMLElement): boolean {
        if (!item.classList.contains("review-item__main")) { return false; }
        const first = item.parentElement?.querySelector<HTMLElement>(".review-item__action");
        if (!first) { return false; }
        first.focus();
        return true;
    }

    // Keys while focus sits INSIDE an action cluster. Left/Right walk the
    // cluster, with ArrowLeft at the first action returning to the row body;
    // Up/Down first re-target the row body and then fall through to the roving
    // handler (which reads document.activeElement at handler time), so they
    // step the LIST from this row rather than jumping to its first item.
    // Capture phase: the target is a descendant of bodyEl, so this runs before
    // wireRoving's bubble-phase handler and can stop what it fully handled.
    bodyEl.addEventListener("keydown", (e) => {
        const target = e.target as HTMLElement;
        if (!(target instanceof HTMLElement) || !target.classList.contains("review-item__action")) { return; }
        const row = target.closest<HTMLElement>(".review-item");
        if (!row) { return; }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            const actions = [...row.querySelectorAll<HTMLElement>(".review-item__action")];
            const i = actions.indexOf(target);
            if (e.key === "ArrowRight") {
                actions[Math.min(actions.length - 1, i + 1)]?.focus(); // clamp at the end
            } else if (i > 0) {
                actions[i - 1]?.focus();
            } else {
                row.querySelector<HTMLElement>(".review-item__main")?.focus();
            }
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            row.querySelector<HTMLElement>(".review-item__main")?.focus();
        }
    }, true);

    /** Switch modes and re-render. `persist` distinguishes a user click (echo
     *  the setting) from an external settings echo (already persisted). */
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

    /** The rows shown for a group given the cap + its expanded state. */
    function shownRows(group: { tag: string; rows: ReviewRowModel[] }): ReviewRowModel[] {
        return expanded.has(group.tag) ? group.rows : group.rows.slice(0, GROUP_CAP);
    }

    /** The rows currently ON SCREEN, in DOM order — flat rows, or the (capped)
     *  rows of expanded groups. Kept in lockstep with renderInto for anchor sync. */
    function visibleRows(result: ReviewResult): ReviewRowModel[] {
        if (!result || "empty" in result) { return []; }
        if (!groupByType) { return result.rows; }
        return groupByTag(result.rows)
            .filter((g) => !collapsed.has(g.tag))
            .flatMap((g) => shownRows(g));
    }

    function signatureOf(result: ReviewResult): string {
        if (result === null) { return SEP_FIELD + "null"; }
        if ("empty" in result) { return SEP_FIELD + "empty" + SEP_FIELD + result.empty; }
        if (!groupByType) {
            return "F" + result.rows.map(rowSignature).join(SEP_ROW);
        }
        return "G" + groupByTag(result.rows).map((g) => {
            const isCollapsed = collapsed.has(g.tag);
            const rows = isCollapsed ? [] : shownRows(g);
            const head = [g.tag, g.rows.length, isCollapsed ? "c" : "e", expanded.has(g.tag) ? "x" : "-"].join(SEP_FIELD);
            return head + SEP_FIELD + rows.map(rowSignature).join(SEP_SUB);
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

    function makeGroupHeader(tag: string): HTMLElement {
        const header = document.createElement("button");
        header.className = "review-group";
        header.tabIndex = -1;
        const isCollapsed = collapsed.has(tag);
        header.classList.toggle("review-group--collapsed", isCollapsed);
        header.setAttribute("aria-expanded", String(!isCollapsed));

        const caret = document.createElement("span");
        caret.className = "review-group__caret";
        const name = document.createElement("span");
        // ui-heading: the shared chrome heading grade (matches a ToC H1).
        name.className = "review-group__name ui-heading";
        name.textContent = tag;
        header.append(caret, name);

        bindActivate(header, () => {
            if (collapsed.has(tag)) { collapsed.delete(tag); } else { collapsed.add(tag); }
            renderedSignature = null;
            renderInto(lastResult);
        });
        return header;
    }

    /** The "Show K more" / "Show less" toggle at the tail of a capped group. */
    function makeShowMore(tag: string, hidden: number): HTMLElement {
        const btn = document.createElement("button");
        btn.className = "review-more";
        btn.tabIndex = -1;
        btn.textContent = expanded.has(tag) ? t("Show less") : t("Show N more").replace("N", String(hidden));
        bindActivate(btn, () => {
            if (expanded.has(tag)) { expanded.delete(tag); } else { expanded.add(tag); }
            renderedSignature = null;
            renderInto(lastResult);
        });
        return btn;
    }

    function buildRows(rows: readonly ReviewRowModel[]): HTMLElement[] {
        return rows.map((row) => buildReviewItem({ ...row, navigate }));
    }

    /** The DOM nodes for a result — group headers, rows, and show-more toggles. */
    function buildNodes(result: ReviewResult): HTMLElement[] {
        if (result === null) { return []; }
        if ("empty" in result) { return [buildReviewEmpty(result.empty)]; }
        if (!groupByType) { return buildRows(result.rows); }
        const nodes: HTMLElement[] = [];
        for (const group of groupByTag(result.rows)) {
            nodes.push(makeGroupHeader(group.tag));
            if (collapsed.has(group.tag)) { continue; }
            nodes.push(...buildRows(shownRows(group)));
            if (group.rows.length > GROUP_CAP) {
                nodes.push(makeShowMore(group.tag, group.rows.length - GROUP_CAP));
            }
        }
        return nodes;
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
        // MAR-295 follow-up: a rebuild tears out the focused element — Enter
        // on Ignore removes the row under the keyboard — and focus would drop
        // to <body>. Capture where the keyboard was (an action button maps to
        // its row body) BEFORE the teardown, and put it back at the same index
        // in the fresh list, clamped to the new length. An emptied list falls
        // back to the editor, like every path where a region stops being
        // focusable. Focus outside the body (toolbar, editor) is untouched.
        const active = document.activeElement;
        const hadFocus = active instanceof HTMLElement && bodyEl.contains(active);
        const focusIdx = hadFocus
            ? bodyItems().indexOf(
                active.closest(".review-item")?.querySelector<HTMLElement>(".review-item__main") ?? active)
            : -1;
        bodyEl.replaceChildren(...buildNodes(result));
        roving.refresh(); // one tabbable item among the freshly built rows
        if (hadFocus) {
            const fresh = bodyItems();
            if (fresh.length > 0) {
                // The focusin listener carries the roving slot onto it.
                fresh[Math.min(fresh.length - 1, Math.max(0, focusIdx))]!.focus();
            } else {
                getView()?.focus();
            }
        }
    }

    return {
        element,
        render: (result) => renderInto(result),
        setGroupByType: (grouped) => setMode(grouped, false),
        focusFirst: () => roving.focusFirst(),
    };
}
