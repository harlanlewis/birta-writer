/**
 * MAR-215 — the scroll-window measurement (plugins/visibleRange.ts).
 *
 * The important contract is the FALLBACK: with no layout engine, a detached
 * editor, or coordinates the browser refuses to resolve, `measureVisibleWindow`
 * must return null, which every consumer reads as "the whole document". That is
 * what keeps the jsdom suites — and any environment where windowing would be
 * guesswork — on the pre-windowing behavior instead of silently dropping chrome.
 */
import { describe, it, expect, vi } from "vitest";
import { measureVisibleWindow } from "../plugins/visibleRange";

type Rect = { top: number; bottom: number; left: number; width: number; height: number };

/** A minimal EditorView stand-in: only the fields the measurement reads. */
function fakeView(options: {
    rect: Rect;
    docSize?: number;
    posAtCoords?: (coords: { left: number; top: number }) => { pos: number } | null;
    connected?: boolean;
}): any {
    const { rect } = options;
    return {
        dom: {
            isConnected: options.connected ?? true,
            getBoundingClientRect: () => rect,
        },
        state: { doc: { content: { size: options.docSize ?? 1000 } } },
        posAtCoords: options.posAtCoords ?? (() => null),
    };
}

describe("measureVisibleWindow", () => {
    it("a zero-size editor (no layout engine) should measure no window", () => {
        const view = fakeView({ rect: { top: 0, bottom: 0, left: 0, width: 0, height: 0 } });

        expect(measureVisibleWindow(view)).toBeNull();
    });

    it("a detached editor should measure no window", () => {
        const view = fakeView({
            rect: { top: 0, bottom: 500, left: 0, width: 800, height: 500 },
            connected: false,
        });

        expect(measureVisibleWindow(view)).toBeNull();
    });

    it("an editor shorter than the margined viewport should cover the whole document", () => {
        // The editor starts below the top probe and ends above the bottom one,
        // so both saturate to the document's own ends — no coordinate lookup.
        const posAtCoords = vi.fn(() => ({ pos: 42 }));
        const view = fakeView({
            rect: { top: 10, bottom: 400, left: 0, width: 800, height: 390 },
            docSize: 1234,
            posAtCoords,
        });

        expect(measureVisibleWindow(view)).toEqual({ from: 0, to: 1234 });
        expect(posAtCoords).not.toHaveBeenCalled();
    });

    it("a document scrolled past the margin should resolve both ends by coordinate", () => {
        // window.innerHeight is 768 under jsdom; the margin is 2 viewport
        // heights, so an editor spanning far beyond both probes gets real
        // lookups at both ends.
        const view = fakeView({
            rect: { top: -50000, bottom: 50000, left: 0, width: 800, height: 100000 },
            docSize: 100000,
            posAtCoords: ({ top }) => ({ pos: top < 0 ? 700 : 4200 }),
        });

        expect(measureVisibleWindow(view)).toEqual({ from: 700, to: 4200 });
    });

    it("coordinates the browser refuses to resolve should measure no window", () => {
        const view = fakeView({
            rect: { top: -50000, bottom: 50000, left: 0, width: 800, height: 100000 },
            posAtCoords: () => null,
        });

        expect(measureVisibleWindow(view)).toBeNull();
    });

    it("a degenerate result (end before start) should fall back to the whole document", () => {
        const view = fakeView({
            rect: { top: -50000, bottom: 50000, left: 0, width: 800, height: 100000 },
            docSize: 900,
            posAtCoords: ({ top }) => ({ pos: top < 0 ? 800 : 100 }),
        });

        expect(measureVisibleWindow(view)).toEqual({ from: 0, to: 900 });
    });
});
