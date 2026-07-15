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

// ── Known save-pipeline hazards (real bugs found by the MAR-113 gate) ──────
//
// Four save/reopen round-trip bugs pre-date the gate. All conserve content
// at the DOC level (the guard passes); the damage happens at save+reopen.
// Each is pinned as a named `it.fails` repro in corpusMoveSampling.test.ts
// and excluded — by this narrow predicate, never by weakening assertions —
// from the sampled pair space until fixed:
//
//   (A) FIXED (MAR-120): directive nesting — the serializer now lengthens the
//       OUTER fence past any fence in its body (`::::` outside `:::`, the
//       CommonMark convention), so a nested directive re-nests on reparse.
//       The fence colon count is structural, so the content fingerprint
//       normalizes it (contentGuard container_directive marker). No longer
//       excluded; held to the full contract by the gate.
//   (B) Fence re-pairing: a closed directive moved below raw `:::`-prefixed
//       prose (an unclosed fence that parses as a paragraph) lets that
//       prose line pair with the directive's close fence on reparse.
//   (C) FIXED (MAR-121): highlight escaping — a literal `\==text==` in prose
//       now re-serializes with its backslash via the highlight `unsafe`
//       pattern (plugins/highlight.ts), so it stays plain text on reparse.
//       No longer excluded here; held to the full contract by the gate.
//   (D) FIXED (MAR-122): quote splice — moving a block between quote-family
//       containers no longer leaves a stale separator blank in the merge.
//       `applyMinimalChanges`'s gapBefore guard defers to the serializer's
//       spacing when a saved blank would split a quote the serializer kept
//       contiguous, so the moved block reopens inside its drop target. No
//       longer excluded here; held to the full contract by the gate.
//   (E) FIXED (MAR-123): empty paragraphs — an empty (or hardbreak-only)
//       paragraph serializes to nothing and never round-trips in pure
//       Markdown, so it is NOT content. The content fingerprint
//       (contentGuard.isBlankParagraph) no longer counts it, so a move that
//       relocates one (it then vanishes on save) or drops a container's
//       auto-fill blank conserves everything that IS content. No longer
//       excluded here; held to the full contract by the gate.
//   (F) Aside nesting: a notion_callout (`<aside>` HTML) moved inside
//       another aside or a directive is not recognized by the sub-parse on
//       reopen — it flattens into raw html of its new parent.
//   (G) FIXED (MAR-120) for directives: an `hr` moved to the head of a
//       directive body used to serialize directly under the open fence, and
//       `fence-line + ---` reparsed as a SETEXT HEADING. The directive
//       serializer now emits a blank line after the open fence when the body
//       opens on a setext-underline-shaped line. (The same hazard in a
//       blockquote/callout — `> text` + `> ---` — is NOT yet fixed; the
//       `fragmentHasHr && targetQuote` guard below still excludes it.)
//
// TODO(MAR-113 follow-up): (A), (C), (D), (E), and (G)-for-directives are
// fixed (see the class list above). Remaining: (B) raw fence-shaped prose
// re-pairing with a moved container's close fence, (F) `<aside>` nesting, and
// the (G) setext hazard inside blockquote/callout containers — then delete
// this predicate and the remaining it.fails pins.

const QUOTE_FAMILY = new Set(["blockquote", "callout", "notion_callout"]);

/** Start position of the outermost quote-family ancestor of `pos`, or -1. */
function quoteAncestorPos(doc: ProseNode, pos: number): number {
    const $pos = doc.resolve(pos);
    for (let d = 1; d <= $pos.depth; d++) {
        if (QUOTE_FAMILY.has($pos.node(d).type.name)) {
            return $pos.before(d);
        }
    }
    return -1;
}

export function knownSavePipelineHazard(
    view: EditorView,
    source: { from: number; to: number },
    target: number,
): boolean {
    const { doc } = view.state;
    const fragment = childrenInRange(doc, source);
    if (!fragment) {
        return false; // malformed range — the primitive refuses it anyway
    }
    let fragmentHasDirective = false;
    let fragmentHasAside = false;
    let fragmentHasHr = false;
    let fragmentHasRawFence = false;
    fragment.descendants((node: ProseNode) => {
        if (node.type.name === "container_directive") {
            fragmentHasDirective = true;
        }
        if (node.type.name === "notion_callout") {
            fragmentHasAside = true;
        }
        if (node.type.name === "hr") {
            fragmentHasHr = true;
        }
        if (node.isTextblock && node.textContent.startsWith(":::")) {
            fragmentHasRawFence = true;
        }
        if (node.type.name === "html") {
            const html = String(node.attrs["value"] ?? "");
            if (html.includes("<aside") || html.includes("</aside")) {
                // Raw aside tag bytes kept as inert html (the fixture's
                // degradation cases) re-pair with other asides once moved.
                fragmentHasRawFence = true;
            }
        }
        return true;
    });
    const $target = doc.resolve(target);
    const targetQuote = quoteAncestorPos(doc, target);
    // (G) The setext hazard inside a quote — `> paragraph` + `> ---` reparsing
    // as a setext heading — is DEFUSED for the plain case: unlike a directive's
    // synthesized open fence (a text line), a paragraph and an hr are two mdast
    // block siblings, so remark-stringify's block join emits the disambiguating
    // blank `>` line between them. The quoteHazardPins regression tests
    // (corpusMoveSampling.test.ts) lock this in for blockquotes and callouts.
    //
    // This guard nonetheless still excludes ALL hr-bearing fragments moved into
    // a quote: such a fragment can also CARRY an unfixed container-nesting
    // hazard (a directive/aside/callout whose fences re-pair once re-parented —
    // manifestation B), and the failing cases those produce are the deferred
    // parser-level work in MAR-120, not the setext hazard. Tightening it to let
    // bare-hr moves into the sample destabilizes the (seed-sampled) gate against
    // those still-open hazards.
    if (fragmentHasHr && targetQuote !== -1) {
        return true;
    }
    // (F) Aside nesting is unfixed: a notion_callout (`<aside>` html) moved
    // inside another container (directive or aside) flattens to raw html on
    // reopen — CommonMark HTML-block parsing cannot nest `<aside>` (the blank
    // line before the inner aside ends the outer block). Directive and hr
    // nesting into a directive/aside are FIXED (MAR-120 A/G: the outer fence
    // is lengthened past the inner, and a setext-hazard first line gets a blank
    // line), so only an aside-bearing fragment is excluded here.
    if (fragmentHasAside) {
        for (let d = $target.depth; d > 0; d--) {
            const name = $target.node(d).type.name;
            if (name === "container_directive" || name === "notion_callout") {
                return true; // (F)
            }
        }
    }
    if (fragmentHasDirective || fragmentHasAside || fragmentHasHr || fragmentHasRawFence) {
        // (B): raw unclosed openers elsewhere in the doc — `:::` prose or an
        // unclosed `<aside>` html atom — can re-pair with the moved node's
        // own close fence/tag once the move puts them in range of each other.
        let docHasRawOpener = false;
        doc.descendants((node: ProseNode) => {
            if (docHasRawOpener) {
                return false;
            }
            if (node.isTextblock && node.textContent.startsWith(":::")) {
                docHasRawOpener = true;
                return false;
            }
            const html = node.type.name === "html" ? String(node.attrs["value"] ?? "") : "";
            if (html.includes("<aside") && !html.includes("</aside>")) {
                docHasRawOpener = true;
                return false;
            }
            return true;
        });
        if (docHasRawOpener) {
            return true;
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
