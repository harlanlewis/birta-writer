/**
 * Invalidation guard for the Notes-tab scan cache (cache review, 2026-07-24).
 *
 * notesList caches the scanned notes keyed on doc identity (scannedDoc === doc
 * → reuse). But the scan ALSO depends on the custom-marker set, which is NOT in
 * that key — so setMarkers() must reset scannedDoc to force a rescan. This test
 * warms the cache under one marker set, changes the markers WITHOUT changing
 * the doc, and asserts the next count reflects the new markers. It fails if the
 * setMarkers reset is ever dropped (the cache would return the stale count for
 * the same doc object).
 *
 * The pure scanner (scanNotes/incrementalScanNotes) is covered in
 * notesScan.test.ts; this pins the caching wrapper's invalidation only.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { initNotesList } from "../components/toc/notesList";

let editors: Editor[] = [];

async function docView(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

beforeEach(() => {
    window.__i18n = { translations: {} } as unknown as typeof window.__i18n;
});

afterEach(async () => {
    for (const e of editors) { await e.destroy(); }
    editors = [];
    document.body.innerHTML = "";
    delete window.__i18n;
});

describe("notesList — the custom-marker set invalidates the scan cache", () => {
    it("changing markers on an unchanged doc should re-scan, not return the cached count", async () => {
        // "DRAFT" is a custom marker; "[TK]" is a built-in placeholder. Under
        // markers=["DRAFT"] both count (2); with no custom markers only [TK]
        // remains (1). Same doc object across both counts, so the second read
        // takes the cache path (scannedDoc === doc) — the exact path the reset
        // must invalidate.
        const view = await docView("# Notes\n\nplease DRAFT this\n\nand [TK] that\n");
        const notes = initNotesList(() => null);

        notes.setMarkers(["DRAFT"]);
        expect(notes.count(view)).toBe(2); // warms the cache under DRAFT

        notes.setMarkers([]);
        expect(notes.count(view)).toBe(1); // reset → rescan; stale would read 2
    });

    it("adding a custom marker should surface new notes on the same doc", async () => {
        const view = await docView("# Notes\n\nreview REWRITE later\n\nplain line\n");
        const notes = initNotesList(() => null);

        notes.setMarkers([]);
        expect(notes.count(view)).toBe(0); // warms empty

        notes.setMarkers(["REWRITE"]);
        expect(notes.count(view)).toBe(1); // reset → the custom note appears
    });
});
