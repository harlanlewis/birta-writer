/**
 * The two pieces of drag auto-scroll that a unit test can hold: the shared
 * ramp (components/blockMenu/drag.ts) — the curve itself, and where its top
 * edge is anchored, since the toolbar is fixed over the first rows of the
 * page — and the boundary measurer's caching contract.
 *
 * The ramp is exercised through `scrollVelocityFor` rather than the drag
 * session, which needs real layout (e2e/blockDrag, e2e/imageDrop). The
 * measurer's PAYOFF is a frame-time number that only a browser can produce;
 * what is pinned here are the invariants that produce it — the plan reused
 * across a state-identical measure, the rects reused across a scroll — so a
 * revert to re-planning or re-reading every frame fails a test instead of
 * quietly scaling the frame time with the document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorState, EditorView } from "../pm";
import {
    createBoundaryMeasurer,
    edgeScrollVelocity,
    scrollVelocityFor,
} from "../components/blockMenu";

const VIEWPORT = 900;
const TOPBAR = 40;
/** Mirrors SCROLL_ZONE, which is not exported — the clamp keeps it at 80 for
 * a viewport this tall. */
const ZONE = 80;

function mountToolbar(height: number): void {
    const bar = document.createElement("div");
    bar.className = "editor-topbar";
    bar.getBoundingClientRect = () => ({ height, top: 0, bottom: height }) as DOMRect;
    document.body.appendChild(bar);
}

beforeEach(() => {
    window.innerHeight = VIEWPORT;
});

afterEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
});

describe("edgeScrollVelocity", () => {
    it("outside the zone should be zero", () => {
        expect(edgeScrollVelocity(0, ZONE)).toBe(0);
        expect(edgeScrollVelocity(-10, ZONE)).toBe(0);
    });

    it("just inside the zone should crawl, and deeper should be faster", () => {
        const shallow = edgeScrollVelocity(1, ZONE);
        const deep = edgeScrollVelocity(ZONE, ZONE);
        expect(shallow).toBeGreaterThan(0);
        expect(shallow).toBeLessThan(4);
        expect(deep).toBeGreaterThan(shallow * 4);
    });

    it("overshooting past the edge should keep accelerating, then cap", () => {
        const atEdge = edgeScrollVelocity(ZONE, ZONE);
        const past = edgeScrollVelocity(ZONE * 1.5, ZONE);
        const wayPast = edgeScrollVelocity(ZONE * 10, ZONE);
        expect(past).toBeGreaterThan(atEdge);
        expect(wayPast).toBe(past); // clamped at the overshoot ceiling
    });
});

describe("scrollVelocityFor with the toolbar visible", () => {
    beforeEach(() => mountToolbar(TOPBAR));

    it("the middle of the content should not scroll at all", () => {
        expect(scrollVelocityFor(VIEWPORT / 2)).toBe(0);
    });

    it("the zone should start at the toolbar's bottom, not the viewport top", () => {
        // Just below where the zone now ends: quiet. Under the old anchoring
        // this point was inside the zone and already scrolling.
        expect(scrollVelocityFor(TOPBAR + ZONE + 1)).toBe(0);
        expect(scrollVelocityFor(TOPBAR + ZONE - 1)).toBeLessThan(0);
    });

    it("the content's own top edge should be full speed, not the viewport's", () => {
        const atContentTop = scrollVelocityFor(TOPBAR);
        const midZone = scrollVelocityFor(TOPBAR + ZONE / 2);
        expect(atContentTop).toBeLessThan(midZone); // both negative; faster up
    });

    it("over the toolbar should read as past the edge — faster still", () => {
        expect(scrollVelocityFor(4)).toBeLessThan(scrollVelocityFor(TOPBAR));
    });

    it("the bottom edge should be unaffected by the toolbar", () => {
        expect(scrollVelocityFor(VIEWPORT - ZONE - 1)).toBe(0);
        expect(scrollVelocityFor(VIEWPORT - 1)).toBeGreaterThan(0);
    });
});

