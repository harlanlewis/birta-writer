/**
 * components/graph/folderGraph.ts
 *
 * The whole folder as a graph (MAR-482): what the view is opened to answer,
 * and where each note is drawn. Pure: no DOM, no clock.
 *
 * The questions come first because they are the point. A whole-vault graph is
 * a picture people open to find two things, the notes nothing connects to and
 * the notes everything does, and a third that only a folder index can show:
 * the references that point at no note. So those are computed exactly and
 * listed, and the drawing is how they are seen in context.
 *
 * The layout is a force model stepped a slice at a time (`ForceLayout.step`),
 * so a caller can spend a few milliseconds a frame and never hold the thread
 * for the whole folder. Repulsion is Barnes-Hut over a quadtree, so a step is
 * proportional to n log n rather than n squared. It starts from a fixed spiral
 * in path order, so the same folder settles to the same picture every time.
 */
import type { FolderIndex } from "../../../shared/folderIndex";

export interface FolderAnalysis {
    /** References touching each note, both directions, resolved ones only. */
    degree: Map<string, number>;
    /** The most connected notes, most first; ties by name. */
    hubs: string[];
    /** Notes no resolved reference touches, in path order. */
    orphans: string[];
    /** References to no note, grouped by what they name, most named first. */
    dangling: Array<{ target: string; from: string[] }>;
}

/** How many hubs the view lists. */
export const HUB_COUNT = 10;

