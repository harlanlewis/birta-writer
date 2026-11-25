/**
 * components/graph/folderSignals.ts
 *
 * What a folder says about the reader's work, beyond who links to whom. Pure:
 * no DOM, and `now` is the caller's, so every answer here is a function of
 * the index, the recent files and a date, and a test can hold any of them.
 *
 * The link count answers one question, which notes the folder was built
 * around, and in a vault of any age the answer is history: a project that
 * was busy a year ago is still its most connected corner. Three more
 * questions are asked here, because they are the ones a reader opening a
 * folder actually has:
 *
 * - ACTIVITY: what is alive now. A note is active when it was written
 *   recently or opened recently, or when a note that is active refers to it;
 *   that last term is what keeps a reference note alive while it is being
 *   used rather than edited (`activityOf`).
 * - FADING: what used to matter and no longer does. A note that was among
 *   the folder's most connected, has not been written in months, and that
 *   nothing written recently refers to (`fadingNotes`). It is the dimension
 *   a link count hides most completely, since the count never goes down.
 * - SUBJECTS: what the folder is about, as groups rather than as a tree.
 *   Communities in the graph of links and shared tags (`folderSubjects`),
 *   found by modularity (Louvain), with a note that leans into a second
 *   group listed in that one too. Folders are a hierarchy someone chose
 *   once; a subject is what the links say now, and it crosses folders.
 *
 * Everything degrades to the link-only answer rather than guessing. A host
 * that sends no dates (`FolderNode.modified` absent) gets no fading list and
 * activity from the recent files alone; a note with no date is UNKNOWN, never
 * old. A subject is named from what its notes share (a tag most of them
 * carry, else words their names have in common), and a better name can be
 * laid over it by a host that has one (`SubjectNamer` in folderOverview.ts).
 */
import type { FolderIndex } from "../../../shared/folderIndex";

const DAY = 86_400_000;

/** A write this long ago counts half as much as one today. */
export const ACTIVITY_HALF_LIFE_DAYS = 30;

/** What an active note passes to a note it refers to: a fraction of its own activity. */
export const REFERENCE_CARRY = 0.6;

/** Below this a note with a known date is drawn as dormant. */
export const DORMANT_BELOW = 0.15;

/** A note unwritten this long, and referred to by nothing written in it, can be fading. */
export const FADING_AFTER_DAYS = 90;

/** Most fading notes listed. */
export const FADING_COUNT = 6;

/** Fewest notes a subject holds. */
export const SUBJECT_MIN = 3;

/** Most subjects listed. */
export const SUBJECT_COUNT = 8;

/**
 * A tag on more notes than this says little about which belong together (a
 * vault-wide `#note`), and pairing every holder would be quadratic in it, so
 * it adds no weight. Below it, every pair of holders is joined.
 */
export const TAG_PAIR_LIMIT = 40;

/** What two notes sharing a tag weigh, against a link's 1. */
export const TAG_WEIGHT = 0.5;

// ── Activity ───────────────────────────────────────────────────────────────

/**
 * How alive each note is, 0 to 1, or null when nothing is known about it.
 *
 * Its own term is the larger of how recently it was written (halving every
 * `ACTIVITY_HALF_LIFE_DAYS`) and how high it sits in the recent files (the
 * first is 1, the last a half). Then one step along the references: a note
 * named by an active note gets `REFERENCE_CARRY` of that note's own term,
 * and keeps the larger of the two. One step and not a propagation to a
 * fixed point, on purpose: a fixed point lets one busy note light up every
 * note two or three references away, and the answer stops being about what
 * the reader touches.
 *
 * Null for a note with no date, not in the recent files and named by no
 * active note: unknown, which every reader here treats as "no claim".
 */
export function activityOf(index: FolderIndex, recents: readonly string[] | null, now: number): Map<string, number | null> {
    const own = new Map<string, number | null>();
    const rank = new Map<string, number>();
    const list = [...new Set(recents ?? [])];
    list.forEach((path, i) => rank.set(path, i));
    for (const node of index.nodes) {
        const written = typeof node.modified === "number"
            ? Math.pow(0.5, Math.max(0, now - node.modified) / DAY / ACTIVITY_HALF_LIFE_DAYS)
            : null;
        const r = rank.get(node.path);
        const opened = r === undefined ? null : 1 - 0.5 * (list.length > 1 ? r / (list.length - 1) : 0);
        own.set(node.path, written === null && opened === null ? null : Math.max(written ?? 0, opened ?? 0));
    }
    const activity = new Map(own);
    for (const e of index.edges) {
        if (e.to === null || e.to === e.from) { continue; }
        const from = own.get(e.from);
        if (from === null || from === undefined) { continue; }
        const carried = from * REFERENCE_CARRY;
        const current = activity.get(e.to);
        if (current === null || current === undefined || carried > current) { activity.set(e.to, carried); }
    }
    return activity;
}

