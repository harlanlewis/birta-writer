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
import { notifyReviewGroupByType } from "@/messaging";
import { getProofreadConfig, listProofreadFindings } from "@/plugins/proofread";
import { initReviewList, type ReviewResult } from "./reviewList";

export interface ReviewListView {
    element: HTMLElement;
    /** Rebuild from the current document/decorations. */
    refresh: (view: EditorView | null) => void;
    /** Apply a birta.review.groupByType change (settings echo). */
    setGroupByType: (grouped: boolean) => void;
}

/** A short surrounding-context snippet, for findings whose flagged text can't
 *  identify itself — a lone em dash, a curly quote, a stray comma. Without this,
 *  the "Em dash" group is 30 identical "—" rows. */
function contextSnippet(view: EditorView, from: number, to: number): string {
    const size = view.state.doc.content.size;
    const a = Math.max(0, from - 28);
    const b = Math.min(size, to + 28);
    let raw = view.state.doc.textBetween(a, b, " ", " ").replace(/\s+/g, " ");
    // Drop a partial word at each cut edge so the snippet starts/ends cleanly.
    if (a > 0) { raw = raw.replace(/^\S*\s+/, ""); }
    if (b < size) { raw = raw.replace(/\s+\S*$/, ""); }
    raw = raw.trim();
    if (!raw) { return ""; }
    return (a > 0 ? "…" : "") + raw + (b < size ? "…" : "");
}

/** The row label: the flagged text when it's a recognizable word/phrase, else a
 *  surrounding snippet so short/punctuation findings stay distinguishable. */
function labelFor(view: EditorView, text: string, from: number, to: number): string {
    const trimmed = text.trim();
    const informative = trimmed.length >= 2 && /[\p{L}\p{N}]/u.test(trimmed);
    return informative ? text : (contextSnippet(view, from, to) || text);
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
            label: labelFor(view, f.text, f.from, f.to),
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
    const list = initReviewList("review-list review-list--proofread", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
        onToggleGroupByType: notifyReviewGroupByType,
    });
    return {
        element: list.element,
        refresh: (view) => list.render(produce(view)),
        setGroupByType: list.setGroupByType,
    };
}
