/**
 * The local graph's model and layout (components/graph/localGraph.ts): which
 * notes are drawn on which ring, which lines, what is left out and said to
 * be, and where the rings put things. Pure, so no DOM.
 */
import { describe, it, expect } from "vitest";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { buildLocalGraph, hueOf, layoutRings, nudge, RING_CAPACITY, RING_WOBBLE, TYPE_HUES } from "../components/graph/localGraph";
import { createRingStage, curveThrough, TIER_SHOWN, tierFor } from "../components/graph/ringStage";

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

    it("this note should sit at the centre and each ring within its wobble of its own radius", () => {
        const g = layoutRings(buildLocalGraph(SMALL, "self.md", 2)!, 100);
        const self = g.nodes.find((n) => n.ring === 0)!;
        expect([self.x, self.y]).toEqual([50, 50]);
        const r1 = g.nodes.filter((n) => n.ring === 1).map((n) => dist(n.x, n.y));
        const r2 = g.nodes.filter((n) => n.ring === 2).map((n) => dist(n.x, n.y));
        // Off a perfect circle, on purpose (`nudge`), but never past the band.
        const mid1 = (Math.max(...r1) + Math.min(...r1)) / 2;
        for (const r of r1) { expect(Math.abs(r - mid1) / mid1).toBeLessThanOrEqual(2 * RING_WOBBLE); }
        expect(new Set(r1.map((r) => r.toFixed(3))).size).toBeGreaterThan(1);
        expect(Math.min(...r2)).toBeGreaterThan(Math.max(...r1));
    });

    it("a second-ring note should know the first-ring note it hangs from", () => {
        const g = layoutRings(buildLocalGraph(SMALL, "self.md", 2)!, 100);
        expect(g.nodes.find((n) => n.id === "c.md")!.parent).toBe("b.md");
        expect(g.nodes.filter((n) => n.ring < 2).every((n) => n.parent === undefined)).toBe(true);
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

describe("the drawing's shape", () => {
    it("a nudge should be the same for the same id and fall in [0, 1)", () => {
        const values = Array.from({ length: 200 }, (_, i) => nudge(`n${i}.md`, 1));
        expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
        expect(nudge("a.md", 1)).toBe(nudge("a.md", 1));
        expect(nudge("a.md", 1)).not.toBe(nudge("a.md", 2));
        // Spread, not clumped: both halves are used.
        expect(values.filter((v) => v < 0.5).length).toBeGreaterThan(60);
        expect(values.filter((v) => v >= 0.5).length).toBeGreaterThan(60);
    });

    it("a line should be the same curve whichever end it is drawn from, and end on both notes", () => {
        const a = { id: "a.md", x: 10, y: 20 };
        const b = { id: "b.md", x: 70, y: 40 };
        expect(curveThrough(a, b)).toBe(curveThrough(b, a));
        expect(curveThrough(a, b)).toMatch(/^M10\.00,20\.00 Q[-\d.]+,[-\d.]+ 70\.00,40\.00$/);
        // It bows: the control point is off the straight line.
        const [, cx, cy] = curveThrough(a, b).match(/Q([-\d.]+),([-\d.]+)/)!.map(Number);
        const offLine = Math.abs((b.y - a.y) * cx! - (b.x - a.x) * cy! + b.x * a.y - b.y * a.x) / Math.hypot(b.x - a.x, b.y - a.y);
        expect(offLine).toBeGreaterThan(1);
    });

    it("each first-ring note should show its liveliest second-ring notes and keep the rest, and the dormant, for its hover", () => {
        const edges = [edge("self.md", "hub.md"), ...["k1", "k2", "k3", "k4"].map((k) => edge("hub.md", `${k}.md`))];
        const idx = index(["self.md", "hub.md", "k1.md", "k2.md", "k3.md", "k4.md"].map((p) => node(p)), edges);
        const laid = layoutRings(buildLocalGraph(idx, "self.md", 2)!, 100);
        const activity: Record<string, number> = { "k1.md": 0.9, "k2.md": 0.05, "k3.md": 0.5, "k4.md": 0.7 };
        laid.nodes.forEach((n) => { if (activity[n.id] !== undefined) { n.activity = activity[n.id]!; } });
        const waiting = tierFor(laid);
        expect(TIER_SHOWN).toBe(2);
        // k1 and k4 are the liveliest two; k3 waits for being third, k2 for being dormant.
        expect([...waiting].sort()).toEqual(["k2.md", "k3.md"]);
    });

    it("a drawing with no activity should rank its tier by how connected each note is", () => {
        const edges = [edge("self.md", "hub.md"), ...["k1", "k2", "k3"].map((k) => edge("hub.md", `${k}.md`)), edge("x.md", "k3.md"), edge("y.md", "k3.md"), edge("x.md", "k2.md")];
        const idx = index(["self.md", "hub.md", "k1.md", "k2.md", "k3.md", "x.md", "y.md"].map((p) => node(p)), edges);
        const laid = layoutRings(buildLocalGraph(idx, "self.md", 2)!, 100);
        expect([...tierFor(laid)]).toEqual(["k1.md"]);
    });
});

describe("the tier on screen", () => {
    it("a waiting note and its line should open while its parent is hovered, and close after", () => {
        const kids = ["k1", "k2", "k3", "k4"];
        const idx = index(["self.md", "hub.md", ...kids.map((k) => `${k}.md`)].map((p) => node(p)),
            [edge("self.md", "hub.md"), ...kids.map((k) => edge("hub.md", `${k}.md`))]);
        const stage = createRingStage({ openNote: () => {}, onEscape: () => {}, centreIsCurrent: true });
        document.body.append(stage.element);
        stage.draw(layoutRings(buildLocalGraph(idx, "self.md", 2)!, 100));
        const waiting = () => [...stage.element.querySelectorAll<HTMLElement>(".lg-node--tier")];
        const open = () => waiting().filter((n) => n.classList.contains("lg-tier-open")).length;
        expect(waiting()).toHaveLength(kids.length - TIER_SHOWN);
        expect(stage.element.querySelectorAll(".lg-line--tier")).toHaveLength(kids.length - TIER_SHOWN);
        expect(open()).toBe(0);
        const hub = stage.element.querySelector<HTMLElement>('.lg-node[data-id="hub.md"]')!;
        hub.dispatchEvent(new MouseEvent("mouseenter"));
        expect(open()).toBe(kids.length - TIER_SHOWN);
        expect([...stage.element.querySelectorAll(".lg-line--tier")].every((l) => l.classList.contains("lg-tier-open"))).toBe(true);
        // Moving onto one of the opened notes keeps its arc open.
        waiting()[0]!.dispatchEvent(new MouseEvent("mouseenter"));
        expect(open()).toBe(kids.length - TIER_SHOWN);
        waiting()[0]!.dispatchEvent(new MouseEvent("mouseleave"));
        expect(open()).toBe(0);
        stage.element.remove();
    });

    it("a pair of notes naming each other should be drawn as one line, with no arrowheads", () => {
        const idx = index([node("self.md"), node("a.md")], [edge("self.md", "a.md"), edge("a.md", "self.md")]);
        const stage = createRingStage({ openNote: () => {}, onEscape: () => {}, centreIsCurrent: true });
        stage.draw(layoutRings(buildLocalGraph(idx, "self.md", 1)!, 100));
        expect(stage.element.querySelectorAll(".lg-line")).toHaveLength(1);
        expect(stage.element.querySelectorAll("polygon")).toHaveLength(0);
        expect(stage.element.querySelector(".lg-line")!.tagName.toLowerCase()).toBe("path");
    });
});
