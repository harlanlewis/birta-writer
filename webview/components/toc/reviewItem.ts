/**
 * The row primitive shared by the review sidebar's Proofreading and Notes tabs.
 * Deliberately ToC-plain (a tag chip + a one-line label, not a Grammarly card):
 * clicking the row navigates; per-row actions (Ignore, and Learn for spelling)
 * sit at the trailing edge, revealed on hover like the gutter handles.
 *
 * The navigation anchor (from/to) lives on the element's dataset, not in the
 * click closure, so `reviewList` can sync a shifted anchor onto a surviving row
 * without rebuilding it (mirrors how the Contents outline re-anchors its rows).
 */
import { applyTooltip } from "@/ui/tooltip";

export interface ReviewAction {
    label: string;
    /** Tooltip / aria description. */
    title?: string;
    run: () => void;
}

export interface ReviewRowSpec {
    /** Short category chip (e.g. "Spelling", "TK", a custom marker). */
    tag: string;
    /** One-line label — the flagged text, or a note's spec/context. */
    label: string;
    /** Hover explanation for the label (the finding's advice, say). */
    title?: string;
    /** Document range this row reveals; seeded into the dataset, synced in place. */
    from: number;
    to: number;
    /** Reveal the row's CURRENT anchor (read from the dataset at click time). */
    navigate: (from: number, to: number) => void;
    actions: ReviewAction[];
    /** Optional [start,end) offsets within `label` to mark as the flagged span. */
    emphasis?: { start: number; end: number };
}

export function buildReviewItem(spec: ReviewRowSpec): HTMLElement {
    const item = document.createElement("div");
    item.className = "review-item";
    item.dataset["from"] = String(spec.from);
    item.dataset["to"] = String(spec.to);

    const main = document.createElement("button");
    main.className = "review-item__main";
    main.tabIndex = -1;

    const tag = document.createElement("span");
    tag.className = "review-item__tag";
    tag.textContent = spec.tag;

    const label = document.createElement("span");
    label.className = "review-item__label";
    const emph = spec.emphasis;
    if (emph && emph.start >= 0 && emph.end <= spec.label.length && emph.start < emph.end) {
        // Mark the flagged span within a context snippet so the row shows WHAT is
        // flagged, not just where.
        const flag = document.createElement("span");
        flag.className = "review-item__flag";
        flag.textContent = spec.label.slice(emph.start, emph.end);
        label.append(
            document.createTextNode(spec.label.slice(0, emph.start)),
            flag,
            document.createTextNode(spec.label.slice(emph.end)),
        );
    } else {
        label.textContent = spec.label;
    }
    if (spec.title) { applyTooltip(label, spec.title, { placement: "above", truncatedOnly: false }); }

    main.append(tag, label);
    main.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    main.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Read the anchor from the DOM, never from `spec`: a signature-stable row
        // outlives the snapshot that built it, so its dataset is the live target.
        spec.navigate(Number(item.dataset["from"]), Number(item.dataset["to"]));
    });
    item.appendChild(main);

    if (spec.actions.length > 0) {
        const actions = document.createElement("div");
        actions.className = "review-item__actions";
        for (const action of spec.actions) {
            const btn = document.createElement("button");
            btn.className = "review-item__action";
            btn.textContent = action.label;
            btn.tabIndex = -1;
            if (action.title) { applyTooltip(btn, action.title, { placement: "above" }); }
            // Actions never navigate: stop the click from reaching the row body.
            btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
            btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); action.run(); });
            actions.appendChild(btn);
        }
        item.appendChild(actions);
    }

    return item;
}

/** The shared empty/disabled placeholder row. */
export function buildReviewEmpty(message: string): HTMLElement {
    const empty = document.createElement("div");
    empty.className = "review-empty";
    empty.textContent = message;
    return empty;
}
