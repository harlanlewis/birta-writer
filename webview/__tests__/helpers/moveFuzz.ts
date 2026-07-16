/**
 * Shared helpers for the corpus/fidelity test family (MAR-113, data-fidelity
 * design §5 "Layer 3"): the real-Milkdown editor factory and fixture loader
 * extracted from roundTripCorpus.test.ts, plus the seeded-PRNG and
 * move-enumeration utilities the generative suites (corpusMoveSampling,
 * moveProperty) share. Not a test file — Vitest only collects `*.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { Fragment, type Node as ProseNode } from "@milkdown/prose/model";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../../serialization";
import { moveRangeAt } from "../../components/blockMenu";
import {
    blockBoundaryPositions,
    visibleBoundaryPositions,
} from "../../components/blockMenu/drag";

// ── Corpus fixtures ─────────────────────────────────────────────────────────

export interface CorpusFixture {
    name: string;
    content: string;
}

const FIXTURES_DIR = join(__dirname, "..", "fixtures");

/**
 * Every `.md` under __tests__/fixtures/ is a corpus member, including grouped
 * fixtures in subdirectories (e.g. fixtures/logseq/). README.md files are
 * documentation, not fixtures, so they are skipped. Returned names are
 * fixtures-relative (e.g. "logseq/page.md") so subdirectory fixtures are
 * distinguishable in the test output.
 */
function collectFixtures(dir: string, rel = ""): CorpusFixture[] {
    const out: CorpusFixture[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
        const relName = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.push(...collectFixtures(join(dir, entry.name), relName));
        } else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
            out.push({ name: relName, content: readFileSync(join(dir, entry.name), "utf8") });
        }
    }
    return out;
}

/**
 * Every fixture under __tests__/fixtures/ (recursively) plus the living
 * showcase (samples/content-inventory.md). The extension strips YAML
 * frontmatter before the webview ever sees content
 * (src/utils/contentTransform.ts), so the showcase contributes its body
 * exactly as production delivers it.
 */
export function loadCorpusFixtures(): CorpusFixture[] {
    const fixtures = collectFixtures(FIXTURES_DIR);
    const raw = readFileSync(
        join(__dirname, "..", "..", "..", "samples", "content-inventory.md"),
        "utf8",
    );
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
    fixtures.push({ name: "samples/content-inventory.md (body)", content: body });
    return fixtures;
}

// ── Real-Milkdown editor factory ────────────────────────────────────────────

type EditorPlugin = Parameters<Editor["use"]>[0];

/**
 * The REAL editor (real parser, real remark-stringify, the production
 * serialization config) — no mocks. `extras` appends plugins the suite
 * needs beyond the preset (fold state, history, the content guard).
 */
export async function makeCorpusEditor(
    markdown: string,
    extras: readonly EditorPlugin[] = [],
): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let builder = Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity);
    for (const plugin of extras) {
        builder = builder.use(plugin);
    }
    return builder.create();
}

