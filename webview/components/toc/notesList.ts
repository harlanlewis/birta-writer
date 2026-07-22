/**
 * The review sidebar's Notes tab: a flat, document-ordered list of editor-note
 * markers ([TK], TODO:, FIXME:, HTML comments, unchecked checkboxes, and custom
 * strings) surfaced by the pure scanner in webview/notes/scan.ts. Each row is
 * navigable; each can be Ignored for the session (matching the Proofreading
 * tab's Ignore semantics). Navigation only, no in-text decoration.
 *
 * The scan is kept off the per-keystroke hot path by an incremental cache: an
 * inline edit re-scans only its block (incrementalScanNotes), and the shared
 * review list skips the DOM rebuild when the visible notes are unchanged.
 */
import type { EditorView, Node as ProseNode } from "@/pm";
import { t } from "@/i18n";
import { notifyReviewGroupByType } from "@/messaging";
import { scanNotes, incrementalScanNotes, type NoteItem } from "@/notes/scan";
import { initReviewList, type ReviewResult } from "./reviewList";
import type { ReviewListView } from "./proofreadingList";

export interface NotesListView extends ReviewListView {
    /** Update the custom-marker set (birta.notes.customMarkers changed). */
    setMarkers: (markers: readonly string[]) => void;
}

/** The chip for each kind; a custom marker shows its own string. */
function noteTag(item: NoteItem): string {
    switch (item.kind) {
        case "placeholder": return "TK";
        case "todo": return "TODO";
        case "fixme": return "FIXME";
        case "comment": return t("Note");
        case "task": return t("Task");
        case "custom": return item.marker;
    }
}

// Field separator for the session ignore key. A NUL (U+0000) keeps the key
// injective: none of kind/marker/label can contain it, so a custom marker
// holding a space ("draft note") can't collapse two distinct notes into one
// ignore identity. BUILT AT RUNTIME rather than written as a literal or an
// escape: an invisible control byte in the source makes the whole file read as
// BINARY to git/grep (no line diffs) while rendering as an innocent space in
// every editor, so the source stays pure printable ASCII and the byte exists
// only in the running string. (Same injectivity motive as SIG_FIELD in ./index.ts.)
const IGNORE_SEP = String.fromCharCode(0);

/** Session-scoped ignore key: matches by identity (kind + marker + label), so
 *  ignoring "TODO: write intro" hides that note but not "TODO: add refs". */
function ignoreKey(item: NoteItem): string {
    return [item.kind, item.marker, item.label].join(IGNORE_SEP);
}

export function initNotesList(getView: () => EditorView | null): NotesListView {
    const list = initReviewList("review-list review-list--notes", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
        onToggleGroupByType: notifyReviewGroupByType,
    });

    let markers: readonly string[] = window.__i18n?.notesCustomMarkers ?? [];
    // Session-only, like the proofread popup's Ignore: cleared on reload.
    const ignored = new Set<string>();

    // Incremental-scan cache: the doc the cached items were scanned from, and
    // those items (UNFILTERED — the ignore filter is applied per render).
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
        const items = scan(view.state.doc).filter((i) => !ignored.has(ignoreKey(i)));
        if (items.length === 0) { return { empty: t("No notes") }; }
        return {
            rows: items.map((item) => ({
                tag: noteTag(item),
                label: item.label || noteTag(item),
                from: item.from,
                to: item.to,
                actions: [{
                    label: t("Ignore"),
                    run: () => { ignored.add(ignoreKey(item)); refresh(getView()); },
                }],
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

    return { element: list.element, refresh, setMarkers, setGroupByType: list.setGroupByType };
}
