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
 * Direction is kept on every edge in the model, because "this note cites
 * that one" and "that one cites this" are different claims and the Backlinks
 * tab beside this is exactly the second half; the drawing does not show it
 * (./ringStage.ts), which keeps the picture to who is near whom.
 *
 * The rings are not drawn as perfect circles, and the reason is meaning, not
 * ornament: where a note sits says how bound it is and what it is related
 * to (`layoutRings`).
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
    /** A second-ring note's first-ring neighbour, whose arc it is drawn in (`layoutRings`). */
    parent?: string;
    /** OKF `type`, null when the note carries none (and always for a dangling node). */
    type: string | null;
    /** A reference that resolves to no note: drawn, never opened. */
    dangling: boolean;
    /**
     * On the drawing only because its content is alike (`FolderIndex.similar`),
     * not because either note refers to the other.
     */
    alike?: boolean;
    /** References touching the note anywhere in the index, both directions. */
    degree: number;
    /**
     * How alive the note is, from 0 (`activityOf` in ./folderSignals.ts), or
     * null when unknown. Absent on a drawing that does not weigh activity,
     * which is every one but the folder overview's.
     */
    activity?: number | null;
    x: number;
    y: number;
}

export interface GraphLine {
    from: string;
    to: string;
    /** How many references `from` makes to `to`: what a tie's strength is counted in (`layoutRings`). */
    weight: number;
    /**
     * A tie of likeness, not a reference (`FolderIndex.similar`): drawn
     * dashed, and its `weight` is `ALIKE_PULL` of its score, so it places a
     * note further out than any reference would.
     */
    alike?: boolean;
}

/** Most first-ring notes that are there for likeness alone. */
export const ALIKE_CAP = 4;

/** What a likeness weighs against a reference's 1, per point of its score. */
export const ALIKE_PULL = 0.5;

/**
 * The lines of likeness among `drawn` notes that no reference already joins:
 * a pair the reader linked is a link, and saying it is also alike adds
 * nothing.
 */
function alikeLines(index: FolderIndex, drawn: ReadonlySet<string>, linked: ReadonlySet<string>): GraphLine[] {
    return (index.similar ?? [])
        .filter((p) => drawn.has(p.a) && drawn.has(p.b) && !linked.has(`${p.a}\u0000${p.b}`) && !linked.has(`${p.b}\u0000${p.a}`))
        .map((p) => ({ from: p.a, to: p.b, weight: p.score * ALIKE_PULL, alike: true }));
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

    // Notes alike to this one in what they say and joined to it by no
    // reference, most alike first: on the first ring, for likeness alone.
    // Added after the outer ring is chosen, so the outer ring is still the
    // notes this one's references reach, never neighbours of a guess.
    const placed = new Set([self, ...ring1, ...ring2]);
    const alike = (index.similar ?? [])
        .filter((p) => (p.a === self || p.b === self) && !placed.has(p.a === self ? p.b : p.a) && nodesByPath.has(p.a === self ? p.b : p.a))
        .sort((x, y) => y.score - x.score || (x.a === self ? x.b : x.a).localeCompare(y.a === self ? y.b : y.a))
        .slice(0, ALIKE_CAP)
        .map((p) => (p.a === self ? p.b : p.a));

    const drawn = new Set([self, ...ring1, ...alike, ...ring2]);
    const typeOf = (id: string): string | null => nodesByPath.get(id)?.type ?? null;
    const types = [...new Set([...drawn].map(typeOf).filter((t): t is string => t !== null))].sort();

    const alikeSet = new Set(alike);
    const nodes: GraphNode[] = [
        ...[self].map((id) => ({ id, ring: 0 as const })),
        ...ring1.map((id) => ({ id, ring: 1 as const })),
        ...alike.map((id) => ({ id, ring: 1 as const })),
        ...ring2.map((id) => ({ id, ring: 2 as const })),
    ].map(({ id, ring }) => ({
        id,
        label: name(id),
        ring,
        type: typeOf(id),
        dangling: id.startsWith(DANGLING),
        degree: degree.get(id) ?? 0,
        ...(alikeSet.has(id) ? { alike: true } : {}),
        x: 0,
        y: 0,
    }));

    const lines: GraphLine[] = [];
    const lineSeen = new Map<string, GraphLine>();
    for (const e of index.edges) {
        // Only this note's dangling targets are drawn, so the membership test
        // is what keeps every other note's dangling reference off the drawing.
        const to = e.to ?? DANGLING + e.target;
        if (e.from === to || !drawn.has(e.from) || !drawn.has(to)) { continue; }
        const key = `${e.from}\u0000${to}`;
        const known = lineSeen.get(key);
        if (known) { known.weight++; continue; }
        const line = { from: e.from, to, weight: 1 };
        lineSeen.set(key, line);
        lines.push(line);
    }
    lines.push(...alikeLines(index, drawn, new Set(lineSeen.keys())));
    return { nodes, lines, omitted, types };
}

