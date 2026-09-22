/**
 * components/graph/localGraph.ts
 *
 * The local graph of one note (MAR-481): the note, the notes it names and
 * that name it, and at depth 2 their neighbours in turn, taken from the
 * host's folder index (shared/folderIndex.ts) and laid out on rings. Pure:
 * no DOM, so what is drawn and where is testable on its own.
 *
 * A radial layout rather than a force-directed one, on purpose. An ego
 * network has one node that matters, and a ring layout puts it in the middle
 * every time; it is deterministic, so a note whose links did not change is
 * drawn exactly as it was, where a force layout reshuffles on every open. The
 * vendored Graphviz engine is the whole-folder view's (MAR-482), where the
 * node count is the problem a spring model solves.
 *
 * Direction is kept on every edge and drawn, because "this note cites that
 * one" and "that one cites this" are different claims, and the Backlinks tab
 * beside this is exactly the second half.
 */
import type { FolderEdge, FolderIndex } from "../../../shared/folderIndex";

export type GraphDepth = 1 | 2;

export interface GraphNode {
    /** A note's root-relative path, or `dangling:<target>` for a reference to no note. */
    id: string;
    /** The note's name, or the dangling reference's target as written. */
    label: string;
    /** 0 for this note, 1 for its neighbours, 2 for theirs. */
    ring: 0 | 1 | 2;
    /** OKF `type`, null when the note carries none (and always for a dangling node). */
    type: string | null;
    /** A reference that resolves to no note: drawn, never opened. */
    dangling: boolean;
    /** References touching the note anywhere in the index, both directions. */
    degree: number;
    x: number;
    y: number;
}

export interface GraphLine {
    from: string;
    to: string;
}

export interface LocalGraph {
    nodes: GraphNode[];
    lines: GraphLine[];
    /** Neighbours left out to keep the rings legible, so the view can say so. */
    omitted: number;
    /** The distinct OKF types drawn, in the order their hues are assigned. */
    types: string[];
}

/** Most neighbours a ring holds before the least connected are left out. */
export const RING_CAPACITY: Readonly<Record<1 | 2, number>> = { 1: 16, 2: 32 };

/** How many distinct hues types get before the rest share one. */
export const TYPE_HUES = 6;

const DANGLING = "dangling:";

