/**
 * The review sidebar's Proofreading tab: a flat, document-ordered list of every
 * live proofreading finding (style + spelling + grammar), each navigable, with
 * the same Ignore (and Learn, for spelling) actions the in-text popup offers.
 * It reads the proofread plugin's decoration set — no second analysis pass — so
 * it only ever costs work while this tab is the active one (the shell refreshes
 * only the visible view), and the shared review list skips the DOM rebuild when
 * the findings are unchanged (see reviewList).
 */
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { getProofreadConfig, listProofreadFindings } from "@/plugins/proofread";
import { initReviewList, type ReviewResult } from "./reviewList";

export interface ReviewListView {
    element: HTMLElement;
    /** Rebuild from the current document/decorations. */
    refresh: (view: EditorView | null) => void;
}

/** Resolve the tab's current contents: an explicit "off" state, an empty state,
 *  or the findings as rows. Pure read of the plugin — computes nothing new. */
function produce(view: EditorView | null): ReviewResult {
    if (!view) { return null; }
    if (!getProofreadConfig(view).proofreadingEnabled) {
        // A silent empty here would read as "all clear"; say it's off.
        return { empty: t("Proofreading is off") };
    }
    const findings = listProofreadFindings(view);
    if (findings.length === 0) { return { empty: t("No suggestions") }; }
    return {
        rows: findings.map((f) => ({
            tag: f.tag,
            label: f.text,
            title: f.message,
            from: f.from,
            to: f.to,
            actions: [
                ...(f.canLearn && f.learn ? [{ label: t("Learn"), title: t("Add to dictionary"), run: f.learn }] : []),
                { label: t("Ignore"), run: f.ignore },
            ],
        })),
    };
}

export function initProofreadingList(getView: () => EditorView | null): ReviewListView {
    const list = initReviewList("review-list review-list--proofread", getView);
    return {
        element: list.element,
        refresh: (view) => list.render(produce(view)),
    };
}
