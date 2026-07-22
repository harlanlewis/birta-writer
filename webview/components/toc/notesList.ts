/**
 * The review sidebar's Notes tab: a flat, document-ordered list of editor-note
 * markers ([TK], TODO:, FIXME:, HTML comments, and custom strings) surfaced by
 * the pure scanner in webview/notes/scan.ts. Each row is navigable. Navigation
 * only, no in-text decoration — and deliberately NO per-row dismiss: a note is
 * document content (like a heading in the outline), so the way to clear one is
 * to edit the document, not to hide the row.
 *
 * The scan is kept off the per-keystroke hot path by an incremental cache: an
 * inline edit re-scans only its block (incrementalScanNotes), and the shared
 * review list skips the DOM rebuild when the visible notes are unchanged. The
 * same cache backs `count()`, which the shell's idle-time tab-visibility check
 * reads — so visibility costs one cached lookup, not a scan.
 */
import type { EditorView, Node as ProseNode } from "@/pm";
import { t } from "@/i18n";
import { scanNotes, incrementalScanNotes, type NoteItem } from "@/notes/scan";
import { initReviewList, type ReviewResult } from "./reviewList";
import type { ReviewListView } from "./proofreadingList";

export interface NotesListView extends ReviewListView {
    /** Update the custom-marker set (birta.notes.customMarkers changed). */
    setMarkers: (markers: readonly string[]) => void;
    /** Number of notes in this doc (cached/incremental; safe to call on idle). */
    count: (view: EditorView) => number;
}

/** The chip for each kind; a custom marker shows its own string. */
function noteTag(item: NoteItem): string {
    switch (item.kind) {
        case "placeholder": return "TK";
        case "todo": return "TODO";
        case "fixme": return "FIXME";
        case "comment": return t("HTML comments");
        case "custom": return item.marker;
    }
}

/** Group order for By-type: the built-in kinds in a fixed order, custom last. */
function noteRank(item: NoteItem): number {
    switch (item.kind) {
        case "placeholder": return 0;
        case "todo": return 1;
        case "fixme": return 2;
        case "comment": return 3;
        case "custom": return 4;
    }
}

export function initNotesList(getView: () => EditorView | null): NotesListView {
    const list = initReviewList("review-list review-list--notes", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
    });

    let markers: readonly string[] = window.__i18n?.notesCustomMarkers ?? [];

    // Incremental-scan cache: the doc the cached items were scanned from, and
    // those items.
    let scannedDoc: ProseNode | null = null;
    let scannedItems: NoteItem[] = [];

    function scan(doc: ProseNode): NoteItem[] {
        if (scannedDoc === doc) { return scannedItems; }
        const items = (scannedDoc && incrementalScanNotes(scannedDoc, scannedItems, doc, markers))
            || scanNotes(doc, markers);
        scannedDoc = doc;
        scannedItems = items;
        return items;
    }

    function produce(view: EditorView | null): ReviewResult {
        if (!view) { return null; }
        const items = scan(view.state.doc);
        if (items.length === 0) { return { empty: t("No notes") }; }
        return {
            rows: items.map((item) => ({
                tag: noteTag(item),
                label: item.label || noteTag(item),
                rank: noteRank(item),
                from: item.from,
                to: item.to,
                actions: [],
            })),
        };
    }

    function refresh(view: EditorView | null): void {
        list.render(produce(view));
    }

    function setMarkers(next: readonly string[]): void {
        markers = next;
        scannedDoc = null; // force a full rescan with the new marker set
    }

    return {
        element: list.element,
        refresh,
        setMarkers,
        setGroupByType: list.setGroupByType,
        count: (view) => scan(view.state.doc).length,
    };
}