// ── Fading ─────────────────────────────────────────────────────────────────

export interface FadingNote {
    path: string;
    /** References touching it, both directions: how much it used to hold together. */
    degree: number;
    /** The day it was last written (`FolderNode.modified`). */
    modified: number;
}

/**
 * The notes that used to matter and no longer do, most connected first.
 *
 * A note qualifies when all of these hold: it is among the folder's better
 * connected notes (at least three references, and in the top quarter of the
 * notes that have any); it was last written over `FADING_AFTER_DAYS` ago; it
 * is not in the recent files; and no note written inside that window refers
 * to it. The last is what tells a note that is merely finished, but still
 * relied on, from one the folder has moved past.
 *
 * Empty when the host sent no dates, because "not written in months" cannot
 * be said about a note whose date is unknown.
 */
export function fadingNotes(index: FolderIndex, recents: readonly string[] | null, now: number): FadingNote[] {
    const cutoff = now - FADING_AFTER_DAYS * DAY;
    const modified = new Map(index.nodes.map((n) => [n.path, typeof n.modified === "number" ? n.modified : null]));
    const degree = new Map<string, number>();
    const referredRecently = new Set<string>();
    for (const e of index.edges) {
        if (e.to === null || e.to === e.from) { continue; }
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
        const fromWritten = modified.get(e.from);
        if (fromWritten !== null && fromWritten !== undefined && fromWritten >= cutoff) { referredRecently.add(e.to); }
    }
    const degrees = [...degree.values()].sort((a, b) => b - a);
    const floor = Math.max(3, degrees[Math.floor(degrees.length / 4)] ?? 3);
    const recent = new Set(recents ?? []);
    return index.nodes
        .flatMap((n): FadingNote[] => {
            const d = degree.get(n.path) ?? 0;
            const m = modified.get(n.path);
            if (m === null || m === undefined || m >= cutoff || d < floor) { return []; }
            if (recent.has(n.path) || referredRecently.has(n.path)) { return []; }
            return [{ path: n.path, degree: d, modified: m }];
        })
        .sort((a, b) => b.degree - a.degree || a.modified - b.modified || a.path.localeCompare(b.path))
        .slice(0, FADING_COUNT);
}

// ── Subjects ───────────────────────────────────────────────────────────────

export interface FolderSubject {
    /** Stable for the same members: the core's path. */
    id: string;
    /** What it is called, from what its notes share; see `nameSubject`. */
    name: string;
    /** The member most bound into the subject: where its drawing centres. */
    core: string;
    /** Its notes, most bound in first. */
    members: string[];
    /**
     * Notes whose home is another subject but which lean into this one: at
     * least two of their links land here, and a third of their link weight.
     * Listed with it, drawn in it, counted in neither total.
     */
    also: string[];
    /**
     * The notes of `members` and `also` tied to the core directly, by a link
     * or a shared tag: the drawing's first ring. A tag is a tie here as it is
     * in finding the subject, so a subject held together by tags alone still
     * draws as rings rather than as one dot.
     */
    nearCore: string[];
    /** The mean activity of its three most active members, or null when none is known. */
    activity: number | null;
}

/** An undirected weighted graph over note paths. */
type Weights = Map<string, Map<string, number>>;

function addWeight(w: Weights, a: string, b: string, weight: number): void {
    if (a === b) { return; }
    for (const [x, y] of [[a, b], [b, a]] as const) {
        let row = w.get(x);
        if (!row) { row = new Map(); w.set(x, row); }
        row.set(y, (row.get(y) ?? 0) + weight);
    }
}

/**
 * The graph subjects are found in: every resolved reference between two
 * notes is 1 (both directions folded into one tie, so two notes citing each
 * other weigh 2), and every pair of notes sharing a tag carried by no more
 * than `TAG_PAIR_LIMIT` notes adds `TAG_WEIGHT`.
 */
