/**
 * The review sidebar's Links tab: a flat, document-ordered list of every link in
 * the document (inline, autolink, reference, wikilink), surfaced by the pure
 * scanner in webview/links/scan.ts. A row click jumps to the link in the
 * document; a hover **Open** action follows the link directly (same routing as
 * the link popup's open button), so the sidebar isn't just a scroll-to. The URL
 * shows inline right of the title on hover — not a tooltip — so a list can be
 * audited by sweeping the pointer down it. Grouping (By type = destination),
 * In-order sort, show-more, and keyboard nav come from the shared reviewList.
 */
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { notifyOpenFile, notifyOpenUrl, notifyReviewGroupByType } from "@/messaging";
import { scanLinksCached, type LinkItem, type LinkKind } from "@/links/scan";
import { initReviewList, type ReviewResult } from "./reviewList";
import type { ReviewListView } from "./proofreadingList";

export interface LinksListView extends ReviewListView {
    /** Number of links in this doc (cached per doc version; safe on idle). */
    count: (view: EditorView) => number;
}

/** Group label + By-type order per destination kind. Order rationale: external
 *  links first (the ones to verify before publish — they rot and mislead), then
 *  workspace files, then in-document jumps, then email. */
const KIND: Record<LinkKind, { tag: string; rank: number }> = {
    web: { tag: "Web", rank: 0 },
    local: { tag: "Local files", rank: 1 },
    doc: { tag: "This document", rank: 2 },
    email: { tag: "Email", rank: 3 },
};

/** Follow the link — the same routing the link popup's open button uses. */
function openLink(link: LinkItem): void {
    if (link.wiki) { notifyOpenFile(link.href, { wiki: true }); return; }
    if (link.kind === "web" || link.kind === "email") { notifyOpenUrl(link.href); return; }
    notifyOpenFile(link.href);
}

function produce(view: EditorView | null): ReviewResult {
    if (!view) { return null; }
    const links = scanLinksCached(view.state.doc);
    if (links.length === 0) { return { empty: t("No links") }; }
    return {
        rows: links.map((link: LinkItem) => ({
            tag: t(KIND[link.kind].tag),
            // Prefer the human text; fall back to the target for a bare URL.
            label: link.text || link.href,
            // The destination, inline on hover. Skipped when the label IS the
            // URL (a bare autolink) — repeating it says nothing.
            meta: link.text && link.text !== link.href ? link.href : undefined,
            rank: KIND[link.kind].rank,
            from: link.from,
            to: link.to,
            // Open follows the link. An in-document `#fragment` is the one kind
            // with nowhere to "open" beyond the doc itself — its row click
            // already navigates — so it carries no action.
            actions: link.kind === "doc" ? [] : [{
                label: t("Open"),
                title: link.href,
                run: () => openLink(link),
            }],
        })),
    };
}

export function initLinksList(getView: () => EditorView | null): LinksListView {
    const list = initReviewList("review-list review-list--links", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
        onToggleGroupByType: notifyReviewGroupByType,
    });
    return {
        element: list.element,
        refresh: (view) => list.render(produce(view)),
        setGroupByType: list.setGroupByType,
        count: (view) => scanLinksCached(view.state.doc).length,
    };
}