/**
 * Place the nodes on rings around the centre of a `size` square, where
 * DISTANCE MEANS SOMETHING, because nearness is the one cue a reader takes
 * in before reading a single label: two dots close together read as
 * belonging together, and a gap reads as a boundary. So nothing here is
 * placed at random, and two things are encoded in where a note sits.
 *
 * - How far from the centre: how bound the note is to the note it hangs
 *   from, counted in references both ways (`ties`). The most bound sits
 *   `BAND` inside its ring, the least bound `BAND` outside, so a note linked
 *   both ways and often sits nearer than one named once. The rings stay
 *   apart: a second-ring note is always further out than any first-ring one.
 * - Who is beside whom round the ring: first-ring notes that refer to each
 *   other are placed next to each other (`ringOrder`), and a run of related
 *   notes is set apart from the next by a wider gap (`GAP`), so groups read
 *   as arcs with space between them. Where no two of them are related, the
 *   ring is evenly spaced, so no grouping is claimed that is not there.
 *
 * Each second-ring note hangs from the first-ring note it is most bound to,
 * in that note's arc. The same graph is placed the same way every time,
 * whatever order the index lists it in.
 */
export function layoutRings(graph: LocalGraph, size: number): LocalGraph {
    const c = size / 2;
    const hasRing2 = graph.nodes.some((n) => n.ring === 2);
    const r1 = size * (hasRing2 ? 0.26 : 0.34);
    const r2 = size * 0.43;
    const tie = ties(graph);
    const centre = graph.nodes.find((n) => n.ring === 0)?.id ?? "";
    const ring1 = ringOrder(graph.nodes.filter((n) => n.ring === 1), centre, tie);

    // Angles: a unit between related neighbours, `GAP` units between
    // unrelated ones, the whole ring shared out in proportion. A ring with
    // no related pair, or no unrelated one, is evenly spaced.
    const angle = new Map<string, number>();
    const share = new Map<string, number>();
    const gaps = ring1.map((n, i) => (ring1.length > 1 && tie(n.id, ring1[(i + 1) % ring1.length]!.id) > 0 ? 1 : GAP));
    const grouped = gaps.includes(1) && gaps.includes(GAP);
    const units = grouped ? gaps.reduce((a, b) => a + b, 0) : ring1.length;
    let at = -Math.PI / 2;
    ring1.forEach((n, i) => {
        angle.set(n.id, at);
        const advance = ((grouped ? gaps[i]! : 1) / units) * 2 * Math.PI;
        share.set(n.id, advance);
        at += advance;
    });

    // A second-ring note hangs from the first-ring note it is most bound to;
    // a tie goes to the one that comes first round the ring.
    const parentOf = new Map<string, string>();
    for (const n of graph.nodes) {
        if (n.ring !== 2) { continue; }
        let best: string | undefined;
        for (const p of ring1) {
            const t = tie(n.id, p.id);
            if (t > 0 && (best === undefined || t > tie(n.id, best))) { best = p.id; }
        }
        if (best !== undefined) { parentOf.set(n.id, best); }
    }
    const children = new Map<string, string[]>();
    for (const [child, p] of parentOf) {
        if (!children.has(p)) { children.set(p, []); }
        children.get(p)!.push(child);
    }
    for (const [p, ids] of children) {
        ids.sort();
        const span = Math.min(share.get(p) || 2 * Math.PI, Math.PI / 2) * 0.8;
        ids.forEach((id, j) => {
            angle.set(id, angle.get(p)! + (ids.length === 1 ? 0 : (j / (ids.length - 1) - 0.5) * span));
        });
    }

    // Radii: within its ring's band, nearer the more bound.
    const boundTo = (n: GraphNode): number => n.ring === 1 ? tie(n.id, centre) : tie(n.id, parentOf.get(n.id) ?? "");
    const most = new Map<number, number>([1, 2].map((r) => [r, Math.max(1, ...graph.nodes.filter((n) => n.ring === r).map(boundTo))]));
    const nodes = graph.nodes.map((n) => {
        if (n.ring === 0) { return { ...n, x: c, y: c }; }
        const a = angle.get(n.id) ?? 0;
        const strength = boundTo(n) / most.get(n.ring)!;
        const r = (n.ring === 1 ? r1 : r2) * (1 + BAND - 2 * BAND * strength);
        const parent = n.ring === 2 ? parentOf.get(n.id) : undefined;
        return { ...n, x: c + r * Math.cos(a), y: c + r * Math.sin(a), ...(parent !== undefined ? { parent } : {}) };
    });
    return { ...graph, nodes };
}

/** How far either side of its ring a note may sit by how bound it is, as a fraction of the ring's radius. */
export const BAND = 0.14;

/** The angle between two unrelated first-ring neighbours, against 1 for two related ones. */
export const GAP = 1.8;

/** The strength of the tie between two drawn notes: references both ways, each counted. */
export function ties(graph: LocalGraph): (a: string, b: string) => number {
    const w = new Map<string, number>();
    const key = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
    for (const line of graph.lines) { w.set(key(line.from, line.to), (w.get(key(line.from, line.to)) ?? 0) + line.weight); }
    return (a, b) => w.get(key(a, b)) ?? 0;
}