function byDegreeThenName(degree: Map<string, number>, name: (id: string) => string) {
    return (a: string, b: string): number =>
        (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || name(a).localeCompare(name(b)) || a.localeCompare(b);
}

/**
 * Which notes the local graph of `self` holds, and on which ring, before any
 * position is decided. Null when the index does not hold `self`.
 */
export function buildLocalGraph(index: FolderIndex, self: string, depth: GraphDepth): LocalGraph | null {
    const nodesByPath = new Map(index.nodes.map((n) => [n.path, n]));
    if (!nodesByPath.has(self)) { return null; }
    const name = (id: string): string => nodesByPath.get(id)?.name ?? id.slice(DANGLING.length);

    // Undirected adjacency over resolved references, for rings and degree.
    const neighbours = new Map<string, Set<string>>();
    const degree = new Map<string, number>();
    const link = (a: string, b: string): void => {
        if (!neighbours.has(a)) { neighbours.set(a, new Set()); }
        neighbours.get(a)!.add(b);
    };
    for (const e of index.edges) {
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
        if (e.to === null || e.to === e.from) { continue; }
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
        link(e.from, e.to);
        link(e.to, e.from);
    }

    const order = byDegreeThenName(degree, name);
    const ring1All = [...(neighbours.get(self) ?? [])].sort(order);
    // This note's own dangling references are neighbours too: what it names
    // and the folder does not hold is part of what the note says.
    const dangling = [...new Set(index.edges
        .filter((e: FolderEdge) => e.from === self && e.to === null)
        .map((e) => DANGLING + e.target))].sort();
    const ring1Candidates = [...ring1All, ...dangling];
    const ring1 = ring1Candidates.slice(0, RING_CAPACITY[1]);
    let omitted = ring1Candidates.length - ring1.length;

    let ring2: string[] = [];
    if (depth === 2) {
        const seen = new Set([self, ...ring1Candidates]);
        const candidates = new Set<string>();
        for (const n of ring1) {
            for (const m of neighbours.get(n) ?? []) { if (!seen.has(m)) { candidates.add(m); } }
        }
        const all = [...candidates].sort(order);
        ring2 = all.slice(0, RING_CAPACITY[2]);
        omitted += all.length - ring2.length;
    }

    const drawn = new Set([self, ...ring1, ...ring2]);
    const typeOf = (id: string): string | null => nodesByPath.get(id)?.type ?? null;
    const types = [...new Set([self, ...ring1, ...ring2].map(typeOf).filter((t): t is string => t !== null))].sort();

    const nodes: GraphNode[] = [
        ...[self].map((id) => ({ id, ring: 0 as const })),
        ...ring1.map((id) => ({ id, ring: 1 as const })),
        ...ring2.map((id) => ({ id, ring: 2 as const })),
    ].map(({ id, ring }) => ({
        id,
        label: name(id),
        ring,
        type: typeOf(id),
        dangling: id.startsWith(DANGLING),
        degree: degree.get(id) ?? 0,
        x: 0,
        y: 0,
    }));

    const lines: GraphLine[] = [];
    const lineSeen = new Set<string>();
    for (const e of index.edges) {
        // Only this note's dangling targets are drawn, so the membership test
        // is what keeps every other note's dangling reference off the drawing.
        const to = e.to ?? DANGLING + e.target;
        if (e.from === to || !drawn.has(e.from) || !drawn.has(to)) { continue; }
        const key = `${e.from}\u0000${to}`;
        if (lineSeen.has(key)) { continue; }
        lineSeen.add(key);
        lines.push({ from: e.from, to });
    }
    return { nodes, lines, omitted, types };
}

/**
 * Place the nodes on rings around the centre of a `size` square: this note in
 * the middle, its neighbours evenly round the first ring in name order (so the
 * same neighbours are always drawn in the same places, whatever order the
 * index lists them in), and each second-ring note in the arc of the
 * first-ring note it hangs from.
 */
export function layoutRings(graph: LocalGraph, size: number): LocalGraph {
    const c = size / 2;
    const hasRing2 = graph.nodes.some((n) => n.ring === 2);
    const r1 = size * (hasRing2 ? 0.26 : 0.34);
    const r2 = size * 0.43;
    const ring1 = graph.nodes.filter((n) => n.ring === 1).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const angle = new Map<string, number>();
    const step = ring1.length > 0 ? (2 * Math.PI) / ring1.length : 0;
    ring1.forEach((n, i) => { angle.set(n.id, -Math.PI / 2 + i * step); });

    // A second-ring note hangs from the first-ring neighbour that comes first
    // round the ring, and shares that neighbour's arc with its siblings.
    const parentOf = new Map<string, string>();
    for (const line of graph.lines) {
        for (const [a, b] of [[line.from, line.to], [line.to, line.from]] as const) {
            if (!angle.has(a)) { continue; }
            const child = graph.nodes.find((n) => n.id === b && n.ring === 2);
            if (!child) { continue; }
            const current = parentOf.get(b);
            if (current === undefined || angle.get(a)! < angle.get(current)!) { parentOf.set(b, a); }
        }
    }
    const children = new Map<string, string[]>();
    for (const n of graph.nodes) {
        if (n.ring !== 2) { continue; }
        const p = parentOf.get(n.id);
        if (p === undefined) { continue; }
        if (!children.has(p)) { children.set(p, []); }
        children.get(p)!.push(n.id);
    }
    for (const [p, ids] of children) {
        ids.sort();
        const span = Math.min(step || 2 * Math.PI, Math.PI / 2) * 0.8;
        ids.forEach((id, j) => {
            angle.set(id, angle.get(p)! + (ids.length === 1 ? 0 : (j / (ids.length - 1) - 0.5) * span));
        });
    }

    const nodes = graph.nodes.map((n) => {
        if (n.ring === 0) { return { ...n, x: c, y: c }; }
        const a = angle.get(n.id) ?? 0;
        const r = n.ring === 1 ? r1 : r2;
        return { ...n, x: c + r * Math.cos(a), y: c + r * Math.sin(a) };
    });
    return { ...graph, nodes };
}

/** The hue slot a node's type draws in: 0 to TYPE_HUES - 1, or null for none. */
export function hueOf(types: readonly string[], type: string | null): number | null {
    if (type === null) { return null; }
    const i = types.indexOf(type);
    return i >= 0 && i < TYPE_HUES ? i : null;
}