export function analyzeFolder(index: FolderIndex): FolderAnalysis {
    const degree = new Map<string, number>(index.nodes.map((n) => [n.path, 0]));
    const dangling = new Map<string, Set<string>>();
    for (const e of index.edges) {
        if (e.to === null) {
            if (!dangling.has(e.target)) { dangling.set(e.target, new Set()); }
            dangling.get(e.target)!.add(e.from);
            continue;
        }
        if (e.to === e.from) { continue; }
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const name = new Map(index.nodes.map((n) => [n.path, n.name]));
    const hubs = [...degree.entries()]
        .filter(([, d]) => d > 0)
        .sort((a, b) => b[1] - a[1] || (name.get(a[0]) ?? a[0]).localeCompare(name.get(b[0]) ?? b[0]))
        .slice(0, HUB_COUNT)
        .map(([p]) => p);
    const orphans = [...degree.entries()].filter(([, d]) => d === 0).map(([p]) => p).sort();
    const danglingList = [...dangling.entries()]
        .map(([target, from]) => ({ target, from: [...from].sort() }))
        .sort((a, b) => b.from.length - a.from.length || a.target.localeCompare(b.target));
    return { degree, hubs, orphans, dangling: danglingList };
}

export interface FolderFilter {
    /** Only notes of these OKF types; null for every note. An untyped note is `""`. */
    types: ReadonlySet<string> | null;
    /** Only notes of these OKF statuses; null for every note. A note with none is `""`. */
    statuses: ReadonlySet<string> | null;
    /** Only notes whose name, path or one of whose tags holds this, ignoring case; empty for every note. */
    query: string;
}

/** The notes a filter keeps. */
export function filterNotes(index: FolderIndex, filter: FolderFilter): Set<string> {
    const q = filter.query.trim().toLowerCase();
    return new Set(index.nodes
        .filter((n) => filter.types === null || filter.types.has(n.type ?? ""))
        .filter((n) => filter.statuses === null || filter.statuses.has(n.status ?? ""))
        .filter((n) => q === "" || n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
            || n.tags.some((tag) => tag.toLowerCase().includes(q.replace(/^#/, ""))))
        .map((n) => n.path));
}

// ── The force layout ───────────────────────────────────────────────────────

interface Body { x: number; y: number; vx: number; vy: number }

interface Quad {
    x0: number; y0: number; size: number;
    mass: number; cx: number; cy: number;
    body: number;              // index of the one body in a leaf, -1 otherwise
    kids: (Quad | null)[] | null;
}

/** The force model's constants, in layout units where a spring rests at LINK. */
const LINK = 30;
const SPRING = 0.04;
const REPULSE = 900;
const GRAVITY = 0.012;
const DAMPING = 0.82;
/** Barnes-Hut opening angle: a cell this far away is treated as one mass. */
const THETA = 0.9;
/** Below this mean speed per step the layout is settled. */
const SETTLED = 0.05;

export interface ForceLayout {
    /** Each note's position, by path, in layout units around the origin. */
    positions(): ReadonlyMap<string, { x: number; y: number }>;
    /**
     * Advance until `budgetMs` of `now()` has passed or the layout settles,
     * at least one iteration either way. Returns whether it has settled.
     */
    step(budgetMs: number, now: () => number): boolean;
    /** Iterations run so far. */
    readonly iterations: number;
    readonly maxIterations: number;
}

export function createForceLayout(index: FolderIndex, maxIterations = 400): ForceLayout {
    const paths = index.nodes.map((n) => n.path).sort();
    const at = new Map(paths.map((p, i) => [p, i]));
    // A golden-angle spiral: evenly spread, and the same for the same folder.
    const golden = Math.PI * (3 - Math.sqrt(5));
    const bodies: Body[] = paths.map((_, i) => {
        const r = LINK * Math.sqrt(i + 0.5);
        return { x: r * Math.cos(i * golden), y: r * Math.sin(i * golden), vx: 0, vy: 0 };
    });
    const springs: Array<[number, number]> = [];
    const seen = new Set<string>();
    for (const e of index.edges) {
        if (e.to === null || e.to === e.from) { continue; }
        const a = at.get(e.from);
        const b = at.get(e.to);
        if (a === undefined || b === undefined) { continue; }
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        springs.push([a, b]);
    }
    let iterations = 0;
    let settled = bodies.length < 2;

    function build(): Quad {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const b of bodies) {
            if (b.x < minX) { minX = b.x; }
            if (b.y < minY) { minY = b.y; }
            if (b.x > maxX) { maxX = b.x; }
            if (b.y > maxY) { maxY = b.y; }
        }
        const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
        const root: Quad = { x0: minX, y0: minY, size, mass: 0, cx: 0, cy: 0, body: -1, kids: null };
        bodies.forEach((_, i) => insert(root, i, 0));
        return root;
    }

    function insert(q: Quad, i: number, depth: number): void {
        const b = bodies[i]!;
        q.cx = (q.cx * q.mass + b.x) / (q.mass + 1);
        q.cy = (q.cy * q.mass + b.y) / (q.mass + 1);
        q.mass += 1;
        if (q.mass === 1) { q.body = i; return; }
        // Coincident bodies at the depth limit share the leaf's mass.
        if (depth > 40) { return; }
        if (!q.kids) {
            q.kids = [null, null, null, null];
            const prev = q.body;
            q.body = -1;
            if (prev >= 0) { place(q, prev, depth); }
        }
        place(q, i, depth);
    }

    function place(q: Quad, i: number, depth: number): void {
        const b = bodies[i]!;
        const half = q.size / 2;
        const right = b.x >= q.x0 + half ? 1 : 0;
        const down = b.y >= q.y0 + half ? 1 : 0;
        const k = down * 2 + right;
        if (!q.kids![k]) {
            q.kids![k] = { x0: q.x0 + right * half, y0: q.y0 + down * half, size: half, mass: 0, cx: 0, cy: 0, body: -1, kids: null };
        }
        insert(q.kids![k]!, i, depth + 1);
    }

    function repel(q: Quad, i: number, b: Body): void {
        if (q.mass === 0 || q.body === i) { return; }
        const dx = b.x - q.cx;
        const dy = b.y - q.cy;
        const d2 = dx * dx + dy * dy + 0.01;
        if (q.kids === null || (q.size * q.size) / d2 < THETA * THETA) {
            const f = (REPULSE * q.mass) / d2;
            const d = Math.sqrt(d2);
            b.vx += (dx / d) * f;
            b.vy += (dy / d) * f;
            return;
        }
        for (const k of q.kids) { if (k) { repel(k, i, b); } }
    }

    function iterate(): number {
        const root = build();
        bodies.forEach((b, i) => { repel(root, i, b); });
        for (const [a, c] of springs) {
            const p = bodies[a]!;
            const q = bodies[c]!;
            const dx = q.x - p.x;
            const dy = q.y - p.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const f = SPRING * (d - LINK);
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
            q.vx -= (dx / d) * f;
            q.vy -= (dy / d) * f;
        }
        let speed = 0;
        for (const b of bodies) {
            b.vx = (b.vx - b.x * GRAVITY) * DAMPING;
            b.vy = (b.vy - b.y * GRAVITY) * DAMPING;
            // A step never moves a body further than a link's length, so a
            // crowded start cannot fling a note out of the drawing.
            const v = Math.hypot(b.vx, b.vy);
            if (v > LINK) { b.vx *= LINK / v; b.vy *= LINK / v; }
            b.x += b.vx;
            b.y += b.vy;
            speed += Math.hypot(b.vx, b.vy);
        }
        iterations++;
        return speed / Math.max(1, bodies.length);
    }

    return {
        positions: () => new Map(paths.map((p, i) => [p, { x: bodies[i]!.x, y: bodies[i]!.y }])),
        step(budgetMs, now) {
            if (settled) { return true; }
            const start = now();
            do {
                const speed = iterate();
                if (speed < SETTLED || iterations >= maxIterations) { settled = true; break; }
            } while (now() - start < budgetMs);
            return settled;
        },
        get iterations() { return iterations; },
        maxIterations,
    };
}