/**
 * The first ring in the order it is drawn round: start from the note most
 * bound to the centre, then repeatedly take the unplaced note most bound to
 * the last one placed, so related notes sit side by side; when the last one
 * is related to none left, start the next run from the note most bound to
 * the centre among the rest. Ties go by name, then path, so the order is
 * the same however the index lists the notes.
 */
export function ringOrder(ring1: readonly GraphNode[], centre: string, tie: (a: string, b: string) => number): GraphNode[] {
    const rest = [...ring1].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const out: GraphNode[] = [];
    const strongest = (to: string): GraphNode => rest.reduce((best, n) => (tie(to, n.id) > tie(to, best.id) ? n : best), rest[0]!);
    while (rest.length > 0) {
        const last = out[out.length - 1];
        const next = last ? strongest(last.id) : undefined;
        const pick = next && last && tie(last.id, next.id) > 0 ? next : strongest(centre);
        out.push(pick);
        rest.splice(rest.indexOf(pick), 1);
    }
    return out;
}

/**
 * A number in [0, 1) fixed by `id` and `salt`: FNV-1a over the UTF-16 units.
 * For choices that carry no meaning and must still be the same every time,
 * such as which way a line bows (./ringStage.ts); never for where a note
 * sits, which a reader takes as meaning.
 */
export function nudge(id: string, salt: number): number {
    let h = 0x811c9dc5 ^ salt;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) / 0x1_0000_0000;
}

/** The hue slot a node's type draws in: 0 to TYPE_HUES - 1, or null for none. */
export function hueOf(types: readonly string[], type: string | null): number | null {
    if (type === null) { return null; }
    const i = types.indexOf(type);
    return i >= 0 && i < TYPE_HUES ? i : null;
}

/**
 * A subject (./folderSignals.ts `FolderSubject`) as a ring drawing: its core
 * at the centre, the notes tied to the core on the first ring (`near`, the
 * subject's own answer, which counts a shared tag as a tie; the notes linked
 * to the core when it is not given), and the rest of the subject, the notes
 * leaning in from elsewhere included, on the second, each capped as a note's
 * own rings are. Lines are every reference between two drawn notes; a
 * reference out of the subject is not drawn, since the drawing is OF the
 * subject, and a tie by tag has no line, since no note names the other.
 */
export function buildSubjectGraph(index: FolderIndex, core: string, notes: readonly string[],
                                  near?: readonly string[]): LocalGraph | null {
    const nodesByPath = new Map(index.nodes.map((n) => [n.path, n]));
    if (!nodesByPath.has(core)) { return null; }
    const inSubject = new Set([core, ...notes.filter((n) => nodesByPath.has(n))]);
    const degree = new Map<string, number>();
    const touchesCore = new Set<string>();
    for (const e of index.edges) {
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
        if (e.to === null || e.to === e.from) { continue; }
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
        if (e.from === core) { touchesCore.add(e.to); }
        if (e.to === core) { touchesCore.add(e.from); }
    }
    const name = (id: string): string => nodesByPath.get(id)!.name;
    const order = byDegreeThenName(degree, name);
    const rest = [...inSubject].filter((n) => n !== core);
    const tied = near ? new Set(near) : touchesCore;
    const ring1All = rest.filter((n) => tied.has(n)).sort(order);
    const ring1 = ring1All.slice(0, RING_CAPACITY[1]);
    const ring2All = rest.filter((n) => !tied.has(n)).sort(order);
    const ring2 = ring1.length > 0 ? ring2All.slice(0, RING_CAPACITY[2]) : [];
    const omitted = ring1All.length - ring1.length + ring2All.length - ring2.length;
    const drawn = new Set([core, ...ring1, ...ring2]);
    const typeOf = (id: string): string | null => nodesByPath.get(id)?.type ?? null;
    const types = [...new Set([...drawn].map(typeOf).filter((t): t is string => t !== null))].sort();
    const nodes: GraphNode[] = [
        { id: core, ring: 0 as const },
        ...ring1.map((id) => ({ id, ring: 1 as const })),
        ...ring2.map((id) => ({ id, ring: 2 as const })),
    ].map(({ id, ring }) => ({ id, label: name(id), ring, type: typeOf(id), dangling: false, degree: degree.get(id) ?? 0, x: 0, y: 0 }));
    const lines: GraphLine[] = [];
    const seen = new Map<string, GraphLine>();
    for (const e of index.edges) {
        if (e.to === null || e.to === e.from || !drawn.has(e.from) || !drawn.has(e.to)) { continue; }
        const key = `${e.from}\u0000${e.to}`;
        const known = seen.get(key);
        if (known) { known.weight++; continue; }
        const line = { from: e.from, to: e.to, weight: 1 };
        seen.set(key, line);
        lines.push(line);
    }
    lines.push(...alikeLines(index, drawn, new Set(seen.keys())));
    return { nodes, lines, omitted, types };
}
