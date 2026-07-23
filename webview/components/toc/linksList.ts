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
import { collectDocHeadings } from "@/utils/headingUtils";
import { slugify } from "@/utils/slug";
import { initReviewList, type ReviewResult } from "./reviewList";
import { revealRange } from "./navigate";
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

/** Follow an in-document `#fragment` to its heading: match by slug (markdown
 *  anchors are slugs) or, failing that, by heading text (the wikilink
 *  `[[#Heading Text]]` form), then reveal it. */
function followDocAnchor(view: EditorView, href: string): void {
    const fragment = decodeURIComponent(href.replace(/^#/, "")).trim();
    if (!fragment) { return; }
    const want = slugify(fragment);
    const heading = collectDocHeadings(view.state.doc).find(
        (h) => slugify(h.text) === want || h.text.trim().toLowerCase() === fragment.toLowerCase(),
    );
    if (heading) { revealRange(view, heading.pos + 1, heading.pos + 1); }
}

/** Follow the link — the same routing the link popup's open button uses; an
 *  in-document fragment resolves to its heading instead. */
function openLink(view: EditorView | null, link: LinkItem): void {
    if (link.kind === "doc") { if (view) { followDocAnchor(view, link.href); } return; }
    if (link.wiki) { notifyOpenFile(link.href, { wiki: true }); return; }
    if (link.kind === "web" || link.kind === "email") { notifyOpenUrl(link.href); return; }
    notifyOpenFile(link.href);
}

function produce(view: EditorView | null, getView: () => EditorView | null): ReviewResult {
    if (!view) { return null; }
    const links = scanLinksCached(view.state.doc);
    if (links.length === 0) { return { empty: t("No links") }; }
    return {
        rows: links.map((link: LinkItem) => {
            const follow = (): void => openLink(getView(), link);
            return {
                tag: t(KIND[link.kind].tag),
                // Prefer the human text; fall back to the target for a bare URL.
                label: link.text || link.href,
                // The destination, inline on hover — and itself clickable: the
                // URL text FOLLOWS the link, the row body navigates to its place
                // in the document. Always present, even when the label IS the
                // URL — it is the visible follow-the-link affordance.
                meta: link.href,
                onMeta: follow,
                rank: KIND[link.kind].rank,
                from: link.from,
                to: link.to,
                // Open follows the link too — for an in-document `#fragment`
                // that means jumping to the targeted heading.
                actions: [{
                    label: t("Open"),
                    title: link.href,
                    run: follow,
                }],
            };
        }),
    };
}

export function initLinksList(getView: () => EditorView | null): LinksListView {
    const list = initReviewList("review-list review-list--links", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
        onToggleGroupByType: notifyReviewGroupByType,
    });
    return {
        element: list.element,
        refresh: (view) => list.render(produce(view, getView)),
        setGroupByType: list.setGroupByType,
        count: (view) => scanLinksCached(view.state.doc).length,
    };
}
