/**
 * The review sidebar's Backlinks tab: every note in this document's folder
 * that points AT this one (MAR-479), the reverse of the Links tab beside it.
 *
 * Nothing here reads a file. The host walks the folder and resolves every
 * reference with the resolver a click uses (shared/folderIndex.ts), and this
 * tab lists the edges whose target is this document. So a row appears only
 * where a click on the link in the other note would land here.
 *
 * A row is about ANOTHER note, so activating it opens that note at the line
 * the reference is written on, rather than revealing a range in this one. By
 * type groups the rows by how the other note names this one: a Markdown link,
 * a wikilink, or an OKF `sources` entry, which is a claim that this note is
 * where the other one's content came from.
 */
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { notifyReviewGroupByType } from "@/messaging";
import type { NoteLinkKind } from "../../../shared/noteLinks";
import { currentBacklinks, openIndexedNote, readFolderIndex } from "@/links/folderIndex";
import { initReviewList, type ReviewResult, type ReviewRowModel } from "./reviewList";
import type { ReviewListView } from "./proofreadingList";

export interface BacklinksListView extends ReviewListView {
    /** Backlinks the latest index holds; asks the host for the index on first call. */
    count: () => number;
}

/** Group label and By-type order per way of naming a note. */
const KIND: Record<NoteLinkKind, { tag: string; rank: number }> = {
    link: { tag: "Links", rank: 0 },
    wiki: { tag: "Wikilinks", rank: 1 },
    source: { tag: "Sources", rank: 2 },
};

function produce(): ReviewResult {
    const state = readFolderIndex();
    if (!state?.index || state.self === null) { return { empty: t("No backlinks") }; }
    const { index, self } = state;
    const names = new Map(index.nodes.map((n) => [n.path, n.name]));
    const edges = currentBacklinks();
    if (edges.length === 0) {
        // A walk that stopped at its cap may simply not have reached the note
        // that links here, so the empty state says which absence this is.
        return { empty: index.truncated ? t("No backlinks among the notes this folder's index reached") : t("No backlinks") };
    }
    return {
        rows: edges.map((edge): ReviewRowModel => {
            const open = (): void => { openIndexedNote(self, edge.from, edge.line); };
            return {
                tag: t(KIND[edge.kind].tag),
                rank: KIND[edge.kind].rank,
                label: names.get(edge.from) ?? edge.from,
                title: edge.from,
                // What the other note says where it names this one.
                meta: edge.text || edge.target,
                onMeta: open,
                from: 0,
                to: 0,
                onActivate: open,
                actions: [{ label: t("Open"), title: edge.from, run: open }],
            };
        }),
    };
}

export function initBacklinksList(getView: () => EditorView | null): BacklinksListView {
    const list = initReviewList("review-list review-list--backlinks", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
        onToggleGroupByType: notifyReviewGroupByType,
    });
    return {
        element: list.element,
        refresh: () => list.render(produce()),
        setGroupByType: list.setGroupByType,
        focusFirst: list.focusFirst,
        count: () => currentBacklinks().length,
    };
}
