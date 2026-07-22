/**
 * The review sidebar's Proofreading tab: a flat, document-ordered list of every
 * live proofreading finding (style + spelling + grammar), each navigable, with
 * the same Ignore (and Learn, for spelling) actions the in-text popup offers.
 * It reads the proofread plugin's decoration set — no second analysis pass — so
 * it only ever costs work while this tab is the active one (the shell refreshes
 * only the visible view).
 */
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { getProofreadConfig, listProofreadFindings } from "@/plugins/proofread";
import { revealRange } from "./navigate";
import { buildReviewItem, buildReviewEmpty } from "./reviewItem";

export interface ReviewListView {
    element: HTMLElement;
    /** Rebuild from the current document/decorations. */
    refresh: (view: EditorView | null) => void;
}

export function initProofreadingList(getView: () => EditorView | null): ReviewListView {
    const element = document.createElement("div");
    element.className = "review-list review-list--proofread";

    function refresh(view: EditorView | null): void {
        element.replaceChildren();
        if (!view) { return; }
        const config = getProofreadConfig(view);
        if (!config.proofreadingEnabled) {
            // A silent empty here would read as "all clear"; say it's off.
            element.appendChild(buildReviewEmpty(t("Proofreading is off")));
            return;
        }
        const rows = listProofreadFindings(view);
        if (rows.length === 0) {
            element.appendChild(buildReviewEmpty(t("No suggestions")));
            return;
        }
        for (const row of rows) {
            const actions = [];
            if (row.canLearn && row.learn) {
                const learn = row.learn;
                actions.push({ label: t("Learn"), title: t("Add to dictionary"), run: learn });
            }
            actions.push({ label: t("Ignore"), run: row.ignore });
            element.appendChild(buildReviewItem({
                tag: row.tag,
                label: row.text,
                title: row.message,
                open: () => { const v = getView(); if (v) { revealRange(v, row.from, row.to); } },
                actions,
            }));
        }
    }

    return { element, refresh };
}
