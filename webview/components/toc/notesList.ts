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
import { bindActivate } from "@/ui/dom";
import { notifyReviewGroupByType } from "@/messaging";
import { NOTE_HIGHLIGHT_EVENT, noteMarkersEnabled, setNoteMarkersEnabled } from "@/plugins/noteMarkers";
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
    // The in-text highlight toggle (birta.notes.highlightMarkers), pinned to the
    // trailing edge of this tab's sort row. This list is where a writer comes to
    // deal with their notes, so it is where the question "should these be marked
    // up in the prose too?" actually arises — the same flip as the toolbar's
    // Checks menu row, one click from the rows it affects. It wears the sort
    // toggle's own pill idiom (`.review-seg`), pressed = highlighting on, so it
    // reads as chrome of the same rank rather than a second kind of control.
    const highlightBtn = document.createElement("button");
    highlightBtn.className = "ui-btn review-seg review-trailing";
    highlightBtn.textContent = t("Highlight");
    // role=switch/aria-checked, not a bare aria-pressed button, so this announces
    // identically to the Checks menu's "Highlight note markers" row (createSwitchItem) —
    // one bit, one announcement, however many surfaces wear it. Tabbability comes
    // from the toolbar row's roving group in reviewList.ts.
    highlightBtn.setAttribute("role", "switch");
    highlightBtn.tabIndex = -1;
    highlightBtn.title = t("Mark these notes where they sit in the text (birta.notes.highlightMarkers)");
    const paintHighlight = (): void => {
        const on = noteMarkersEnabled();
        highlightBtn.classList.toggle("review-seg--active", on);
        highlightBtn.setAttribute("aria-checked", on ? "true" : "false");
    };
    paintHighlight();
    bindActivate(highlightBtn, () => {
        setNoteMarkersEnabled(getView(), !noteMarkersEnabled());
    });
    // Repaint from the plugin's re-gate, so this stays truthful when the flip
    // came from the Checks menu, the palette, or the Settings UI.
    window.addEventListener(NOTE_HIGHLIGHT_EVENT, paintHighlight);

    const list = initReviewList("review-list review-list--notes", getView, {
        initialGroupByType: window.__i18n?.reviewGroupByType ?? true,
        onToggleGroupByType: notifyReviewGroupByType,
        trailing: highlightBtn,
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
        focusFirst: list.focusFirst,
        count: (view) => scan(view.state.doc).length,
    };
}