export function editorView(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

// ── Significant-line survival ───────────────────────────────────────────────

/** Significant (non-blank) lines of a document. */
export function sig(text: string): string[] {
    return text.split("\n").filter((l) => l.trim() !== "");
}

// (Historical: `checkDocModuloSpreadQuirk` lived here to neutralize Milkdown's
// string-`spread` parse quirk before doc.check(). MAR-124 fixed the quirk at
// parse time — the list-schema overrides in plugins/list.ts store `spread` as a
// real boolean — so the generative suites now assert plain `doc.check()`.)

// ── Seeded PRNG ─────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32). NEVER Math.random in these suites: a
 * failure must be reproducible from the printed seed. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Small deterministic string hash (FNV-1a) — per-fixture seed streams stay
 * independent of fixture ordering. */
export function hashString(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Integer in [0, n). */
export function randomInt(rng: () => number, n: number): number {
    return Math.floor(rng() * n);
}

/** Fisher–Yates shuffled copy, driven by the seeded PRNG. */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = randomInt(rng, i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

// ── Move-space enumeration ──────────────────────────────────────────────────

export interface MoveSource {
    /** Position of the block the gesture grabs. */
    pos: number;
    /** Drag-slot kind (drag.ts kind-gating): items only see item slots. */
    kind: "block" | "item";
    /** The range the move primitive receives (moveRangeAt semantics —
     * top-level headings carry their whole section). */
    from: number;
    to: number;
}

/**
 * Every block a gesture could pick up: the node-start boundaries of
 * blockBoundaryPositions (end-of-list / end-of-doc slots carry no node),
 * with the SAME range derivation the block menu / drag / keyboard movers
 * use (moveRangeAt).
 */
export function enumerateMoveSources(view: EditorView): MoveSource[] {
    const sources: MoveSource[] = [];
    const seen = new Set<number>();
    for (const boundary of blockBoundaryPositions(view.state.doc)) {
        if (seen.has(boundary.pos)) {
            continue;
        }
        seen.add(boundary.pos);
        if (!view.state.doc.nodeAt(boundary.pos)) {
            continue; // an end slot, not a block start
        }
        const range = moveRangeAt(view, boundary.pos);
        if (range) {
            sources.push({ pos: boundary.pos, kind: boundary.kind, ...range });
        }
    }
    return sources;
}

/**
 * Every (source, target) pair a user gesture could express: sources from
 * enumerateMoveSources, targets from visibleBoundaryPositions (the drag
 * UI's own slot list — fold-hidden slots already excluded) gated to the
 * source's kind, exactly like drag.ts. Structural refusals (canReplace)
 * are NOT pre-filtered: a refused pair is itself an assertion target
 * (a refused move must be a perfect no-op).
 */
export function enumerateMovePairs(
    view: EditorView,
): { source: MoveSource; target: number }[] {
    const sources = enumerateMoveSources(view);
    const slots = visibleBoundaryPositions(view.state);
    const byKind = {
        block: slots.filter((s) => s.kind === "block").map((s) => s.pos),
        item: slots.filter((s) => s.kind === "item").map((s) => s.pos),
    };
    const pairs: { source: MoveSource; target: number }[] = [];
    for (const source of sources) {
        for (const target of byKind[source.kind]) {
            pairs.push({ source, target });
        }
    }
    return pairs;
}

// ── Save-pipeline hazard history (the MAR-113 gate's finds) ────────────────
//
// Seven save/reopen round-trip bug classes (A–G) were found by this gate; all
// conserved content at the DOC level (the guard passed) and corrupted only at
// save+reopen. Every class is now either FIXED in the serializer (A directive
// nesting, C highlight escaping, D quote splice, E empty paragraphs, G setext
// underlines — for directives in directives.ts, for callouts in callouts.ts /
// MAR-157) or REFUSED at the move primitive (B fence re-pairing, F aside
// nesting — the save-survival check in plugins/reparseHazard.ts, the MAR-120
// refuse lane). The `knownSavePipelineHazard` exclusion predicate that kept
// B/F-shaped pairs out of the sampled space is deleted: a refused pair is
// itself an assertion target (a refused move must be a perfect no-op), so the
// gate now holds the FULL pair space to the contract. The B/F repros are
// normal pins in corpusMoveSampling.test.ts asserting the refusal.

// ── Known MERGE-tier hazards (MAR-161) ──────────────────────────────────────
//
// Two `applyMinimalChanges` bugs found the moment the full pair space opened
// up. Both are CLEAN at the raw serialize→reparse tier (so the MAR-120
// save-survival refusal correctly does not fire — refusing a valid gesture
// for a merge bug would punish the user for the merge's fault); the damage
// appears only when the serialized output is merged against the saved bytes:
//
//   (M1) the merge drops the blank line the serializer emits to keep raw
//        `:::` fence prose inert at a directive body's tail (the mirror of
//        the fixed MAR-122: there gapBefore KEPT a stale blank, here it
//        REMOVES a live one);
//   (M2) FIXED (MAR-131 normalizer rework): the line normalizer used to
//        match a setext heading's underline (`-----`) to a saved thematic
//        break (`***`) and "repair" it, dissolving the heading. Thematic
//        breaks now key by marker character, so cross-character repair is
//        impossible. No longer excluded; a dash-hr vs dash-underline
//        collision would still key equal (needs line-above context) and
//        stays open on MAR-161.
//
// Excluded here by the narrowest predicate that covers M1 — never by
// weakening assertions — and pinned as an `it.fails` repro in
// corpusMoveSampling.test.ts. Delete this predicate (and promote the pin)
// when MAR-161 closes.

export function knownMergeTierHazard(
    view: EditorView,
    source: { from: number; to: number },
    target: number,
): boolean {
    const { doc } = view.state;
    const fragment = childrenInRange(doc, source);
    if (!fragment) {
        return false; // malformed range — the primitive refuses it anyway
    }
    let fragmentHasRawFence = false;
    fragment.descendants((node: ProseNode) => {
        if (node.isTextblock && !node.type.spec.code && node.textContent.startsWith(":::")) {
            fragmentHasRawFence = true;
        }
        return true;
    });
    // (M1): raw fence prose moved inside a container directive needs the
    // serializer's separating blank line, which the merge may remove.
    if (fragmentHasRawFence) {
        const $target = doc.resolve(target);
        for (let d = $target.depth; d > 0; d--) {
            if ($target.node(d).type.name === "container_directive") {
                return true;
            }
        }
    }
    return false;
}

/**
 * The whole children of `parent`-under-`doc` covered by [from, to), as the
 * move/duplicate primitives collect them (never doc.slice — an open slice
 * through a list wraps items in a phantom list node whose count would
 * pollute a fingerprint). Null when the range does not cleanly tile whole
 * children.
 */
export function childrenInRange(
    doc: ProseNode,
    range: { from: number; to: number },
): Fragment | null {
    const $from = doc.resolve(range.from);
    const parent = $from.depth === 0 ? doc : $from.parent;
    if (parent.isTextblock) {
        return null;
    }
    const base = $from.depth === 0 ? 0 : $from.start();
    const nodes: ProseNode[] = [];
    let coveredFrom = -1;
    let coveredTo = -1;
    parent.forEach((child: ProseNode, offset: number) => {
        const childPos = base + offset;
        if (childPos >= range.from && childPos < range.to) {
            if (nodes.length === 0) {
                coveredFrom = childPos;
            }
            nodes.push(child);
            coveredTo = childPos + child.nodeSize;
        }
    });
    if (nodes.length === 0 || coveredFrom !== range.from || coveredTo !== range.to) {
        return null;
    }
    return Fragment.from(nodes);
}