describe("createBoundaryMeasurer", () => {
    /**
     * A view stub over a two-paragraph document. `nodeDOM` is the expensive
     * per-position lookup the plan exists to avoid repeating, so counting its
     * calls is the direct test of whether a plan was reused; the blocks' rect
     * reads are counted the same way for the rect tier. The editor root's box
     * is the rect tier's sentinel — `scrollBy` shifts it, `reflow` resizes it.
     */
    function stubView(): {
        view: EditorView;
        nodeDOM: ReturnType<typeof vi.fn>;
        blockRects: ReturnType<typeof vi.fn>;
        retire: () => void;
        scrollBy: (dy: number) => void;
        reflow: (blockHeight: number) => void;
    } {
        const doc = document.createElement("div");
        document.body.appendChild(doc);
        let scrollTop = 0;
        let blockHeight = 40;
        const blockRects = vi.fn((i: number) => ({
            top: i * 100 - scrollTop, bottom: i * 100 + blockHeight - scrollTop,
            left: 0, width: 500, height: blockHeight,
        }) as DOMRect);
        const blocks = [0, 1].map((i) => {
            const el = document.createElement("p");
            el.textContent = `block ${i}`;
            el.getBoundingClientRect = () => blockRects(i);
            doc.appendChild(el);
            return el;
        });
        doc.getBoundingClientRect = () =>
            ({ top: -scrollTop, bottom: 100 + blockHeight - scrollTop, left: 0, width: 500, height: 100 + blockHeight }) as DOMRect;
        const nodeDOM = vi.fn((pos: number) => blocks[pos === 0 ? 0 : 1] ?? null);
        const state = {
            doc: {
                content: { size: 20 },
                forEach: (fn: (node: unknown, offset: number) => void) => {
                    fn({ type: { name: "paragraph" } }, 0);
                    fn({ type: { name: "paragraph" } }, 10);
                },
                nodeAt: () => null,
            },
        } as unknown as EditorState;
        const view = { state, nodeDOM, dom: doc } as unknown as EditorView;
        return {
            view, nodeDOM, blockRects,
            retire: () => blocks[0]?.remove(),
            scrollBy: (dy) => { scrollTop += dy; },
            reflow: (height) => { blockHeight = height; },
        };
    }

    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("a second measure on the same state should reuse the plan and the rects", () => {
        const { view, nodeDOM, blockRects } = stubView();
        const measurer = createBoundaryMeasurer();
        const first = measurer.measure(view);
        const plannedCalls = nodeDOM.mock.calls.length;
        const rectCalls = blockRects.mock.calls.length;
        expect(plannedCalls).toBeGreaterThan(0);
        expect(rectCalls).toBeGreaterThan(0);

        const second = measurer.measure(view);
        expect(nodeDOM.mock.calls.length).toBe(plannedCalls); // no re-plan
        expect(blockRects.mock.calls.length).toBe(rectCalls); // no re-read
        expect(second).toEqual(first);
    });

    it("a scroll should shift the cached boundaries by the root's displacement without re-reading rects", () => {
        const { view, blockRects, scrollBy } = stubView();
        const measurer = createBoundaryMeasurer();
        const first = measurer.measure(view);
        const rectCalls = blockRects.mock.calls.length;

        scrollBy(30);
        const scrolled = measurer.measure(view);
        expect(blockRects.mock.calls.length).toBe(rectCalls); // one root rect, no per-block reads
        expect(scrolled.map((b) => b.y)).toEqual(first.map((b) => b.y - 30));
        expect(scrolled.map((b) => b.pos)).toEqual(first.map((b) => b.pos));
        // And the shifted answer matches what a fresh read would say.
        expect(scrolled.map((b) => b.y)).toEqual(createBoundaryMeasurer().measure(view).map((b) => b.y));
    });

    it("content that reflows (the root's box changes) should re-read rects", () => {
        const { view, blockRects, reflow } = stubView();
        const measurer = createBoundaryMeasurer();
        measurer.measure(view);
        const rectCalls = blockRects.mock.calls.length;

        reflow(80); // every block taller: the root grows, block bottoms move
        const after = measurer.measure(view);
        expect(blockRects.mock.calls.length).toBeGreaterThan(rectCalls);
        expect(after.map((b) => b.y)).toEqual(createBoundaryMeasurer().measure(view).map((b) => b.y));
    });

    it("a new state should re-plan", () => {
        const { view, nodeDOM } = stubView();
        const measurer = createBoundaryMeasurer();
        measurer.measure(view);
        const plannedCalls = nodeDOM.mock.calls.length;

        (view as { state: EditorState }).state = { ...view.state } as EditorState;
        measurer.measure(view);
        expect(nodeDOM.mock.calls.length).toBeGreaterThan(plannedCalls);
    });

    it("an element swapped out from under the plan should force a re-plan", () => {
        const { view, nodeDOM, retire } = stubView();
        const measurer = createBoundaryMeasurer();
        measurer.measure(view);
        const plannedCalls = nodeDOM.mock.calls.length;

        // A NodeView replacing its own root: same state, detached element.
        retire();
        measurer.measure(view);
        expect(nodeDOM.mock.calls.length).toBeGreaterThan(plannedCalls);
    });

    it("reset should drop the plan", () => {
        const { view, nodeDOM } = stubView();
        const measurer = createBoundaryMeasurer();
        measurer.measure(view);
        const plannedCalls = nodeDOM.mock.calls.length;

        measurer.reset();
        measurer.measure(view);
        expect(nodeDOM.mock.calls.length).toBeGreaterThan(plannedCalls);
    });
});

describe("scrollVelocityFor with the toolbar hidden", () => {
    beforeEach(() => {
        mountToolbar(TOPBAR);
        document.body.classList.add("toolbar-hidden");
    });

    it("the zone should run from the viewport top, as it always did", () => {
        expect(scrollVelocityFor(ZONE + 1)).toBe(0);
        expect(scrollVelocityFor(ZONE - 1)).toBeLessThan(0);
        expect(scrollVelocityFor(0)).toBeLessThan(scrollVelocityFor(ZONE / 2));
    });
});
