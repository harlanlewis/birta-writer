/**
 * The whole-folder graph's analysis and layout (components/graph/folderGraph.ts):
 * the three lists the view exists to show, the filter, and the force layout's
 * promises (the same folder settles the same way, linked notes end nearer
 * than unlinked ones, a step keeps to its budget, a big folder settles).
 */
import { describe, it, expect } from "vitest";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { analyzeFolder, createForceLayout, filterNotes, HUB_COUNT } from "../components/graph/folderGraph";
import { budget } from "./helpers/testBudget";

const node = (path: string, type: string | null = null): FolderNode =>
    ({ path, name: path.replace(/\.md$/, ""), type, tags: [], status: null, trust: null, staleAfter: null });
const edge = (from: string, to: string | null, target = to ?? "x"): FolderEdge =>
    ({ from, to, target, kind: "link", text: "", line: 1 });
const index = (nodes: FolderNode[], edges: FolderEdge[]): FolderIndex => ({ rootName: "v", nodes, edges, truncated: false });

/** hub.md is named by a, b and c; a names b; lone.md touches nothing; two notes name "Ghost". */
const FOLDER = index(
    [node("hub.md", "reference"), node("a.md"), node("b.md", "metric"), node("c.md"), node("lone.md")],
    [edge("a.md", "hub.md"), edge("b.md", "hub.md"), edge("c.md", "hub.md"), edge("a.md", "b.md"),
        edge("a.md", null, "Ghost"), edge("c.md", null, "Ghost"), edge("b.md", null, "Other")],
);

describe("analyzeFolder", () => {
    it("hubs should be the most connected notes, most first, and never a note with no references", () => {
        // Fewer than HUB_COUNT notes are connected here, so an unconnected note
        // would get onto the list unless it is left out on purpose.
        const hubs = analyzeFolder(FOLDER).hubs;
        expect(hubs.slice(0, 3)).toEqual(["hub.md", "a.md", "b.md"]);
        expect(hubs).not.toContain("lone.md");
    });

    it("an orphan should be a note no resolved reference touches, dangling ones included", () => {
        const f = index([...FOLDER.nodes, node("only-dangling.md")], [...FOLDER.edges, edge("only-dangling.md", null, "Nowhere")]);
        expect(analyzeFolder(f).orphans).toEqual(["lone.md", "only-dangling.md"]);
    });

    it("dangling references should be grouped by what they name, the most named first", () => {
        expect(analyzeFolder(FOLDER).dangling).toEqual([
            { target: "Ghost", from: ["a.md", "c.md"] },
            { target: "Other", from: ["b.md"] },
        ]);
        // Where the name order and the count order disagree, the count wins.
        const f = index([node("a.md"), node("b.md")], [edge("a.md", null, "Alpha"), edge("a.md", null, "Zed"), edge("b.md", null, "Zed")]);
        expect(analyzeFolder(f).dangling.map((d) => d.target)).toEqual(["Zed", "Alpha"]);
    });

    it("hubs should stop at the list's length and leave out notes with no references", () => {
        const many = Array.from({ length: HUB_COUNT + 5 }, (_, i) => node(`n${i}.md`));
        const edges = many.slice(1).map((n) => edge(n.path, "n0.md"));
        const hubs = analyzeFolder(index([...many, node("zero.md")], edges)).hubs;
        expect(hubs).toHaveLength(HUB_COUNT);
        expect(hubs[0]).toBe("n0.md");
        expect(hubs).not.toContain("zero.md");
    });
});

describe("filterNotes", () => {
    it("a type filter should keep only those types, an untyped note spelled as the empty type", () => {
        expect([...filterNotes(FOLDER, { types: new Set(["metric", ""]), statuses: null, query: "" })].sort())
            .toEqual(["a.md", "b.md", "c.md", "lone.md"]);
    });

    it("a query should match a name or a path, ignoring case", () => {
        expect([...filterNotes(FOLDER, { types: null, statuses: null, query: "HU" })]).toEqual(["hub.md"]);
    });

    it("a query should also match a tag, with or without its hash", () => {
        const f = index([{ ...node("a.md"), tags: ["Planning"] }, node("b.md")], []);
        expect([...filterNotes(f, { types: null, statuses: null, query: "plan" })]).toEqual(["a.md"]);
        expect([...filterNotes(f, { types: null, statuses: null, query: "#planning" })]).toEqual(["a.md"]);
    });

    it("a status filter should keep only those statuses, a note with none spelled as the empty status", () => {
        const f = index([{ ...node("a.md"), status: "draft" }, { ...node("b.md"), status: "stable" }, node("c.md")], []);
        expect([...filterNotes(f, { types: null, statuses: new Set(["draft", ""]), query: "" })].sort()).toEqual(["a.md", "c.md"]);
    });
});

describe("createForceLayout", () => {
    /** Step until settled, bounded so a step that never advances fails rather than hangs. */
    const settle = (f: FolderIndex) => {
        const layout = createForceLayout(f);
        let clock = 0;
        let settled = false;
        for (let calls = 0; calls < 10_000 && !settled; calls++) { settled = layout.step(1, () => clock++); }
        expect(settled).toBe(true);
        return layout;
    };

    it("the same folder should settle to the same positions, whatever order the index lists it in", () => {
        const shuffled = index([...FOLDER.nodes].reverse(), [...FOLDER.edges].reverse());
        const at = (l: ReturnType<typeof settle>) => [...l.positions()].sort().map(([p, v]) => `${p}:${v.x.toFixed(3)},${v.y.toFixed(3)}`);
        expect(at(settle(shuffled))).toEqual(at(settle(FOLDER)));
    });

    it("linked notes should end nearer each other than a note nothing links", () => {
        const pos = settle(FOLDER).positions();
        const d = (a: string, b: string) => Math.hypot(pos.get(a)!.x - pos.get(b)!.x, pos.get(a)!.y - pos.get(b)!.y);
        const linked = Math.max(d("a.md", "hub.md"), d("b.md", "hub.md"), d("c.md", "hub.md"));
        expect(d("lone.md", "hub.md")).toBeGreaterThan(linked);
    });

    it("a step should stop at its budget but always run at least one iteration", () => {
        const layout = createForceLayout(FOLDER);
        let clock = 0;
        layout.step(5, () => { clock += 10; return clock; });
        expect(layout.iterations).toBe(1);
        clock = 0;
        layout.step(5, () => clock++);
        expect(layout.iterations).toBeGreaterThan(2);
    });

    it("a folder at the index's cap should settle within the iteration limit, and stay finite", () => {
        const n = 2000;
        const nodes = Array.from({ length: n }, (_, i) => node(`d${i % 40}/n${i}.md`));
        const edges = nodes.flatMap((nd, i) => [1, 2, 3].map((k) => edge(nd.path, nodes[(i * 7 + k * 13) % n]!.path)));
        const layout = createForceLayout(index(nodes, edges));
        let settled = false;
        for (let calls = 0; calls < 1000 && !settled; calls++) { settled = layout.step(1e9, () => performance.now()); }
        expect(settled).toBe(true);
        expect(layout.iterations).toBeLessThanOrEqual(layout.maxIterations);
        for (const [, v] of layout.positions()) { expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true); }
        // How long that takes, and whether it holds a frame, is e2e/folderGraph's to measure.
        // A budget sized from the settle's own cost with the machine to itself
        // (`pnpm exec vitest run` this file alone), not the runner's default,
        // which a peer's browser sweep on the same box has tripped.
    }, budget(30_000));
});