export function subjectWeights(index: FolderIndex): Weights {
    const w: Weights = new Map();
    const known = new Set(index.nodes.map((n) => n.path));
    for (const e of index.edges) {
        if (e.to === null || e.to === e.from || !known.has(e.from) || !known.has(e.to)) { continue; }
        addWeight(w, e.from, e.to, 1);
    }
    const byTag = new Map<string, string[]>();
    for (const n of index.nodes) {
        for (const tag of new Set(n.tags.map((t) => t.toLowerCase()))) {
            if (!byTag.has(tag)) { byTag.set(tag, []); }
            byTag.get(tag)!.push(n.path);
        }
    }
    for (const holders of byTag.values()) {
        if (holders.length < 2 || holders.length > TAG_PAIR_LIMIT) { continue; }
        for (let i = 0; i < holders.length; i++) {
            for (let j = i + 1; j < holders.length; j++) { addWeight(w, holders[i]!, holders[j]!, TAG_WEIGHT); }
        }
    }
    return w;
}

/**
 * Communities of `w` by Louvain modularity: move each node to the
 * neighbouring community that gains the most modularity, until nothing
 * moves; fold each community into one node; repeat until a fold changes
 * nothing. Deterministic: nodes are visited in path order and a tie keeps
 * the community already held, else takes the one whose first member sorts
 * first, so the same folder always divides the same way.
 *
 * Louvain rather than label propagation because propagation, on a vault with
 * one dominant hub, floods: the hub's label wins every vote around it and
 * the folder comes back as one subject. Modularity charges a community for
 * the weight it would hold by chance, which is what stops that.
 */
export function louvain(w: Weights): Map<string, string> {
    // `member` maps every original node to the node of the current level it
    // has been folded into; the levels share one representation: a graph
    // whose nodes are strings.
    const nodes = [...w.keys()].sort();
    const member = new Map(nodes.map((n) => [n, n]));
    let graph = w;
    for (let level = 0; level < 10; level++) {
        const order = [...graph.keys()].sort();
        const strength = new Map(order.map((n) => [n, [...(graph.get(n)?.values() ?? [])].reduce((a, b) => a + b, 0)]));
        const total = [...strength.values()].reduce((a, b) => a + b, 0);
        if (total === 0) { break; }
        const community = new Map(order.map((n) => [n, n]));
        const communityStrength = new Map(strength);
        let movedAny = false;
        for (let pass = 0; pass < 20; pass++) {
            let moved = false;
            for (const n of order) {
                const k = strength.get(n)!;
                const home = community.get(n)!;
                // Weight from n into each neighbouring community.
                const into = new Map<string, number>();
                for (const [m, weight] of graph.get(n) ?? []) {
                    if (m === n) { continue; }
                    const c = community.get(m)!;
                    into.set(c, (into.get(c) ?? 0) + weight);
                }
                communityStrength.set(home, communityStrength.get(home)! - k);
                const gain = (c: string): number => (into.get(c) ?? 0) - (communityStrength.get(c)! * k) / total;
                let best = home;
                let bestGain = gain(home);
                for (const c of [...into.keys()].sort()) {
                    const g = gain(c);
                    if (g > bestGain + 1e-12) { best = c; bestGain = g; }
                }
                communityStrength.set(best, communityStrength.get(best)! + k);
                if (best !== home) { community.set(n, best); moved = true; movedAny = true; }
            }
            if (!moved) { break; }
        }
        if (!movedAny) { break; }
        for (const [n, level] of member) { member.set(n, community.get(level)!); }
        // Fold: one node per community. The weight inside a community stays
        // as the folded node's tie to itself: it counts toward the node's
        // strength, which every later gain is charged against, and is skipped
        // only when weighing where the node should move.
        const folded: Weights = new Map();
        for (const [a, row] of graph) {
            for (const [b, weight] of row) {
                const ca = community.get(a)!;
                const cb = community.get(b)!;
                let r = folded.get(ca);
                if (!r) { r = new Map(); folded.set(ca, r); }
                r.set(cb, (r.get(cb) ?? 0) + weight);
            }
        }
        graph = folded;
    }
    return member;
}

/** Words that name nothing a subject is about. */
const STOP = new Set([
    "the", "and", "for", "with", "from", "into", "onto", "that", "this", "what", "when", "where", "which", "who",
    "how", "why", "are", "was", "were", "not", "but", "all", "any", "can", "has", "have", "had", "its", "our",
    "your", "their", "about", "over", "under", "more", "less", "new", "old", "note", "notes", "draft", "readme",
    "index", "todo", "misc", "untitled", "page", "file", "doc", "docs", "copy",
]);

/** The words of a note's name a subject can be named by. */
function words(name: string): string[] {
    return [...new Set(name.toLowerCase().split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)))];
}

