/**
 * withScrollAnchor (utils/scrollAnchor.ts): the anchoring math against a
 * stubbed view (jsdom has no layout), and the degradation contract — any
 * unmeasurable state runs the mutation un-anchored, never throws, never
 * scrolls blindly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withScrollAnchor } from "../utils/scrollAnchor";
import { anchorStubView as stubView } from "./helpers/anchorStubView";

let scrollBy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "scrollY", { value: 500, configurable: true });
    scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
});

describe("withScrollAnchor", () => {
    it("a moved anchor should scroll by exactly its displacement", () => {
        const view = stubView({ topsByCall: [100, 160] });
        const mutate = vi.fn();
        withScrollAnchor(view, mutate);
        expect(mutate).toHaveBeenCalledOnce();
        expect(scrollBy).toHaveBeenCalledWith(0, 60);
    });

    it("an unmoved anchor should not scroll", () => {
        const view = stubView({ topsByCall: [100, 100] });
        withScrollAnchor(stubView({ topsByCall: [100, 100] }), vi.fn());
        void view;
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it("a null view should still run the mutation", () => {
        const mutate = vi.fn();
        withScrollAnchor(null, mutate);
        expect(mutate).toHaveBeenCalledOnce();
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it("at the top of the document it should not anchor (nothing to preserve)", () => {
        Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
        const mutate = vi.fn();
        withScrollAnchor(stubView({ topsByCall: [100, 200] }), mutate);
        expect(mutate).toHaveBeenCalledOnce();
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it("posAtCoords finding nothing should degrade to an un-anchored mutation", () => {
        const mutate = vi.fn();
        withScrollAnchor(stubView({ posAtCoords: () => null }), mutate);
        expect(mutate).toHaveBeenCalledOnce();
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it("layout APIs throwing (headless DOM) should degrade, never throw", () => {
        const mutate = vi.fn();
        const view = stubView({
            posAtCoords: () => {
                throw new Error("no layout");
            },
        });
        expect(() => withScrollAnchor(view, mutate)).not.toThrow();
        expect(mutate).toHaveBeenCalledOnce();
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it("a post-mutation measurement failure should leave the scroll alone", () => {
        const mutate = vi.fn();
        withScrollAnchor(stubView({ topsByCall: [100] }), mutate);
        expect(mutate).toHaveBeenCalledOnce();
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it("degenerate coords (hidden embed link) should anchor on the block's DOM box", () => {
        // coordsAtPos returns flat rects both times; the block box moves
        // 120 → 200, so the anchor must scroll by 80 — the embed-at-top case
        // that a coords-only anchor silently measured as zero.
        const view = stubView({
            topsByCall: [50, 50],
            degenerateCoords: true,
            blockTopsByCall: [120, 200],
        });
        const mutate = vi.fn();
        withScrollAnchor(view, mutate);
        expect(mutate).toHaveBeenCalledOnce();
        expect(scrollBy).toHaveBeenCalledWith(0, 80);
    });
});
