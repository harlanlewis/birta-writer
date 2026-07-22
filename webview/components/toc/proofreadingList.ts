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
import { styleCategoryRank } from "@/utils/styleCategories";
import { initReviewList, type ReviewResult } from "./reviewList";

export interface ReviewListView {
    element: HTMLElement;
    /** Rebuild from the current document/decorations. */
    refresh: (view: EditorView | null) => void;
    /** Apply a birta.review.groupByType change (settings echo). */
    setGroupByType: (grouped: boolean) => void;
}

type Label = { label: string; emphasis?: { start: number; end: number } };

/** A surrounding-context label with the flagged span marked, built within the
 *  finding's own block (so offsets stay 1:1). For findings whose flagged text
 *  can't identify itself — a lone em dash, a curly quote — this shows both where
 *  the finding is and WHAT is flagged, instead of 30 identical "—" rows. */
function contextLabel(view: EditorView, from: number, to: number): Label {
    const $from = view.state.doc.resolve(from);
    const blockStart = $from.start();
    const blockEnd = $from.end();
    const winA = Math.max(blockStart, from - 28);
    const winB = Math.min(blockEnd, to + 28);
    let before = view.state.doc.textBetween(winA, from, " ", " ").replace(/\s+/g, " ");
    const flag = view.state.doc.textBetween(from, to, " ", " ").replace(/\s+/g, " ");
    let after = view.state.doc.textBetween(to, winB, " ", " ").replace(/\s+/g, " ");
    // Trim a partial word at each cut edge; add an ellipsis when we cut.
    before = winA > blockStart ? "…" + before.replace(/^\s*\S*\s+/, "") : before.replace(/^\s+/, "");
    after = winB < blockEnd ? after.replace(/\s+\S*\s*$/, "") + "…" : after.replace(/\s+$/, "");
    const label = before + flag + after;
    if (!flag) { return { label }; }
    return { label, emphasis: { start: before.length, end: before.length + flag.length } };
}

/** The row label: the flagged text itself when it's a recognizable word/phrase
 *  (spelling, a filler), else a context label with the flag marked. */
function labelFor(view: EditorView, text: string, from: number, to: number): Label {
    const trimmed = text.trim();
    const informative = trimmed.length >= 2 && /[\p{L}\p{N}]/u.test(trimmed);
    if (informative) { return { label: text }; }
    const ctx = contextLabel(view, from, to);
    return ctx.label ? ctx : { label: text };
}

/** Correctness-first group order: spelling, then grammar, then style categories
 *  in the shared canonical order (which the toolbar Checks menu also reads). */
function proofreadRank(f: { domain: "spelling" | "grammar" | "style"; kind: string }): number {
    if (f.domain === "spelling") { return 0; }
    if (f.domain === "grammar") { return 1; }
    return 2 + styleCategoryRank(f.kind);
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
        rows: findings.map((f) => {
            const { label, emphasis } = labelFor(view, f.text, f.from, f.to);
            return {
                tag: f.tag,
                label,
                emphasis,
                title: f.message,
                rank: proofreadRank(f),
                from: f.from,
                to: f.to,
                actions: [
                    ...(f.canLearn && f.learn ? [{ label: t("Learn"), title: t("Add to dictionary"), run: f.learn }] : []),
                    { label: t("Ignore"), run: f.ignore },
                ],
            };
        }),
    };
}

export function initProofreadingList(getView: () => EditorView | null): ReviewListView {
    const list = initReviewList("review-list review-list--proofread", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
    });
    return {
        element: list.element,
        refresh: (view) => list.render(produce(view)),
        setGroupByType: list.setGroupByType,
    };
}
