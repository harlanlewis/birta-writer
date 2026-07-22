/**
 * The review sidebar's Links tab: a flat, document-ordered list of every link in
 * the document (inline, autolink, reference, wikilink), surfaced by the pure
 * scanner in webview/links/scan.ts. Each row is navigable — click (or Enter)
 * jumps to the link in the document. Grouping (By type = destination kind),
 * In-order sort, show-more, and keyboard nav all come from the shared reviewList.
 */
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { notifyReviewGroupByType } from "@/messaging";
import { scanLinks, type LinkItem, type LinkKind } from "@/links/scan";
import { initReviewList, type ReviewResult } from "./reviewList";
import type { ReviewListView } from "./proofreadingList";

/** Group label + order (By-type) per destination kind. */
const KIND: Record<LinkKind, { tag: string; rank: number }> = {
    web: { tag: "Web", rank: 0 },
    local: { tag: "Local", rank: 1 },
    anchor: { tag: "Heading", rank: 2 },
    wikilink: { tag: "Wikilink", rank: 3 },
    email: { tag: "Email", rank: 4 },
};

function produce(view: EditorView | null): ReviewResult {
    if (!view) { return null; }
    const links = scanLinks(view.state.doc);
    if (links.length === 0) { return { empty: t("No links") }; }
    return {
        rows: links.map((link: LinkItem) => ({
            tag: t(KIND[link.kind].tag),
            // Prefer the human text; fall back to the target for a bare URL.
            label: link.text || link.href,
            title: link.href, // the destination, on hover
            rank: KIND[link.kind].rank,
            from: link.from,
            to: link.to,
            actions: [],
        })),
    };
}

export function initLinksList(getView: () => EditorView | null): ReviewListView {
    const list = initReviewList("review-list review-list--links", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
        onToggleGroupByType: notifyReviewGroupByType,
    });
    return {
        element: list.element,
        refresh: (view) => list.render(produce(view)),
        setGroupByType: list.setGroupByType,
    };
}
