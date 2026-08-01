/**
 * webview/plugins/noteMarkers.ts
 *
 * In-text highlighting for editor notes — the decoration complement to the
 * review sidebar's Notes tab. The tab (components/toc/notesList.ts) has always
 * been navigation-only, which means a writer scanning their own draft cannot
 * see their own `[TK]` placeholders without opening a panel. This paints them:
 * every text marker the pure scanner finds (webview/notes/scan.ts) gets a quiet
 * chip, one tint for every kind (see noteMarkers.css for the vocabulary).
 *
 * Only `source: "text"` items are decorated. An HTML comment already renders as
 * its own visibly distinct atom, and stacking a second visual channel onto it
 * would say the same thing twice (docs/DESIGN_PRINCIPLES.md).
 *
 * Structure is calcStale.ts's, which is this repo's decoration blueprint: an
 * idle-armed first pass after first paint, 350 ms debounced rescans, a
 * DecorationSet mapped through every transaction in between, and a disabled
 * feature that costs nothing — with `birta.notes.highlightMarkers` off nothing
 * is armed, nothing scans, and no decoration is built. Rescans go through
 * `incrementalScanNotes`, so an ordinary inline edit re-scans one block rather
 * than walking the document.
 *
 * This plugin keeps its own scan cache rather than sharing the Notes tab's:
 * the two surfaces are independent (the panel is often closed, and the plugin
 * runs whether or not it was ever opened), and the scan is pure, so the only
 * cost of the duplication is one extra incremental pass on a debounce.
 */
import { Decoration, DecorationSet, Plugin, PluginKey } from "../pm";
import type { EditorState, EditorView, Node as ProseNode } from "../pm";
import { $prose } from "@milkdown/utils";
import { incrementalScanNotes, scanNotes, type NoteItem } from "../notes/scan";
import { notifySetNoteHighlight } from "../messaging";
import { requestIdle } from "../utils/idle";
import "./noteMarkers.css";

const SCAN_DEBOUNCE_MS = 350;
const FIRST_PASS_IDLE_TIMEOUT_MS = 1000;

/** Exported for the tests, which read the live decoration set off it. */
export const noteMarkersKey = new PluginKey<{ set: DecorationSet }>("MD_NOTE_MARKERS");

/**
 * The highlight ships ON — a note the writer can't see is a note they publish.
 * Baked into `window.__i18n` at panel load like the other read-at-use gates,
 * and re-read on every scan so a settings flip needs no reload.
 */
export function noteMarkersEnabled(): boolean {
    return window.__i18n?.notesHighlightMarkers ?? true;
}

/**
 * Flip the highlight from a UI control (the toolbar's Checks menu, the review
 * sidebar's Notes tab, the palette/slash command). The in-session gate applies
 * immediately in THIS webview — chips appear or clear on the same frame as the
 * click, rather than after the settings round trip — and the write-back
 * persists it. The extension's config-change listener echoes `notesConfig` to
 * every open editor, which re-gates them (and re-gates this one idempotently).
 */
export function setNoteMarkersEnabled(view: EditorView | null, on: boolean): void {
    if (window.__i18n) {
        window.__i18n.notesHighlightMarkers = on;
    }
    regateNoteMarkers(view);
    notifySetNoteHighlight(on);
}

/** Fired on `window` whenever the highlight gate is re-read (see regateNoteMarkers). */
export const NOTE_HIGHLIGHT_EVENT = "note-highlight-changed";

/** The custom marker set, read at scan time (birta.notes.customMarkers). */
function customMarkers(): readonly string[] {
    return window.__i18n?.notesCustomMarkers ?? [];
}

/** One inline decoration per text-sourced note item. */
function decorationsFor(doc: ProseNode, items: readonly NoteItem[]): DecorationSet {
    const decos = items
        .filter((item) => item.source === "text" && item.to > item.from)
        .map((item) => Decoration.inline(item.from, item.to, { class: "note-marker" }));
    return decos.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decos);
}

/** The live view's gate opener — the `regateCalcCues` pattern (one webview,
 * one editor). Lets a settings flip reach a plugin whose first-pass gate was
 * never armed because the highlight was off at mount. */
let openGate: (() => void) | null = null;

/**
 * Re-gate after a live `birta.notes.*` change (messageHandlers' `notesConfig`):
 * enabling opens the first-pass gate and rescans now, disabling clears every
 * chip immediately. Also called when only the CUSTOM MARKERS changed — the
 * scan cache is keyed on doc identity, and the marker set is not in that key,
 * so the rescan it forces is what makes a new marker light up on an unchanged
 * document (the notesList cache-invalidation lesson, notesMarkerCache.test.ts).
 */
