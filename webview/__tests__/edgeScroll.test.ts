/**
 * The two pieces of drag auto-scroll that a unit test can hold: the shared
 * ramp (components/blockMenu/drag.ts) — the curve itself, and where its top
 * edge is anchored, since the toolbar is fixed over the first rows of the
 * page — and the boundary measurer's caching contract.
 *
 * The ramp is exercised through `scrollVelocityFor` rather than the drag
 * session, which needs real layout (e2e/blockDrag, e2e/imageDrop). The
 * measurer's PAYOFF is a frame-time number that only a browser can produce;
 * what is pinned here is the invariant that produces it, so a revert to
 * re-planning every frame fails a test instead of quietly costing 12× the
 * frame time on a long document.
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
     * calls is the direct test of whether a plan was reused.
     */
    function stubView(): { view: EditorView; nodeDOM: ReturnType<typeof vi.fn>; retire: () => void } {
        const doc = document.createElement("div");
        document.body.appendChild(doc);
        const blocks = [0, 1].map((i) => {
            const el = document.createElement("p");
            el.textContent = `block ${i}`;
            el.getBoundingClientRect = () =>
                ({ top: i * 100, bottom: i * 100 + 40, left: 0, width: 500, height: 40 }) as DOMRect;
            doc.appendChild(el);
            return el;
        });
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
        const view = { state, nodeDOM } as unknown as EditorView;
        return { view, nodeDOM, retire: () => blocks[0]?.remove() };
    }

    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("a second measure on the same state should re-read rects without re-planning", () => {
        const { view, nodeDOM } = stubView();
        const measurer = createBoundaryMeasurer();
        const first = measurer.measure(view);
        const plannedCalls = nodeDOM.mock.calls.length;
        expect(plannedCalls).toBeGreaterThan(0);

        const second = measurer.measure(view);
        expect(nodeDOM.mock.calls.length).toBe(plannedCalls); // no re-plan
        expect(second).toEqual(first);
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
