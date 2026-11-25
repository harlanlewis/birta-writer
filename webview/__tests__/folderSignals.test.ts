/**
 * What a folder says beyond its links (components/graph/folderSignals.ts):
 * activity, fading notes and subjects, each held to the claim its header
 * makes, over indexes built here so every date and tag is the test's.
 */
import { describe, it, expect } from "vitest";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { toIndexDay } from "../../shared/folderIndex";
import {
    ACTIVITY_HALF_LIFE_DAYS,
    FADING_AFTER_DAYS,
    REFERENCE_CARRY,
    activityOf,
    fadingNotes,
    folderSubjects,
    louvain,
    nameSubject,
    subjectWeights,
} from "../components/graph/folderSignals";
import { buildSubjectGraph } from "../components/graph/localGraph";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 24);
const ago = (days: number): number => NOW - days * DAY;

const node = (path: string, opts: { modified?: number | null; tags?: string[]; name?: string } = {}): FolderNode => ({
    path,
    name: opts.name ?? path.replace(/^.*\//, "").replace(/\.md$/, ""),
    type: null,
    tags: opts.tags ?? [],
    status: null,
    trust: null,
    staleAfter: null,
    ...(opts.modified === undefined ? {} : { modified: opts.modified }),
});
const edge = (from: string, to: string | null): FolderEdge =>
    ({ from, to, target: to ?? "x", kind: "wiki", text: "", line: 1 });
const index = (nodes: FolderNode[], edges: FolderEdge[]): FolderIndex => ({ rootName: "v", nodes, edges, truncated: false });

/** Every pair of `paths` linked once. */
const clique = (paths: string[]): FolderEdge[] =>
    paths.flatMap((a, i) => paths.slice(i + 1).map((b) => edge(a, b)));

describe("toIndexDay", () => {
    it("an instant should round down to the start of its UTC day", () => {
        expect(toIndexDay(Date.UTC(2026, 10, 24, 23, 59))).toBe(Date.UTC(2026, 10, 24));
        expect(toIndexDay(Date.UTC(2026, 10, 24))).toBe(Date.UTC(2026, 10, 24));
    });
});

describe("activityOf", () => {
    it("a write should count fully today and half after the half-life", () => {
        const a = activityOf(index([node("today.md", { modified: NOW }), node("month.md", { modified: ago(ACTIVITY_HALF_LIFE_DAYS) })], []), null, NOW);
        expect(a.get("today.md")).toBeCloseTo(1);
        expect(a.get("month.md")).toBeCloseTo(0.5);
    });

    it("a note with no date, not opened and named by nothing active should be unknown, not old", () => {
        const a = activityOf(index([node("x.md")], []), [], NOW);
        expect(a.get("x.md")).toBeNull();
    });

    it("the recent files should rank from one down to a half, beating an old write", () => {
        const idx = index([node("a.md", { modified: ago(400) }), node("b.md"), node("c.md")], []);
        const a = activityOf(idx, ["a.md", "b.md", "c.md"], NOW);
        expect(a.get("a.md")).toBeCloseTo(1);
        expect(a.get("b.md")).toBeCloseTo(0.75);
        expect(a.get("c.md")).toBeCloseTo(0.5);
    });

    it("a note an active note refers to should carry part of its activity, one step and no further", () => {
        const idx = index(
            [node("busy.md", { modified: NOW }), node("ref.md", { modified: ago(365) }), node("far.md", { modified: ago(365) })],
            [edge("busy.md", "ref.md"), edge("ref.md", "far.md")],
        );
        const a = activityOf(idx, null, NOW);
        expect(a.get("ref.md")).toBeCloseTo(REFERENCE_CARRY);
        // far.md is two steps from the busy note: it keeps only its own old write.
        expect(a.get("far.md")!).toBeLessThan(0.01);
    });
});

describe("fadingNotes", () => {
    /** An old hub named by five old notes, and a young note that names one of them. */
    function vault(hubWritten: number, youngNamesHub: boolean): FolderIndex {
        const spokes = Array.from({ length: 5 }, (_, i) => node(`s${i}.md`, { modified: ago(300) }));
        return index(
            [node("hub.md", { modified: hubWritten }), ...spokes, node("young.md", { modified: ago(2) })],
            [...spokes.map((s) => edge(s.path, "hub.md")), ...(youngNamesHub ? [edge("young.md", "hub.md")] : [edge("young.md", "s0.md")])],
        );
    }

    it("a connected note unwritten for months and named by nothing recent should be fading", () => {
        const f = fadingNotes(vault(ago(FADING_AFTER_DAYS + 30), false), [], NOW);
        expect(f.map((n) => n.path)).toEqual(["hub.md"]);
        expect(f[0]!.degree).toBe(5);
    });

    it("a note something written recently still refers to should not be fading", () => {
        expect(fadingNotes(vault(ago(FADING_AFTER_DAYS + 30), true), [], NOW).map((n) => n.path)).not.toContain("hub.md");
    });

    it("a note written inside the window, or opened recently, should not be fading", () => {
        expect(fadingNotes(vault(ago(FADING_AFTER_DAYS - 1), false), [], NOW)).toEqual([]);
        expect(fadingNotes(vault(ago(FADING_AFTER_DAYS + 30), false), ["hub.md"], NOW)).toEqual([]);
    });

    it("a host that sends no dates should get no fading list rather than every note", () => {
        const spokes = Array.from({ length: 5 }, (_, i) => node(`s${i}.md`));
        const idx = index([node("hub.md"), ...spokes], spokes.map((s) => edge(s.path, "hub.md")));
        expect(fadingNotes(idx, null, NOW)).toEqual([]);
    });
});

describe("louvain", () => {
    const groupA = ["a1.md", "a2.md", "a3.md", "a4.md", "a5.md"];
    const groupB = ["b1.md", "b2.md", "b3.md", "b4.md", "b5.md"];

    function twoGroups(): FolderIndex {
        // Two dense groups and a hub linked to every note in both: the shape
        // that floods label propagation into one community.
        return index(
            [...groupA, ...groupB, "hub.md"].map((p) => node(p)),
            [...clique(groupA), ...clique(groupB), ...[...groupA, ...groupB].map((p) => edge(p, "hub.md"))],
        );
    }

    it("two dense groups joined by a hub should come back as two communities, not one", () => {
        const c = louvain(subjectWeights(twoGroups()));
        expect(c.size).toBe(11);
        expect(new Set(groupA.map((p) => c.get(p))).size).toBe(1);
        expect(new Set(groupB.map((p) => c.get(p))).size).toBe(1);
        expect(c.get("a1.md")).not.toBe(c.get("b1.md"));
    });

    it("the same folder listed in another order should divide the same way", () => {
        const idx = twoGroups();
        const shuffled = { ...idx, nodes: [...idx.nodes].reverse(), edges: [...idx.edges].reverse() };
        const a = louvain(subjectWeights(idx));
        const b = louvain(subjectWeights(shuffled));
        const groupsOf = (m: Map<string, string>) => [...new Set(m.values())].map((c) => [...m].filter(([, x]) => x === c).map(([n]) => n).sort().join()).sort();
        expect(groupsOf(a)).toEqual(groupsOf(b));
    });

    it("notes that share only a tag should still group, and a vault-wide tag should not join everything", () => {
        const tagged = ["t1.md", "t2.md", "t3.md"].map((p) => node(p, { tags: ["Garden"] }));
        const w = subjectWeights(index(tagged, []));
        expect(w.get("t1.md")?.get("t2.md")).toBeCloseTo(0.5);
        const everyone = Array.from({ length: 50 }, (_, i) => node(`n${i}.md`, { tags: ["note"] }));
        expect(subjectWeights(index(everyone, [])).size).toBe(0);
    });
});

describe("nameSubject", () => {
    it("a tag most members carry should name the subject", () => {
        const idx = index([node("a.md", { tags: ["hiring"] }), node("b.md", { tags: ["Hiring"] }), node("c.md")], []);
        expect(nameSubject(idx, ["a.md", "b.md", "c.md"], "a.md")).toBe("#hiring");
    });

    it("words the members' names share, and the rest of the folder does not, should name it", () => {
        const idx = index([
            node("1.md", { name: "Garden soil test" }), node("2.md", { name: "Garden beds plan" }), node("3.md", { name: "Soil amendments" }),
            node("4.md", { name: "Quarterly plan" }), node("5.md", { name: "Budget plan" }),
        ], []);
        expect(nameSubject(idx, ["1.md", "2.md", "3.md"], "1.md")).toBe("Garden · Soil");
    });

    it("members that share nothing should be named for the core", () => {
        const idx = index([node("a.md", { name: "Alpha" }), node("b.md", { name: "Beta" }), node("c.md", { name: "Gamma" })], []);
        expect(nameSubject(idx, ["a.md", "b.md", "c.md"], "b.md")).toBe("Beta");
    });
});

describe("folderSubjects", () => {
    it("subjects should come liveliest first, with their core most bound in and a leaning note listed as also", () => {
        const old = ["o1.md", "o2.md", "o3.md", "o4.md"];
        const live = ["l1.md", "l2.md", "l3.md", "l4.md"];
        const idx = index(
            [...old.map((p) => node(p, { modified: ago(500) })), ...live.map((p) => node(p, { modified: ago(1) })),
                node("bridge.md", { modified: ago(500) })],
            // bridge.md belongs with the old group (three links) and leans into
            // the live one (two links): two of five is over a third.
            [...clique(old), ...clique(live), edge("l1.md", "l2.md"),
                edge("bridge.md", "o1.md"), edge("bridge.md", "o2.md"), edge("bridge.md", "o3.md"),
                edge("bridge.md", "l1.md"), edge("bridge.md", "l2.md")],
        );
        const subjects = folderSubjects(idx, activityOf(idx, null, NOW));
        expect(subjects).toHaveLength(2);
        expect(subjects[0]!.members.sort()).toEqual([...live].sort());
        expect(subjects[0]!.core).toBe("l1.md");
        expect(subjects[0]!.also).toEqual(["bridge.md"]);
        expect(subjects[1]!.members).toContain("bridge.md");
        expect(subjects[0]!.activity!).toBeGreaterThan(subjects[1]!.activity!);
    });

    it("a subject held together by tags alone should still have notes tied to its core, for the drawing's first ring", () => {
        const idx = index(["t1.md", "t2.md", "t3.md", "t4.md"].map((p) => node(p, { tags: ["garden"] })), []);
        const [subject] = folderSubjects(idx, activityOf(idx, null, NOW));
        expect(subject!.members).toHaveLength(4);
        expect(subject!.nearCore.sort()).toEqual(subject!.members.filter((m) => m !== subject!.core).sort());
        // Drawn as rings, not as the core alone with "3 more not shown".
        const graph = buildSubjectGraph(idx, subject!.core, subject!.members, subject!.nearCore)!;
        expect(graph.nodes.filter((n) => n.ring === 1)).toHaveLength(3);
        expect(graph.omitted).toBe(0);
    });

    it("a group smaller than the minimum, or a note with no ties, should be no subject", () => {
        const idx = index([node("a.md"), node("b.md"), node("lone.md")], [edge("a.md", "b.md")]);
        expect(folderSubjects(idx, activityOf(idx, null, NOW))).toEqual([]);
    });
});