/**
 * A subject's name, from what its members share, in this order: a tag at
 * least half of them carry (`#tag`); else the one or two words most
 * particular to their names, each used by at least two members and more
 * often here than in the rest of the folder; else the core's own name.
 */
export function nameSubject(index: FolderIndex, members: readonly string[], core: string): string {
    const nodes = new Map(index.nodes.map((n) => [n.path, n]));
    const tagCount = new Map<string, number>();
    for (const m of members) {
        for (const tag of new Set(nodes.get(m)?.tags.map((t) => t.toLowerCase()) ?? [])) {
            tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
        }
    }
    const tag = [...tagCount.entries()]
        .filter(([, c]) => c >= 2 && c * 2 >= members.length)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (tag) { return `#${tag[0]}`; }

    const inside = new Map<string, number>();
    const memberSet = new Set(members);
    for (const m of members) { for (const w of words(nodes.get(m)?.name ?? "")) { inside.set(w, (inside.get(w) ?? 0) + 1); } }
    const outside = new Map<string, number>();
    for (const n of index.nodes) {
        if (memberSet.has(n.path)) { continue; }
        for (const w of words(n.name)) { outside.set(w, (outside.get(w) ?? 0) + 1); }
    }
    const outsideCount = Math.max(1, index.nodes.length - members.length);
    const top = [...inside.entries()]
        .filter(([w, c]) => c >= 2 && c / members.length > (outside.get(w) ?? 0) / outsideCount)
        .map(([w, c]) => ({ w, score: (c / members.length) * Math.log(1 + outsideCount / (1 + (outside.get(w) ?? 0))) }))
        .sort((a, b) => b.score - a.score || a.w.localeCompare(b.w))
        .slice(0, 2)
        .map(({ w }) => w[0]!.toUpperCase() + w.slice(1));
    if (top.length > 0) { return top.join(" · "); }
    return nodes.get(core)?.name ?? core;
}

/**
 * The folder's subjects, the liveliest first: Louvain communities of
 * `subjectWeights` holding at least `SUBJECT_MIN` notes, each with its core,
 * its name, the notes that lean into it from elsewhere, and its activity.
 * `activity` is `activityOf`'s answer, passed in so one computation serves
 * the drawing and the lists.
 */
export function folderSubjects(index: FolderIndex, activity: ReadonlyMap<string, number | null>): FolderSubject[] {
    const w = subjectWeights(index);
    const community = louvain(w);
    const groups = new Map<string, string[]>();
    for (const [node, c] of community) {
        if (!groups.has(c)) { groups.set(c, []); }
        groups.get(c)!.push(node);
    }
    const inner = (n: string, set: ReadonlySet<string>): number =>
        [...(w.get(n) ?? [])].reduce((sum, [m, weight]) => sum + (set.has(m) ? weight : 0), 0);
    const linkWeight = new Map<string, Map<string, number>>();
    for (const e of index.edges) {
        if (e.to === null || e.to === e.from) { continue; }
        for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) {
            let row = linkWeight.get(a);
            if (!row) { row = new Map(); linkWeight.set(a, row); }
            row.set(b, (row.get(b) ?? 0) + 1);
        }
    }

    const subjects: FolderSubject[] = [];
    for (const group of groups.values()) {
        if (group.length < SUBJECT_MIN) { continue; }
        const set = new Set(group);
        const members = [...group].sort((a, b) => inner(b, set) - inner(a, set) || a.localeCompare(b));
        const core = members[0]!;
        const also = [...linkWeight.keys()].filter((n) => {
            if (set.has(n)) { return false; }
            const row = linkWeight.get(n)!;
            let here = 0;
            let all = 0;
            let count = 0;
            for (const [m, weight] of row) { all += weight; if (set.has(m)) { here += weight; count++; } }
            return count >= 2 && here * 3 >= all;
        }).sort();
        const known = members.map((m) => activity.get(m)).filter((a): a is number => typeof a === "number")
            .sort((a, b) => b - a).slice(0, 3);
        const coreTies = w.get(core) ?? new Map<string, number>();
        subjects.push({
            id: core,
            name: nameSubject(index, members, core),
            core,
            members,
            also,
            nearCore: [...members, ...also].filter((n) => n !== core && coreTies.has(n)),
            activity: known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : null,
        });
    }
    return subjects
        .sort((a, b) => (b.activity ?? -1) - (a.activity ?? -1) || b.members.length - a.members.length || a.id.localeCompare(b.id))
        .slice(0, SUBJECT_COUNT);
}
