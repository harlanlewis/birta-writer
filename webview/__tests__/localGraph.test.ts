/**
 * The local graph's model and layout (components/graph/localGraph.ts): which
 * notes are drawn on which ring, which lines, what is left out and said to
 * be, and where the rings put things. Pure, so no DOM.
 */
import { describe, it, expect } from "vitest";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { buildLocalGraph, hueOf, layoutRings, RING_CAPACITY, TYPE_HUES } from "../components/graph/localGraph";

const node = (path: string, type: string | null = null): FolderNode =>
    ({ path, name: path.replace(/\.md$/, ""), type, tags: [], status: null, trust: null, staleAfter: null });
const edge = (from: string, to: string | null, target = to ?? "x"): FolderEdge =>
    ({ from, to, target, kind: "link", text: "", line: 1 });
const index = (nodes: FolderNode[], edges: FolderEdge[], truncated = false): FolderIndex =>
    ({ rootName: "v", nodes, edges, truncated });

/** self <- a, self -> b, b -> c (c is two steps away), d is unconnected. */
const SMALL = index(
    [node("self.md"), node("a.md", "reference"), node("b.md"), node("c.md", "metric"), node("d.md")],
    [edge("a.md", "self.md"), edge("self.md", "b.md"), edge("b.md", "c.md"), edge("self.md", null, "Missing")],
);

const ring = (g: ReturnType<typeof buildLocalGraph>, r: number) => g!.nodes.filter((n) => n.ring === r).map((n) => n.id).sort();

describe("buildLocalGraph", () => {
    it("a note the index does not hold should have no graph", () => {
        expect(buildLocalGraph(SMALL, "nope.md", 1)).toBeNull();
    });

    it("the first ring should hold the notes on either end of a reference, and this note's dangling ones", () => {
        const g = buildLocalGraph(SMALL, "self.md", 1)!;
        expect(ring(g, 0)).toEqual(["self.md"]);
        expect(ring(g, 1)).toEqual(["a.md", "b.md", "dangling:Missing"]);
        expect(ring(g, 2)).toEqual([]);
        expect(g.nodes.find((n) => n.id === "dangling:Missing")).toMatchObject({ dangling: true, label: "Missing", type: null });
    });

    it("two steps should add the neighbours' neighbours and nothing unconnected", () => {
        const g = buildLocalGraph(SMALL, "self.md", 2)!;
        expect(ring(g, 2)).toEqual(["c.md"]);
        expect(g.nodes.map((n) => n.id)).not.toContain("d.md");
    });

    it("another note's dangling reference should never be drawn", () => {
        const g = buildLocalGraph(index([node("self.md"), node("a.md")], [edge("self.md", "a.md"), edge("a.md", null, "Gone")]), "self.md", 2)!;
        expect(g.nodes.map((n) => n.id)).toEqual(["self.md", "a.md"]);
    });

    it("a note named in both directions should be drawn once, with a line each way", () => {
        const g = buildLocalGraph(index([node("self.md"), node("a.md")], [edge("self.md", "a.md"), edge("a.md", "self.md"), edge("a.md", "self.md")]), "self.md", 1)!;
        expect(ring(g, 1)).toEqual(["a.md"]);
        expect(g.lines).toEqual([{ from: "self.md", to: "a.md" }, { from: "a.md", to: "self.md" }]);
    });

    it("lines should keep their direction and join only drawn notes", () => {
        const g = buildLocalGraph(SMALL, "self.md", 1)!;
        expect(g.lines).toEqual([
            { from: "a.md", to: "self.md" },
            { from: "self.md", to: "b.md" },
            { from: "self.md", to: "dangling:Missing" },
        ]);
    });

    it("a crowded ring should keep its most connected notes and count the rest", () => {
        const n = RING_CAPACITY[1] + 3;
        const nodes = [node("self.md"), ...Array.from({ length: n }, (_, i) => node(`n${i}.md`))];
        const edges = nodes.slice(1).map((nd) => edge(nd.path, "self.md"));
        // A neighbour that sorts after every other by name is linked from two
        // more notes, so only its degree can keep it on a ring the name order
        // would cut it from.
        const last = "zz-hub.md";
        nodes.push(node(last), node("x.md"), node("y.md"));
        edges.push(edge(last, "self.md"));
        edges.push(edge("x.md", last), edge("y.md", last));
        const g = buildLocalGraph(index(nodes, edges), "self.md", 1)!;
        expect(ring(g, 1)).toHaveLength(RING_CAPACITY[1]);
        expect(ring(g, 1)).toContain(last);
        expect(g.omitted).toBe(4);
    });

    it("types should be listed once, sorted, and hued only up to the palette", () => {
        const g = buildLocalGraph(SMALL, "self.md", 2)!;
        expect(g.types).toEqual(["metric", "reference"]);
        const many = Array.from({ length: TYPE_HUES + 2 }, (_, i) => `t${i}`);
        expect(hueOf(many, "t0")).toBe(0);
        expect(hueOf(many, `t${TYPE_HUES - 1}`)).toBe(TYPE_HUES - 1);
        expect(hueOf(many, `t${TYPE_HUES}`)).toBeNull();
        expect(hueOf(many, null)).toBeNull();
    });
});

