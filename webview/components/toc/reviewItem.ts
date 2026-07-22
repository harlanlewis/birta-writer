/**
 * The row primitive shared by the review sidebar's Proofreading and Notes tabs.
 * Deliberately ToC-plain (a tag chip + a one-line label, not a Grammarly card):
 * clicking the row navigates; per-row actions (Ignore, and Learn for spelling)
 * sit at the trailing edge, revealed on hover like the gutter handles.
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
    /** Navigate to the row's document range. */
    open: () => void;
    actions: ReviewAction[];
}

export function buildReviewItem(spec: ReviewRowSpec): HTMLElement {
    const item = document.createElement("div");
    item.className = "review-item";

    const main = document.createElement("button");
    main.className = "review-item__main";
    main.tabIndex = -1;

    const tag = document.createElement("span");
    tag.className = "review-item__tag";
    tag.textContent = spec.tag;

    const label = document.createElement("span");
    label.className = "review-item__label";
    label.textContent = spec.label;
    if (spec.title) { applyTooltip(label, spec.title, { placement: "above", truncatedOnly: false }); }

    main.append(tag, label);
    main.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    main.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); spec.open(); });
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
