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
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../../pm";
import { Fragment, type Node as ProseNode } from "../../pm";
import { markdownFormat } from "../../format/markdown";
import type { FormatModule } from "../../format/types";
import {
    blockBoundaryPositions,
    moveRangeAt,
    visibleBoundaryPositions,
} from "../../components/blockMenu";

// ── Corpus fixtures ─────────────────────────────────────────────────────────

export interface CorpusFixture {
    name: string;
    content: string;
}

const FIXTURES_DIR = join(__dirname, "..", "fixtures");

/**
 * Every `*<extension>` under __tests__/fixtures/ is a corpus member,
 * including grouped fixtures in subdirectories (e.g. fixtures/logseq/).
 * README.md files are documentation, not fixtures, so they are skipped.
 * Returned names are fixtures-relative (e.g. "logseq/page.md") so
 * subdirectory fixtures are distinguishable in the test output.
 */
function collectFixtures(dir: string, extension: string, rel = ""): CorpusFixture[] {
    const out: CorpusFixture[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
        const relName = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.push(...collectFixtures(join(dir, entry.name), extension, relName));
        } else if (entry.name.endsWith(extension) && entry.name !== "README.md") {
            out.push({ name: relName, content: readFileSync(join(dir, entry.name), "utf8") });
        }
    }
    return out;
}

/**
 * Every fixture under __tests__/fixtures/ (recursively) with the given
 * extension — `.md` (the default) plus the living showcase
 * (samples/content-inventory.md). The extension strips YAML frontmatter
 * before the webview ever sees content (src/utils/contentTransform.ts), so
 * the showcase contributes its body exactly as production delivers it.
 *
 * `fixtureExtension` exists for the multiformat track (MAR-40/41): a second
 * format's corpus gates run the same suites over its own fixture family
 * (module + extension) — see makeCorpusEditor.
 */
export function loadCorpusFixtures(fixtureExtension = ".md"): CorpusFixture[] {
    const fixtures = collectFixtures(FIXTURES_DIR, fixtureExtension);
    if (fixtureExtension === ".md") {
        // The showcase is a markdown document; other formats bring only
        // their own fixture family.
        const raw = readFileSync(
            join(__dirname, "..", "..", "..", "samples", "content-inventory.md"),
            "utf8",
        );
        const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
        fixtures.push({ name: "samples/content-inventory.md (body)", content: body });
    }
    return fixtures;
}

// ── Real-Milkdown editor factory ────────────────────────────────────────────

type EditorPlugin = Parameters<Editor["use"]>[0];

/**
 * The REAL editor (real parser, real remark-stringify, the production
 * serialization config) — no mocks. `extras` appends plugins the suite
 * needs beyond the preset (fold state, history, the content guard).
 * `format` selects the FormatModule whose presets/serialization the editor
 * is built with (default: markdown, the production module) — the corpus
 * gates run a second format by passing its module here plus its fixture
 * extension to loadCorpusFixtures.
 */
export async function makeCorpusEditor(
    markdown: string,
    extras: readonly EditorPlugin[] = [],
    format: FormatModule = markdownFormat,
): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let builder = Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
        format.configureSerialization(ctx);
    });
    for (const preset of format.presets) {
        builder = builder.use(preset);
    }
    for (const plugin of extras) {
        builder = builder.use(plugin);
    }
    return builder.create();
}

export function editorView(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/**
 * Parse `markdown` into the real editor and serialize it straight back — the
 * first leg of the save pipeline. Shared by the per-tool fidelity suites
 * (logseqRoundTrip, toolFidelity) so they can't drift from the production
 * serialization recipe the corpus (roundTripCorpus.test.ts) exercises.
 */
export async function serializeCorpus(
    markdown: string,
    format: FormatModule = markdownFormat,
): Promise<string> {
    const editor = await makeCorpusEditor(markdown, [], format);
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
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

// ── MERGE-tier hazard history (MAR-161) ─────────────────────────────────────
//
// Two `applyMinimalChanges` bugs were found the moment the full pair space
// opened up. Both were CLEAN at the raw serialize→reparse tier (so the
// MAR-120 save-survival refusal correctly did not fire); the damage appeared
// only when the serialized output was merged against the saved bytes. Both
// are FIXED and pinned as normal repros in corpusMoveSampling.test.ts (with
// distilled string-level repros in minimalDiff.test.ts):
//
//   (M1) the merge dropped the blank line the serializer emits to keep raw
//        `:::` fence prose inert at a directive body's tail — gapBefore now
//        defers to the serializer's separating blank when gluing would
//        change the next line's attachment (the dual of the MAR-122 rule);
//   (M2) the line normalizer matched a setext heading's underline to a
//        saved thematic break and "repaired" it, dissolving the heading —
//        thematic breaks now key by marker character (MAR-131 rework), and
//        the line classifier keys an attached dash run as a setext
//        underline, closing the same-character residual too.
//
// The `knownMergeTierHazard` exclusion predicate that kept M1-shaped pairs
// out of the sampled space is deleted: the gates hold the FULL pair space.

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