describe("layoutRings", () => {
    const dist = (x: number, y: number) => Math.hypot(x - 50, y - 50);

    it("this note should sit at the centre and each ring at its own radius", () => {
        const g = layoutRings(buildLocalGraph(SMALL, "self.md", 2)!, 100);
        const self = g.nodes.find((n) => n.ring === 0)!;
        expect([self.x, self.y]).toEqual([50, 50]);
        const r1 = g.nodes.filter((n) => n.ring === 1).map((n) => dist(n.x, n.y));
        const r2 = g.nodes.filter((n) => n.ring === 2).map((n) => dist(n.x, n.y));
        for (const r of r1) { expect(r).toBeCloseTo(r1[0]!, 6); }
        expect(Math.min(...r2)).toBeGreaterThan(Math.max(...r1));
    });

    it("the same neighbours should be drawn in the same places whatever order the index lists them in", () => {
        const shuffled = index([...SMALL.nodes].reverse(), [...SMALL.edges].reverse());
        const at = (g: ReturnType<typeof layoutRings>) => Object.fromEntries(g.nodes.map((n) => [n.id, [n.x.toFixed(4), n.y.toFixed(4)]]));
        expect(at(layoutRings(buildLocalGraph(shuffled, "self.md", 2)!, 100)))
            .toEqual(at(layoutRings(buildLocalGraph(SMALL, "self.md", 2)!, 100)));
    });

    it("a neighbour's place should not depend on how connected it is elsewhere", () => {
        // A reference between two other notes changes their degrees, and must
        // not reshuffle this note's ring.
        // Two more references to a.md make it more connected than b.md, which
        // flips the order a degree-ranked ring would draw them in.
        const busier = index([...SMALL.nodes], [...SMALL.edges, edge("d.md", "a.md"), edge("c.md", "a.md")]);
        const ring1At = (g: ReturnType<typeof layoutRings>) => Object.fromEntries(g.nodes.filter((n) => n.ring === 1).map((n) => [n.id, [n.x.toFixed(4), n.y.toFixed(4)]]));
        expect(ring1At(layoutRings(buildLocalGraph(busier, "self.md", 1)!, 100)))
            .toEqual(ring1At(layoutRings(buildLocalGraph(SMALL, "self.md", 1)!, 100)));
    });

    it("a second-ring note should be drawn in the arc of the neighbour it hangs from", () => {
        const g = layoutRings(buildLocalGraph(SMALL, "self.md", 2)!, 100);
        const b = g.nodes.find((n) => n.id === "b.md")!;
        const c = g.nodes.find((n) => n.id === "c.md")!;
        const angle = (x: number, y: number) => Math.atan2(y - 50, x - 50);
        expect(angle(c.x, c.y)).toBeCloseTo(angle(b.x, b.y), 6);
    });

    it("every node should land inside the square", () => {
        const g = layoutRings(buildLocalGraph(SMALL, "self.md", 2)!, 100);
        for (const n of g.nodes) {
            expect(n.x).toBeGreaterThanOrEqual(0);
            expect(n.x).toBeLessThanOrEqual(100);
            expect(n.y).toBeGreaterThanOrEqual(0);
            expect(n.y).toBeLessThanOrEqual(100);
        }
    });
});
