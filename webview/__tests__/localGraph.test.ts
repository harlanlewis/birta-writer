/**
 * The local graph's model and layout (components/graph/localGraph.ts): which
 * notes are drawn on which ring, which lines, what is left out and said to
 * be, and where the rings put things. Pure, so no DOM.
 */
import { describe, it, expect } from "vitest";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { ALIKE_CAP, BAND, buildLocalGraph, GAP, hueOf, layoutRings, nudge, RING_CAPACITY, TYPE_HUES } from "../components/graph/localGraph";
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
        expect(g.lines.map(({ from, to }) => ({ from, to }))).toEqual([{ from: "self.md", to: "a.md" }, { from: "a.md", to: "self.md" }]);
    });

    it("lines should keep their direction and join only drawn notes", () => {
        const g = buildLocalGraph(SMALL, "self.md", 1)!;
        expect(g.lines.map(({ from, to }) => ({ from, to }))).toEqual([
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

describe("a line's weight", () => {
    it("a note naming another three times should be one line of weight three", () => {
        const idx = index([node("self.md"), node("a.md")], [edge("self.md", "a.md"), edge("self.md", "a.md"), edge("self.md", "a.md")]);
        expect(buildLocalGraph(idx, "self.md", 1)!.lines).toEqual([{ from: "self.md", to: "a.md", weight: 3 }]);
    });
});

describe("layoutRings", () => {
    const dist = (x: number, y: number) => Math.hypot(x - 50, y - 50);

    it("this note should sit at the centre, and every second-ring note further out than any first-ring one", () => {
        const g = layoutRings(buildLocalGraph(SMALL, "self.md", 2)!, 100);
        const self = g.nodes.find((n) => n.ring === 0)!;
        expect([self.x, self.y]).toEqual([50, 50]);
        const r1 = g.nodes.filter((n) => n.ring === 1).map((n) => dist(n.x, n.y));
        const r2 = g.nodes.filter((n) => n.ring === 2).map((n) => dist(n.x, n.y));
        expect(Math.min(...r2)).toBeGreaterThan(Math.max(...r1));
    });

    it("a note bound to the centre by more references should sit nearer it, within its ring's band", () => {
        const idx = index([node("self.md"), node("close.md"), node("far.md")],
            [edge("self.md", "close.md"), edge("close.md", "self.md"), edge("close.md", "self.md"), edge("self.md", "far.md")]);
        const g = layoutRings(buildLocalGraph(idx, "self.md", 1)!, 100);
        const at = (id: string) => { const n = g.nodes.find((m) => m.id === id)!; return dist(n.x, n.y); };
        expect(at("close.md")).toBeLessThan(at("far.md"));
        const r1 = 100 * 0.34;
        expect(at("close.md")).toBeCloseTo(r1 * (1 - BAND), 4);
        expect(at("far.md")).toBeLessThanOrEqual(r1 * (1 + BAND) + 1e-9);
    });

    it("related first-ring notes should sit side by side, with a wider gap before an unrelated run", () => {
        // a-b-c refer to each other in a chain; x and y refer to each other; z to nothing.
        const ids = ["a", "b", "c", "x", "y", "z"];
        const idx = index([node("self.md"), ...ids.map((i) => node(`${i}.md`))], [
            ...ids.map((i) => edge("self.md", `${i}.md`)),
            edge("a.md", "b.md"), edge("b.md", "c.md"), edge("x.md", "y.md"),
        ]);
        const g = layoutRings(buildLocalGraph(idx, "self.md", 1)!, 100);
        const order = g.nodes.filter((n) => n.ring === 1)
            .map((n) => ({ id: n.id, a: (Math.atan2(n.y - 50, n.x - 50) + Math.PI * 2.5) % (Math.PI * 2) }))
            .sort((p, q) => p.a - q.a);
        const pos = (id: string) => order.findIndex((o) => o.id === id);
        expect(Math.abs(pos("a.md") - pos("b.md"))).toBe(1);
        expect(Math.abs(pos("b.md") - pos("c.md"))).toBe(1);
        expect(Math.abs(pos("x.md") - pos("y.md"))).toBe(1);
        const step = (i: number) => ((order[(i + 1) % order.length]!.a - order[i]!.a) + Math.PI * 2) % (Math.PI * 2);
        // Between related neighbours the step is one unit; into an unrelated run it is GAP units.
        const within = step(Math.min(pos("a.md"), pos("b.md")));
        const across = step(order.length - 1 === pos("z.md") ? pos("z.md") : pos("c.md"));
        expect(across / within).toBeCloseTo(GAP, 4);
    });

    it("a ring where no two notes are related should be evenly spaced, claiming no grouping", () => {
        const idx = index([node("self.md"), ...["p", "q", "r", "s"].map((i) => node(`${i}.md`))], ["p", "q", "r", "s"].map((i) => edge("self.md", `${i}.md`)));
        const g = layoutRings(buildLocalGraph(idx, "self.md", 1)!, 100);
        const angles = g.nodes.filter((n) => n.ring === 1).map((n) => Math.atan2(n.y - 50, n.x - 50)).sort((a, b) => a - b);
        const steps = angles.map((a, i) => ((angles[(i + 1) % angles.length]! - a) + Math.PI * 2) % (Math.PI * 2));
        for (const st of steps) { expect(st).toBeCloseTo(Math.PI / 2, 6); }
    });

    it("a second-ring note should hang from the first-ring note it is most bound to", () => {
        const idx = index([node("self.md"), node("a.md"), node("b.md"), node("kid.md")], [
            edge("self.md", "a.md"), edge("self.md", "b.md"), edge("a.md", "kid.md"), edge("kid.md", "b.md"), edge("b.md", "kid.md"),
        ]);
        const g = layoutRings(buildLocalGraph(idx, "self.md", 2)!, 100);
        expect(g.nodes.find((n) => n.id === "kid.md")!.parent).toBe("b.md");
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
        // Leaving the parent for the space on the way to its notes keeps the
        // arc open: only another note, or leaving the drawing, closes it.
        hub.dispatchEvent(new MouseEvent("mouseleave"));
        expect(open()).toBe(kids.length - TIER_SHOWN);
        waiting()[0]!.dispatchEvent(new MouseEvent("mouseenter"));
        expect(open()).toBe(kids.length - TIER_SHOWN);
        stage.element.dispatchEvent(new MouseEvent("mouseleave"));
        expect(open()).toBe(0);
        stage.element.remove();
    });

    it("no line should be lit at rest; a note should light its way back to the centre and out to its own children", () => {
        // a and b are first-ring and refer to each other; kid hangs from a.
        const idx = index(["self.md", "a.md", "b.md", "kid.md"].map((p) => node(p)),
            [edge("self.md", "a.md"), edge("self.md", "b.md"), edge("a.md", "b.md"), edge("a.md", "kid.md")]);
        const stage = createRingStage({ openNote: () => {}, onEscape: () => {}, centreIsCurrent: true });
        document.body.append(stage.element);
        stage.draw(layoutRings(buildLocalGraph(idx, "self.md", 2)!, 100));
        const lit = () => [...stage.element.querySelectorAll<SVGElement>(".lg-line.lg-lit")]
            .map((l) => [l.dataset["from"], l.dataset["to"]].join(">")).sort();
        const hover = (id: string, on: boolean) => stage.element.querySelector<HTMLElement>(`.lg-node[data-id="${id}"]`)!
            .dispatchEvent(new MouseEvent(on ? "mouseenter" : "mouseleave"));
        expect(lit()).toEqual([]);
        // An outer note: the centre to its parent, and its parent to it.
        hover("kid.md", true);
        expect(lit()).toEqual(["a.md>kid.md", "self.md>a.md"]);
        stage.element.dispatchEvent(new MouseEvent("mouseleave"));
        // A first-ring note: back to the centre and out to its child, and not
        // its tie to its neighbour b, which sitting beside it already says.
        hover("a.md", true);
        expect(lit()).toEqual(["a.md>kid.md", "self.md>a.md"]);
        // The centre: its whole first ring.
        hover("self.md", true);
        expect(lit()).toEqual(["self.md>a.md", "self.md>b.md"]);
        stage.element.dispatchEvent(new MouseEvent("mouseleave"));
        expect(lit()).toEqual([]);
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

describe("notes alike in content", () => {
    const sim = (a: string, b: string, score: number) => ({ a, b, score });

    it("a note alike to this one and linked to it by nothing should join the first ring, marked, with a likeness line", () => {
        const idx = { ...index(["self.md", "linked.md", "alike.md", "far.md"].map((p) => node(p)),
            [edge("self.md", "linked.md"), edge("alike.md", "far.md")]),
            similar: [sim("alike.md", "self.md", 0.4), sim("linked.md", "self.md", 0.6)] };
        const g = buildLocalGraph(idx, "self.md", 2)!;
        const alike = g.nodes.find((n) => n.id === "alike.md")!;
        expect(alike).toMatchObject({ ring: 1, alike: true });
        expect(g.nodes.find((n) => n.id === "linked.md")!.alike).toBeUndefined();
        // A pair the reader linked is a link, not also a likeness.
        expect(g.lines.filter((l) => l.alike).map((l) => `${l.from}>${l.to}`)).toEqual(["alike.md>self.md"]);
        // The outer ring is what references reach: far.md hangs only from a guess, so it is not drawn.
        expect(g.nodes.some((n) => n.id === "far.md")).toBe(false);
    });

    it("no more than the cap of alike notes should join, the most alike first", () => {
        const others = Array.from({ length: ALIKE_CAP + 3 }, (_, i) => `o${i}.md`);
        const idx = { ...index(["self.md", ...others].map((p) => node(p)), []),
            similar: others.map((o, i) => sim(o, "self.md", 0.9 - i * 0.05)) };
        const g = buildLocalGraph(idx, "self.md", 1)!;
        expect(g.nodes.filter((n) => n.alike).map((n) => n.id)).toEqual(others.slice(0, ALIKE_CAP));
    });

    it("a note there for likeness should sit further out than one linked once", () => {
        const idx = { ...index(["self.md", "linked.md", "alike.md"].map((p) => node(p)), [edge("self.md", "linked.md")]),
            similar: [sim("alike.md", "self.md", 0.9)] };
        const g = layoutRings(buildLocalGraph(idx, "self.md", 1)!, 100);
        const d = (id: string) => { const n = g.nodes.find((m) => m.id === id)!; return Math.hypot(n.x - 50, n.y - 50); };
        expect(d("alike.md")).toBeGreaterThan(d("linked.md"));
    });

    it("a likeness line should be drawn dashed and its note named as alike, not linked", () => {
        const idx = { ...index(["self.md", "alike.md"].map((p) => node(p)), []), similar: [sim("alike.md", "self.md", 0.5)] };
        const stage = createRingStage({ openNote: () => {}, onEscape: () => {}, centreIsCurrent: true });
        stage.draw(layoutRings(buildLocalGraph(idx, "self.md", 1)!, 100));
        expect(stage.element.querySelector(".lg-line")!.classList.contains("lg-line--alike")).toBe(true);
        const n = stage.element.querySelector<HTMLElement>('.lg-node[data-id="alike.md"]')!;
        expect(n.classList.contains("lg-node--alike")).toBe(true);
        expect(n.getAttribute("aria-label")).toBe("alike (not linked; the on-device model finds it alike in content)");
    });
});

describe("the review's fixes", () => {
    it("the arrow keys should walk from a first-ring note into the notes that hang from it", () => {
        const idx = index(["self.md", "a.md", "b.md", "a1.md", "a2.md", "b1.md"].map((p) => node(p)),
            [edge("self.md", "a.md"), edge("self.md", "b.md"), edge("a.md", "a1.md"), edge("a.md", "a2.md"), edge("b.md", "b1.md")]);
        const stage = createRingStage({ openNote: () => {}, onEscape: () => {}, centreIsCurrent: true });
        stage.draw(layoutRings(buildLocalGraph(idx, "self.md", 2)!, 100));
        const order = [...stage.element.querySelectorAll<HTMLElement>(".lg-node")].map((n) => n.dataset["id"]);
        expect(order[0]).toBe("self.md");
        // Its two notes come straight after it, in the order they sit round the ring.
        const at = order.indexOf("a.md");
        expect(new Set(order.slice(at + 1, at + 3))).toEqual(new Set(["a1.md", "a2.md"]));
        expect(order.indexOf("b1.md")).toBe(order.indexOf("b.md") + 1);
    });

    it("outer notes that hang from no first-ring note should be spread round the ring, not stacked", () => {
        const g = layoutRings({
            nodes: [
                { id: "c.md", label: "c", ring: 0, type: null, dangling: false, degree: 1, x: 0, y: 0 },
                { id: "r.md", label: "r", ring: 1, type: null, dangling: false, degree: 1, x: 0, y: 0 },
                ...["o1", "o2", "o3"].map((o) => ({ id: `${o}.md`, label: o, ring: 2 as const, type: null, dangling: false, degree: 0, x: 0, y: 0 })),
            ],
            lines: [{ from: "c.md", to: "r.md", weight: 1 }],
            omitted: 0, types: [],
        }, 100); // budget-ok: the layout square's size, not a timeout
        const at = new Set(g.nodes.filter((n) => n.ring === 2).map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`));
        expect(at.size).toBe(3);
    });
});