export function regateNoteMarkers(view: EditorView | null): void {
    if (view) {
        if (noteMarkersEnabled()) {
            openGate?.();
        } else if ((noteMarkersKey.getState(view.state)?.set ?? DecorationSet.empty) !== DecorationSet.empty) {
            view.dispatch(view.state.tr.setMeta(noteMarkersKey, { set: DecorationSet.empty }));
        }
    }
    // The one announcement point for the gate's new value: BOTH ways it can
    // change (a UI control here, or a settings echo from another editor /
    // the Settings UI) funnel through this function, so the switches that
    // mirror it — the toolbar's Checks menu, the Notes tab's toggle — stay
    // truthful without either one polling. Mirrors `proofread-config-changed`.
    window.dispatchEvent(new CustomEvent(NOTE_HIGHLIGHT_EVENT));
}

export const noteMarkersPlugin = $prose(() =>
    new Plugin<{ set: DecorationSet }>({
        key: noteMarkersKey,
        state: {
            init: () => ({ set: DecorationSet.empty }),
            apply(tr, value) {
                let set = value.set;
                if (tr.docChanged) { set = set.map(tr.mapping, tr.doc); }
                const meta = tr.getMeta(noteMarkersKey) as { set: DecorationSet } | undefined;
                if (meta) { set = meta.set; }
                return set === value.set ? value : { set };
            },
        },
        props: {
            decorations(state: EditorState) {
                return noteMarkersKey.getState(state)?.set ?? DecorationSet.empty;
            },
        },
        view(view) {
            let destroyed = false;
            let scanTimer: ReturnType<typeof setTimeout> | null = null;
            let lastDoc: ProseNode | null = view.state.doc;
            let firstPassReady = false;
            let firstPassIdle: { cancel: () => void } | null = null;
            // The incremental-scan cache: the doc the items were scanned from,
            // and those items. Cleared by the gate so a marker-set change
            // rescans an unchanged document.
            let scannedDoc: ProseNode | null = null;
            let scannedItems: readonly NoteItem[] = [];

            const scan = (): void => {
                scanTimer = null;
                if (destroyed || view.isDestroyed || !firstPassReady) { return; }
                if (view.composing) { schedule(); return; } // never disturb IME
                const state = noteMarkersKey.getState(view.state);
                if (!state) { return; }
                const doc = view.state.doc;
                if (!noteMarkersEnabled()) {
                    scannedDoc = null;
                    if (state.set !== DecorationSet.empty) {
                        view.dispatch(view.state.tr.setMeta(noteMarkersKey, { set: DecorationSet.empty }));
                    }
                    return;
                }
                const markers = customMarkers();
                const items = (scannedDoc
                    && incrementalScanNotes(scannedDoc, scannedItems, doc, markers))
                    || scanNotes(doc, markers);
                scannedDoc = doc;
                scannedItems = items;
                const set = decorationsFor(doc, items);
                if (set !== DecorationSet.empty || state.set !== DecorationSet.empty) {
                    view.dispatch(view.state.tr.setMeta(noteMarkersKey, { set }));
                }
            };

            const schedule = (delay = SCAN_DEBOUNCE_MS): void => {
                if (scanTimer !== null) { clearTimeout(scanTimer); }
                scanTimer = setTimeout(scan, delay);
            };

            const myGate = (): void => {
                firstPassReady = true;
                scannedDoc = null; // the marker set may have changed under us
                schedule(0); // a deliberate settings flip should feel instant
            };
            openGate = myGate;

            // Armed only when the highlight is on at mount: off, this plugin
            // schedules nothing and walks nothing. Enabling later arrives
            // through regateNoteMarkers → openGate.
            if (noteMarkersEnabled()) {
                firstPassIdle = requestIdle(() => {
                    firstPassReady = true;
                    schedule(0);
                }, FIRST_PASS_IDLE_TIMEOUT_MS);
            }

            return {
                update() {
                    if (view.state.doc === lastDoc) { return; }
                    lastDoc = view.state.doc;
                    // Gated off, an edit must not even arm a timer — "a disabled
                    // feature costs nothing" is about the running editor, not
                    // just the mount. Re-enabling comes through openGate, which
                    // scans immediately, so nothing is missed by not scheduling.
                    if (!firstPassReady || !noteMarkersEnabled()) { return; }
                    schedule();
                },
                destroy() {
                    destroyed = true;
                    firstPassIdle?.cancel();
                    if (scanTimer !== null) { clearTimeout(scanTimer); }
                    // Release the gate only if it is still OURS — an editor
                    // rebuild can create the new view before destroying this
                    // one (see calcStale.ts).
                    if (openGate === myGate) { openGate = null; }
                },
            };
        },
    }),
);
