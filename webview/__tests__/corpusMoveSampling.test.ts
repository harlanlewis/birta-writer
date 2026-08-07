/**
 * Corpus move-sampling gate (MAR-113, data-fidelity design §5 "Layer 3",
 * tier "corpus move-sampling"): every round-trip fixture is loaded into the
 * REAL editor, the space of (source block, target boundary) pairs a user
 * gesture could express is enumerated with the SAME helpers the drag UI
 * uses, and a deterministic pseudo-random sample of moves is executed
 * through the hardened primitive. After each move:
 *
 *   (a) the doc still satisfies every schema invariant (strict doc.check(),
 *       now that list `spread` parses as a real boolean — MAR-124);
 *   (b) content is conserved per the guard's OWN oracle (checkMove over
 *       fingerprintDoc/diffFingerprints — the exact functions the runtime
 *       guard runs, so test and guard cannot drift), and the guard itself
 *       vetoed nothing;
 *   (c) the full production save pipeline conserves content: serialize →
 *       round-trip protection → minimal-diff merge into the original file →
 *       REPARSE, and the reparsed doc fingerprints identically to the
 *       post-move doc. (Byte-exact line survival — roundTripCorpus's
 *       invariant B — is deliberately NOT asserted for moves: a move
 *       legitimately rewrites line bytes without touching content — an
 *       emptied callout dissolves its marker line, blocks entering/leaving
 *       quotes gain/lose `> ` prefixes, ordered siblings renumber, table
 *       separator rows re-canonicalize. The fingerprint comparison is the
 *       content-exact form of the same invariant, using the guard's oracle.)
 *   (d) a refused move (moveBlocks returned false) left the document
 *       REFERENCE-identical — the B2 "delete half committed alone" contract.
 *
 * Plus one folded variant per fixture that has foldables: collapse the
 * first foldable, sample again, and additionally assert every fold entry
 * still resolves to a foldable block (the B5 "fold lands on the wrong
 * block" class).
 *
 * Deterministic: seeded PRNG (mulberry32), NO Math.random. Override the
 * seed with MDW_MOVE_SEED=<number>; every failure message carries the seed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parserCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import {
    allFoldablePositions,
    headingFoldPlugin,
    headingFoldPluginKey,
    type HeadingFoldMeta,
} from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import {
    checkMove,
    contentGuardPlugin,
    diffFingerprints,
    fingerprintDoc,
    formatFingerprintDiff,
} from "../plugins/contentGuard";
import { isBlankParagraph } from "../plugins/fingerprints";
import { dissolvedMarkersFor, moveBlocks } from "../editing/moveBlocks";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import {
    editorView,
    enumerateMovePairs,
    hashString,
    loadCorpusFixtures,
    makeCorpusEditor,
    mulberry32,
    shuffled,
} from "./helpers/moveFuzz";

// The landing flash and range veil are geometry no-ops under jsdom.
vi.mock("../editing/rangeIndicator", () => ({
    flashRange: vi.fn(),
    showRangeVeil: vi.fn(),
    hideRangeVeil: vi.fn(),
}));

/** Deterministic default; override with MDW_MOVE_SEED=<number>. */
const SEED = Number(process.env["MDW_MOVE_SEED"] ?? "20260712");
/**
 * Moves sampled per fixture (and per folded variant).
 *
 * The default is deliberately 12, and thinning it to buy suite time is not
 * worth it: halving the sample saves a couple of seconds of the whole unit
 * suite, against thinning a phase-0 fidelity net on every PR. Before believing
 * otherwise, measure this file IN ISOLATION — the JSON reporter's
 * `endTime - startTime` counts time the file spent queued behind the other
 * suites in a parallel run, which is how it once read an order of magnitude
 * over its real cost.
 *
 * What IS worth having, and why the env override exists: the seed is fixed, so
 * every ordinary run re-tests the same 12 pairs and a repeat carries almost no
 * new information. `.github/workflows/nightly-fidelity.yml` runs a much larger
 * sample with a ROTATING seed against `main`, so the pair space is actually
 * explored over time. That is a coverage win, not a speed one, and it costs
 * PRs nothing.
 *
 * PRs keep the fixed seed on purpose: a rotating seed would surface
 * pre-existing bugs on whichever unrelated PR happened to draw them, reddening
 * a build its author did not cause. In the nightly the same find becomes a
 * ticket instead.
 */
const SAMPLE_SIZE = Number(process.env["MDW_MOVE_SAMPLE"] ?? "12");

/**
 * Per-test budget for the corpus gates, which run `SAMPLE_SIZE` full
 * move→serialize→protect→merge→reparse cycles against a real editor, once per
 * fixture. Cost scales with fixture size, and the largest — `content-inventory.md`
 * — sits above the 5 s default: 5.3–6.6 s on a developer laptop, and CI runners
 * are roughly twice as slow per AGENTS.md.
 *
 * The number below is headroom over a MEASURED cost, not a guess at one, and it
 * is scoped to these suites so ordinary tests keep the tight default.
 */
const CORPUS_TIMEOUT_MS = 30_000;

// This gate holds EVERY fixture to strict content conservation under block
// moves. It carried a carve-out for the tab-indented Logseq outlines for most of
// its life; both reasons are now closed and the filter is gone.
//
// The first was indentation: a moved line is an INSERTION, so the merge wrote it
// with the serializer's two-space indent beside kept lines still holding tabs
// (MAR-230's first half, `3c9573c`). The second was the construct that survived
// it — a moved item whose content is a heading was re-emitted as a bare marker
// line with its content indented beneath, which reparsed as a setext underline
// or an indented code block depending on the spelling. Dropping the empty
// paragraph that forced that bare marker (plugins/list.ts →
// `itemContentForMarkdown`) took `logseq/page.md` from 10 losses in 247
// executable moves to 0, swept exhaustively rather than sampled.
//
// READ THIS BEFORE QUOTING THIS GATE AS COVERAGE FOR THAT CONSTRUCT: it is not.
// The sweep above was a throwaway probe; what runs here is SAMPLE_SIZE=12 pairs
// at a fixed seed. Re-running this file against the pre-fix serializer, with the
// filter already deleted, passes 77/77 — the 10 damaging pairs are 4% of the 247
// executable moves (3.4% of the 291 enumerated pairs the sampler actually draws
// from) and the seeded draw misses them every time, deterministically.
// So deleting the filter is correct but buys no regression net on its own. The
// net is two direct repros in `movedBlockIndent.test.ts` ("moving an item whose
// content is a heading…" and the no-move round-trip beside it), both of which
// were replayed against the pre-fix `plugins/list.ts` and fail there. The
// rotating-seed nightly is what explores the rest of the pair space over time.
const fixtures = loadCorpusFixtures();

let editors: Editor[] = [];
let errorSpy: ReturnType<typeof vi.spyOn>;

async function makeEditor(markdown: string): Promise<Editor> {
    const editor = await makeCorpusEditor(markdown, [
        headingFoldPlugin,
        historyPlugin,
        contentGuardPlugin,
    ]);
    editors.push(editor);
    return editor;
}

/** The [ContentGuard] console.error lines emitted so far. */
function guardErrors(): string[] {
    return errorSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((line) => line.includes("[ContentGuard]"));
}

beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
    errorSpy.mockRestore();
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

/**
 * Sample SAMPLE_SIZE moves from the pair space of the CURRENT state (which
 * is restored between samples, so one enumeration serves the whole run) and
 * assert the tier's invariants after each. `extraAssert` runs after each
 * SUCCESSFUL move (the folded variant checks its fold entries there).
 */
function sampleMoves(
    editor: Editor,
    v: EditorView,
    fixture: { name: string; content: string },
    protection: ReturnType<typeof computeRoundTripProtection>,
    extraAssert?: (context: string) => void,
): void {
    const baseState = v.state;
    const rng = mulberry32((SEED ^ hashString(fixture.name)) >>> 0);
    // NOTHING is excluded: B/F-shaped pairs are refused by the save-survival
    // check (plugins/reparseHazard, MAR-120 refuse lane) and land in the
    // refused-is-a-perfect-no-op branch below, which is itself the contract
    // for them; the two MERGE-tier bugs (MAR-161) are fixed and pinned as
    // normal repros below. The gate holds the full pair space.
    const pairs = shuffled(enumerateMovePairs(v), rng);
    expect(pairs.length, `no move pairs enumerable in ${fixture.name}`).toBeGreaterThan(0);
    const sample = pairs.slice(0, SAMPLE_SIZE);
    for (const { source, target } of sample) {
        const context =
            `MDW_MOVE_SEED=${SEED} fixture=${fixture.name} ` +
            `source=[${source.from},${source.to}) (${source.kind}) target=${target}`;
        const docBefore = v.state.doc;
        const fpBefore = fingerprintDoc(docBefore);
        const guardErrorsBefore = guardErrors().length;

        const moved = moveBlocks(v, { from: source.from, to: source.to }, target);

        // A guard veto on a UI-enumerated pair means the primitive's
        // legality and the guard's conservation contract DISAGREE — the
        // exact drift this gate exists to catch (structural refusals never
        // reach the guard; they are legitimate and asserted as no-ops).
        expect(
            guardErrors().slice(guardErrorsBefore),
            `content guard fired on a sampled move — ${context}`,
        ).toEqual([]);
        if (!moved) {
            // (d) A refused move is a PERFECT no-op: reference identity, not
            // just equal markdown — the B2 half-committed-delete contract.
            expect(v.state.doc, `refused move mutated the doc — ${context}`).toBe(docBefore);
            continue;
        }
        // (a) Schema validity — strict doc.check() now that list `spread`
        // parses as a real boolean (MAR-124).
        expect(
            () => v.state.doc.check(),
            `doc.check() failed — ${context}`,
        ).not.toThrow();
        // (b) Conservation per the guard's own oracle — including the same
        // emptied-container declaration the primitive tags (a move that
        // dissolves a titled callout/directive is declared, not lossy).
        const violation = checkMove(
            diffFingerprints(fpBefore, fingerprintDoc(v.state.doc)),
            new Set(dissolvedMarkersFor(docBefore, { from: source.from, to: source.to })),
        );
        expect(violation, `move violated conservation — ${context}`).toBeNull();
        // (c) The production save pipeline conserves content: what would be
        // written to disk, reopened, holds exactly what the editor holds.
        const merged = applyMinimalChanges(
            fixture.content,
            editor.action(getMarkdown()),
            protection,
        );
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode | null;
        expect(reparsed, `merged output failed to reparse — ${context}`).toBeTruthy();
        const pipelineDelta = diffFingerprints(
            fingerprintDoc(v.state.doc),
            fingerprintDoc(reparsed!),
        );
        expect(
            formatFingerprintDiff(pipelineDelta),
            `save pipeline altered content — ${context}`,
        ).toBe("lost: (none); gained: (none)");
        extraAssert?.(context);
        v.updateState(baseState);
    }
    v.updateState(baseState);
}

describe("corpus move-sampling gate", { timeout: CORPUS_TIMEOUT_MS }, () => {
    for (const fixture of fixtures) {
        it(`${fixture.name} should conserve content across ${SAMPLE_SIZE} sampled moves`, async () => {
            const editor = await makeEditor(fixture.content);
            const v = editorView(editor);
            const protection = computeRoundTripProtection(
                fixture.content,
                editor.action(getMarkdown()),
            );

            sampleMoves(editor, v, fixture, protection);
        });
    }
});

// ── Pinned repros for the real bugs the gate surfaced ───────────────────────
//
// PRE-EXISTING serializer/merge round-trip bugs, found by this gate on its
// first run (see the hazard-class history in helpers/moveFuzz). Each repro is
// minimal. Every class is now closed one of two ways, and the pin asserts
// whichever applies:
//   - FIXED in the serializer ("MAR-NN, fixed"): the shape round-trips, so
//     the pin asserts a clean reparse delta;
//   - REFUSED at the primitive ("MAR-120, refused"): the reparse is
//     parser-level work deliberately not built (maintainer decision,
//     2026-07-15 — refuse lane), so the pin asserts the move returns false
//     and the document is untouched (reference identity).
// There are no it.fails pins and no sampling exclusions left: the gate holds
// the full pair space to the contract. NOTE for future fixers: if B or F is
// ever properly fixed at the parser level, the refusal stops firing only if
// the round-trip actually survives — flip the refused pins back to
// moved===true + clean-delta pins in the same change.

/** Position of the first node of `type` whose text matches, or -1. */
function findPos(doc: ProseNode, type: string, text: string): number {
    let found = -1;
    doc.descendants((node: ProseNode, pos: number) => {
        if (found === -1 && node.type.name === type && node.textContent === text) {
            found = pos;
        }
        return found === -1;
    });
    return found;
}

/** Position of the first node of `type` whose text CONTAINS `text`, or -1 —
 * content-addressing into corpus fixtures, robust to fixture edits around
 * the anchor. */
function findContaining(doc: ProseNode, type: string, text: string): number {
    let found = -1;
    doc.descendants((node: ProseNode, pos: number) => {
        if (found === -1 && node.type.name === type && node.textContent.includes(text)) {
            found = pos;
        }
        return found === -1;
    });
    return found;
}

/** Fingerprint delta between the live doc and a reparse of its own
 * serialization — the "save then reopen" content diff. */
function reparseDelta(editor: Editor, v: EditorView): string {
    const serialized = editor.action(getMarkdown());
    const reparsed = editor.action((ctx) => ctx.get(parserCtx)(serialized)) as ProseNode;
    return formatFingerprintDiff(
        diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
    );
}

describe("known save-pipeline hazards — pinned repros (fixed or refused, per class)", () => {
    it("hazard A (MAR-120, fixed): a directive moved inside another directive survives save+reopen", async () => {
        // The outer directive must end with a LIST for the bug to bite: a
        // trivially-nested `:::tip` after a paragraph happens to reparse,
        // but the corpus shape (nested fence following a list) does not.
        const editor = await makeEditor(
            ":::note\nFirst paragraph.\n\n- a list item\n- another\n\n:::\n\n" +
                ':::info{title="Attrs preserved"}\nAttribute syntax stays raw.\n:::',
        );
        const v = editorView(editor);
        const innerPos = findPos(v.state.doc, "container_directive", "Attribute syntax stays raw.");
        expect(innerPos).toBeGreaterThan(-1);
        const inner = v.state.doc.nodeAt(innerPos)!;
        const outer = v.state.doc.firstChild!;
        // Target: the last boundary INSIDE the outer note directive.
        const insideNote = outer.nodeSize - 1;

        expect(moveBlocks(v, { from: innerPos, to: innerPos + inner.nodeSize }, insideNote)).toBe(true);

        // The serializer now lengthens the outer fence past the inner
        // (`::::note` around `:::info`), so the nested directive re-nests.
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
    });

    it("hazard D (MAR-122, fixed): a block moved between callouts reopens inside its drop target", async () => {
        const source = "> [!IMPORTANT]\n> Purple.\n\n> [!WARNING]\n> Yellow.\n";
        const editor = await makeEditor(source);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(source, editor.action(getMarkdown()));
        const importantPos = findPos(v.state.doc, "callout", "Purple.");
        const yellowPos = findPos(v.state.doc, "paragraph", "Yellow.");
        const important = v.state.doc.nodeAt(importantPos)!;
        const yellow = v.state.doc.nodeAt(yellowPos)!;

        // Move WARNING's only paragraph to the end of the IMPORTANT callout
        // (the WARNING callout legitimately dissolves), then run the full
        // save pipeline and reopen.
        expect(
            moveBlocks(
                v,
                { from: yellowPos, to: yellowPos + yellow.nodeSize },
                importantPos + important.nodeSize - 1,
            ),
        ).toBe(true);
        const merged = applyMinimalChanges(source, editor.action(getMarkdown()), protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;

        // The minimal-diff merge no longer keeps the stale blank line where the
        // dissolved WARNING callout sat (gapBefore's quote-split guard defers to
        // the serializer's contiguous spacing), so the moved paragraph reopens
        // inside the IMPORTANT callout instead of a split-off bare blockquote.
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    it("hazard B (MAR-120, refused): a closed directive moved below raw ':::' prose is refused — fences would re-pair on reopen", async () => {
        const editor = await makeEditor(
            ":::caution\nClosed body.\n:::\n\n:::unclosed\n\nTail prose.",
        );
        const v = editorView(editor);
        const cautionPos = findPos(v.state.doc, "container_directive", "Closed body.");
        expect(cautionPos).toBeGreaterThan(-1);
        const caution = v.state.doc.nodeAt(cautionPos)!;
        const docBefore = v.state.doc;

        // The save-survival check (plugins/reparseHazard) refuses the move:
        // on reparse the `:::unclosed` prose line would pair with the moved
        // directive's close fence, swallowing the directive as its body —
        // and the second save cycle cements the wrong nesting (the A-fix
        // lengthens the outer fence), permanently flattening the directive.
        // Refusal is the chosen lane (MAR-120); fixing the reparse is
        // parser-level work, out of scope by decision.
        expect(
            moveBlocks(
                v,
                { from: cautionPos, to: cautionPos + caution.nodeSize },
                v.state.doc.content.size,
            ),
        ).toBe(false);
        // A refused move is a PERFECT no-op — reference identity.
        expect(v.state.doc).toBe(docBefore);
        // The user sees the quiet notice, not a silent snap-back.
        expect(
            document.querySelector(".content-guard-notice")?.textContent,
        ).toContain("Move blocked");
    });

    it("hazard C (MAR-121, fixed): literal '\\==text==' prose stays escaped after a move", async () => {
        const editor = await makeEditor(
            "Escaped \\==not a highlight== stays literal.\n\nAnchor paragraph.",
        );
        const v = editorView(editor);
        const para = v.state.doc.firstChild!;

        expect(moveBlocks(v, { from: 0, to: para.nodeSize }, v.state.doc.content.size)).toBe(true);

        // The highlight `unsafe` pattern (plugins/highlight.ts) re-escapes the
        // literal `==` opener, so reparse keeps it plain text — no highlight
        // mark, no lost `==` bytes.
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
    });

    it("hazard E (MAR-123, fixed): moving an empty paragraph conserves content", async () => {
        // `> [!NOTE]` with no body auto-fills an empty paragraph.
        const editor = await makeEditor("> [!NOTE]\n\nAfter.");
        const v = editorView(editor);
        const emptyPos = findPos(v.state.doc, "paragraph", "");
        expect(emptyPos).toBeGreaterThan(-1);

        expect(moveBlocks(v, { from: emptyPos, to: emptyPos + 2 }, v.state.doc.content.size)).toBe(true);

        // The empty paragraph serializes to nothing and does not reopen — but
        // an empty paragraph is not content (it cannot round-trip in pure
        // Markdown), so the content fingerprint no longer counts it and the
        // save pipeline conserves everything that IS content.
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
    });

    it("hazard F (MAR-120, refused): an aside moved inside another aside is refused — reopen deletes its text from disk", async () => {
        const editor = await makeEditor(
            "<aside>\n💡 Outer body.\n</aside>\n\n<aside>\n🐛 Inner mover.\n</aside>",
        );
        const v = editorView(editor);
        const innerPos = findPos(v.state.doc, "notion_callout", "Inner mover.");
        const outerPos = findPos(v.state.doc, "notion_callout", "Outer body.");
        expect(innerPos).toBeGreaterThan(-1);
        const inner = v.state.doc.nodeAt(innerPos)!;
        const outer = v.state.doc.nodeAt(outerPos)!;
        const docBefore = v.state.doc;

        // The save-survival check refuses: `<aside>` nesting is outside
        // Notion's own export grammar — CommonMark HTML-block parsing ends
        // the outer aside at the blank line before the inner one, and the
        // reopened document holds a single paragraph; the resave after that
        // writes the inner aside's text OUT OF THE FILE. The worst verified
        // outcome on the board (hard byte loss), so the move is refused
        // outright rather than allowed to degrade.
        expect(
            moveBlocks(
                v,
                { from: innerPos, to: innerPos + inner.nodeSize },
                outerPos + outer.nodeSize - 1,
            ),
        ).toBe(false);
        expect(v.state.doc).toBe(docBefore);
    });

    // The two MAR-161 merge-tier pins drive the CORPUS fixtures rather than
    // synthetic minimal sources: both bugs depend on the LCS pairing lines
    // across the fixture's surrounding content (isolated minimal docs merge
    // correctly — the distilled string-level repros live in
    // minimalDiff.test.ts). Both are clean at the raw serialize→reparse
    // tier, so the MAR-120 refusal correctly stays quiet.

    it("merge hazard M1 (MAR-161, fixed): raw ':::' prose moved into a directive keeps its separating blank line through the merge", async () => {
        const fixture = fixtures.find((f) => f.name === "directives.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(fixture.content, editor.action(getMarkdown()));
        const prosePos = findContaining(v.state.doc, "paragraph", "::: spaced-name");
        const tipPos = findContaining(v.state.doc, "container_directive", "Attached content under a titled fence");
        expect(prosePos).toBeGreaterThan(-1);
        expect(tipPos).toBeGreaterThan(-1);
        const prose = v.state.doc.nodeAt(prosePos)!;
        const tip = v.state.doc.nodeAt(tipPos)!;

        expect(
            moveBlocks(v, { from: prosePos, to: prosePos + prose.nodeSize }, tipPos + tip.nodeSize - 1),
        ).toBe(true);

        // The serializer emits a blank line between the body paragraph and
        // the fence-shaped prose. FIXED: gapBefore's attachment rule defers
        // to the serializer's separating blank when the saved bytes' glued
        // spacing would re-attach a `:::` line to the paragraph above
        // (before the fix the prose line reopened as `gained:
        // atom:hardbreak:`). MDW_MOVE_SEED=7 finds this pair.
        const merged = applyMinimalChanges(fixture.content, editor.action(getMarkdown()), protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    it("merge hazard M2 (MAR-161, fixed): a moved setext heading's underline survives the merge next to a saved hr", async () => {
        const fixture = fixtures.find((f) => f.name === "kitchen-sink.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(fixture.content, editor.action(getMarkdown()));
        const headingPos = findContaining(v.state.doc, "heading", "tags: [combined, regression]");
        expect(headingPos).toBeGreaterThan(-1);
        const heading = v.state.doc.nodeAt(headingPos)!;
        expect(heading.attrs["setext"]).toBe(true);
        // The seed-99 landing slot: just before the inline-math paragraph,
        // after the `***` hr.
        const target = findContaining(v.state.doc, "paragraph", "Inline math like");
        expect(target).toBeGreaterThan(-1);

        expect(
            moveBlocks(v, { from: headingPos, to: headingPos + heading.nodeSize }, target),
        ).toBe(true);

        // FIXED (MAR-131's normalizer rework): normLineForCompare keys
        // thematic breaks by their marker CHARACTER, so a `-----` setext
        // underline no longer compares equal to a saved `***` hr and the
        // merge cannot "repair" one into the other. (A dash-hr vs dash-
        // underline collision would still key equal — that residual needs
        // line-above context and stays open on MAR-161.) Before the fix the
        // heading dissolved into paragraph + hr; MDW_MOVE_SEED=99 found it.
        const merged = applyMinimalChanges(fixture.content, editor.action(getMarkdown()), protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    it("merge hazard M3 (MAR-322, fixed): a tab sublist moved to a depth only it witnessed keeps the file's tabs through the merge", async () => {
        // The raw serialization is clean, so the refuse lane rightly stays
        // quiet; the corruption lived only in the MERGED bytes. The moved
        // sublist held the file's only depth-2 marker line, so this merge's
        // keeps could not spell the landing depth — before the fix the
        // insertion shipped the serializer's 4-space lines beside kept tabs,
        // and the sublist reparsed one level shallower: `lost:
        // count:bullet_list`. Found by MDW_MOVE_SEED=20260712 with MAR-88's
        // item-internal drop slots, which ship in this same change — so the
        // target below is now an ENUMERATED slot (the fence item has two
        // children, so `itemPos + nodeSize - 1` is its end-of-item slot) and
        // the sampler draws it on its own. It is addressed directly here so
        // the pin holds the exact pair regardless of seed. The distilled
        // string-level pins live in minimalDiff.test.ts.
        const fixture = fixtures.find((f) => f.name === "logseq/page.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(fixture.content, editor.action(getMarkdown()));

        // Source: the innermost sublist opening with "A nested child block" —
        // the only lines in the file at their depths.
        let srcPos = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (
                node.type.name === "bullet_list" &&
                node.firstChild?.textContent.startsWith("A nested child block")
            ) {
                srcPos = pos; // deepest match wins: keep descending
            }
            return true;
        });
        expect(srcPos).toBeGreaterThan(-1);
        const src = v.state.doc.nodeAt(srcPos)!;
        // Target: the last boundary inside the fence-holding bullet item — the
        // INNERMOST item containing the text (findContaining stops at the
        // outermost ancestor, whose landing depth the live keeps CAN spell,
        // which does not reproduce the bug).
        let itemPos = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (
                node.type.name === "list_item" &&
                node.textContent.includes("A fenced code block inside a bullet:")
            ) {
                itemPos = pos; // deepest match wins: keep descending
            }
            return true;
        });
        expect(itemPos).toBeGreaterThan(-1);
        const item = v.state.doc.nodeAt(itemPos)!;

        expect(
            moveBlocks(v, { from: srcPos, to: srcPos + src.nodeSize }, itemPos + item.nodeSize - 1),
        ).toBe(true);

        const merged = applyMinimalChanges(fixture.content, editor.action(getMarkdown()), protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    it("merge hazard M4 (fixed in-session, 2026-08-06): a moved fence cannot leave a mismatched marker pair in the merged bytes", async () => {
        // Found by a rotated-seed boosted sweep (MDW_MOVE_SEED=20260806,
        // MDW_MOVE_SAMPLE=40) standing in for the nightly. Pre-existing and
        // reachable on main: both source and target are top-level boundaries
        // the shipped drag enumerates. Fence marker lines key by info string
        // alone (MAR-312's fix, so ``` and ~~~ spellings survive as keeps),
        // and under a MOVE the LCS paired one fence's kept `~~~` with a
        // DIFFERENT fence's serializer ``` twin — a ``` run cannot close a
        // `~~~` fence, so the mismatched pair swallowed the moved code block
        // on reopen while the raw serialization stayed clean. The engine's
        // lineRoles output self-check now catches the role flip and degrades
        // that save to the serializer's own text (churn, never loss).
        const fixture = fixtures.find((f) => f.name === "fence-tilde-after-escape.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(fixture.content, editor.action(getMarkdown()));

        // Source: the first top-level tilde fence ("tilde fenced content").
        const srcPos = findContaining(v.state.doc, "code_block", "tilde fenced content");
        expect(srcPos).toBeGreaterThan(-1);
        const src = v.state.doc.nodeAt(srcPos)!;
        // Target: the top-level boundary just before "closing paragraph.".
        const target = findContaining(v.state.doc, "paragraph", "closing paragraph.");
        expect(target).toBeGreaterThan(-1);

        expect(moveBlocks(v, { from: srcPos, to: srcPos + src.nodeSize }, target)).toBe(true);

        const merged = applyMinimalChanges(fixture.content, editor.action(getMarkdown()), protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    // ── MAR-323: the rotated-seed sweep's four survivors ────────────────────
    //
    // A boosted sweep standing in for the nightly (MDW_MOVE_SAMPLE=40 across
    // seeds 7, 99, 31337, 20260806, 20260807) surfaced four (source, target)
    // pairs the M1-M4 fixes did not close. Diagnosed on their own terms, per
    // the ticket's own instruction not to assume one mechanism:
    //
    //   - M5/M6 (outline-tables.md): a `keep` table row's saved TAB bytes are
    //     correct under this file's OWN "one tab = two canonical spaces"
    //     depth model, but the REAL parser resolves nesting from tab stop 4,
    //     and the two only coincide when nothing else in the document has a
    //     content column sitting in the gap a tab jumps past. A move can
    //     relocate the row beside a NEW container whose content column lands
    //     exactly in that gap — M5 nests a sibling one level too deep (an
    //     extra `bullet_list`); M6 pushes an unrelated row past the
    //     indented-code threshold and the whole table degrades to
    //     hardbreak-joined text, the worst of the four.
    //   - M7 (logseq/page.md): extracting a paragraph out of a blockquote
    //     dissolves the blockquote to a bare list marker. The merge's own
    //     "keep" bookkeeping had no reason to reconcile that marker's saved
    //     tab against its new neighbours, so it kept sitting exactly where
    //     M5/M6's hazard lives.
    //
    // The fourth pair (logseq/page.md [922,960)->921) is NOT pinned here: it
    // turned out to be a DIFFERENT bug, upstream of this lane's scope. Its
    // raw serialize→reparse is ALREADY damaged before any merge runs — the
    // ticket's premise that "the refuse lane correctly stays quiet" does not
    // hold for this specific pair, because the vacated blockquote item's
    // FIRST child is a blank paragraph while its SECOND is not, and
    // `reparseHazard.ts`'s bare-marker detector (`hazardMachineryPresent`)
    // requires the item's WHOLE content to be blank. That gap belongs to the
    // refuse lane (MAR-324, owned by a different lane this session), not to
    // `applyMinimalChanges` — reported, not fixed here.
    //
    // The general fix (`listDepths` + `hadRelocatedContent` in
    // packages/minimal-diff/src/index.ts and the `lineRoles` role in
    // webview/utils/minimalDiff.ts) reuses the merge's existing output
    // self-check (MAR-312/M4's `lineRoles`/`rolesDiverge`): compute the real
    // list-nesting depth of the merged output and of the serializer's own
    // (repaired) text, and degrade to the serializer's bytes — canonicaliz-
    // ation churn, never corruption — on any divergence. Gated on
    // `hadRelocatedContent` (did a deletion's core content resurface as an
    // insertion elsewhere) so it never re-litigates an ordinary in-place
    // edit's OWN settled indent-carrying rules — MAR-222's "an indent the
    // file renders two ways is dropped, not guessed" has no move in it at
    // all, and would otherwise false-fire under the real-tab-stop-4 model.
    it("merge hazard M5 (MAR-323, fixed): a moved sublist's table row cannot nest one level deeper than its neighbours", async () => {
        const fixture = fixtures.find((f) => f.name === "outline-tables.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(fixture.content, editor.action(getMarkdown()));

        // Source: the sublist under "Traffic by source…" holding the table,
        // "A sibling block after the table.", and "A grandchild…".
        let srcPos = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (
                node.type.name === "bullet_list" &&
                node.textContent.includes("Source") &&
                node.textContent.includes("A sibling block") &&
                node.textContent.includes("A grandchild")
            ) {
                srcPos = pos; // deepest match wins: keep descending
            }
            return true;
        });
        expect(srcPos).toBeGreaterThan(-1);
        const src = v.state.doc.nodeAt(srcPos)!;
        // Target: inside the FIRST item ("# Weekly metrics"), ahead of its
        // own heading — the vacated-marker collapse that puts the moved
        // sublist's first line on the same source line as item 0's marker.
        const target = findPos(v.state.doc, "heading", "Weekly metrics");
        expect(target).toBeGreaterThan(-1);

        expect(moveBlocks(v, { from: srcPos, to: srcPos + src.nodeSize }, target)).toBe(true);

        const merged = applyMinimalChanges(fixture.content, editor.action(getMarkdown()), protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    it("merge hazard M6 (MAR-323, fixed): a moved table cannot degrade to hardbreak-joined text", async () => {
        const fixture = fixtures.find((f) => f.name === "outline-tables.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(fixture.content, editor.action(getMarkdown()));

        // Source: the table itself. It sits at offset > 0 inside its list
        // item (behind an empty leading paragraph the vacated-marker
        // collapse writes), so it is independently grabbable
        // (markerReachablePositions, helpers/moveFuzz.ts) rather than
        // needing its enclosing list_item.
        let srcPos = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (srcPos === -1 && node.type.name === "table") {
                srcPos = pos;
            }
            return srcPos === -1;
        });
        expect(srcPos).toBeGreaterThan(-1);
        const src = v.state.doc.nodeAt(srcPos)!;
        expect(src.type.name).toBe("table");
        // Target: the item-internal slot just ahead of "A closing top-level
        // block.", addressed directly (an item-internal drop slot, not a
        // node boundary `findContaining` can name — M3's same reasoning).
        // A raw offset cannot assert its own identity the way `src` does
        // above, so pin the document size instead: any edit to this fixture
        // shifts the offset onto a different gesture, which most likely
        // round-trips clean and goes green having tested nothing. This fires
        // first, and names the cause.
        expect(v.state.doc.content.size, "outline-tables.md changed; M6's target offset is stale").toBe(390);
        const target = 356;

        expect(moveBlocks(v, { from: srcPos, to: srcPos + src.nodeSize }, target)).toBe(true);

        const merged = applyMinimalChanges(fixture.content, editor.action(getMarkdown()), protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    it("merge hazard M7 (MAR-323, fixed): extracting a paragraph out of a blockquote cannot leave a bare marker beside stray tab bytes", async () => {
        const fixture = fixtures.find((f) => f.name === "logseq/page.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(fixture.content, editor.action(getMarkdown()));

        // Source: the blockquote's own paragraph, "A blockquote nested
        // inside a bullet." — extracting it (rather than moving the whole
        // blockquote) is what dissolves the blockquote to a bare marker.
        const srcPos = findPos(v.state.doc, "paragraph", "A blockquote nested inside a bullet.");
        expect(srcPos).toBeGreaterThan(-1);
        const src = v.state.doc.nodeAt(srcPos)!;
        // Target: the end-of-document drop slot, addressed directly — it
        // carries no node of its own (same reasoning as M6's target above,
        // including the size tripwire and why a raw offset needs one).
        expect(v.state.doc.content.size, "logseq/page.md changed; M7's target offset is stale").toBe(1048);
        const target = 1046;

        expect(moveBlocks(v, { from: srcPos, to: srcPos + src.nodeSize }, target)).toBe(true);

        const merged = applyMinimalChanges(fixture.content, editor.action(getMarkdown()), protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    // M8 is the FOURTH pair from the same MAR-323 sweep, and the one that
    // commit 0134015 reported rather than fixed: its damage is upstream of
    // the merge (the raw serialize->reparse is already broken), so it belongs
    // to the refuse lane, not to applyMinimalChanges. MAR-324's widened gate
    // is what catches it — a result NEITHER ticket could see alone: MAR-323
    // handed the pair off, MAR-324 never knew it closed one.
    //
    // READ THIS BEFORE EDITING logseq/page.md OR QUOTING M8 AS COVERAGE.
    // How the gate arms here is NOT what you would guess, and an earlier
    // version of this comment said the wrong thing. The moved item does not
    // arm it: [blank artifact, blockquote] becomes [blank artifact,
    // paragraph], childCount 2 both before and after, so `leadBlank &&
    // childCount > 2` is false for the gesture's own product. What arms the
    // gate is `- # Project Atlas` near the top of the fixture — an unrelated
    // heading-lead item at childCount 3, ~800 positions away. That is by
    // design, not by accident: hazardMachineryPresent is deliberately COARSE
    // and doc-global (see its header), so ANY hazard machinery anywhere buys
    // the round trip, and the oracle then judges the real damage.
    //
    // The consequence to protect against: if some OTHER machinery is ever
    // added to this fixture, the gate would arm without MAR-324's clause and
    // M8 would pass against the pre-MAR-324 implementation too — still green,
    // pinning nothing.
    //
    // The armer assertion below is the guard against that, and it is NARROWER
    // than it looks: it enumerates only `hazardMachineryPresent`'s artifact-
    // lead disjunct, not its other families (an all-blank item, a container
    // directive, a Notion aside, an `<aside>` html atom, `:::`-shaped prose).
    // Adding one of those to this fixture would arm the gate WITHOUT tripping
    // this assertion. In practice the size tripwire above catches it first,
    // because any such addition changes the document size, and that is the
    // load-bearing half of the pair. Stated rather than fixed: making the
    // predicate call the production gate's own enumeration would couple this
    // pin to `hazardMachineryPresent`'s internals, which is the coupling the
    // size tripwire exists to avoid.
    //
    // AND DO NOT QUOTE M8 AS A USER-FACING GUARANTEE. Target 921 is not a
    // drop slot: blockBoundaryPositions for this fixture emits
    // `... block:917 item:918 block:922 ...`, so no drag can land here. A
    // corpus-wide A/B measured MAR-324's widening as adding ZERO refusals
    // anywhere in the UI-reachable move space (2067 sampled pairs over 39
    // fixtures, plus an exhaustive 402-pair sweep of this fixture: refused=81
    // both before and after). This pin guards a safety property of the gate
    // against regression, which is worth having, and it is NOT evidence that
    // any gesture a user can perform changed behavior. A CHANGELOG entry
    // claiming otherwise was written and then withdrawn on exactly this
    // measurement.
    it("merge hazard M8 (MAR-323 pair 4, refused via MAR-324): extracting the blockquote's paragraph is refused, not silently corrupted", async () => {
        const fixture = fixtures.find((f) => f.name === "logseq/page.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const preDoc = v.state.doc;
        const src = v.state.doc.nodeAt(922)!;
        // The sweep addresses this pair positionally; assert the position
        // still names the node the pair was found on, so a fixture edit
        // retargets loudly rather than pinning some unrelated gesture.
        expect(src.type.name).toBe("paragraph");
        expect(src.textContent).toBe("A blockquote nested inside a bullet.");

        // The armer, asserted because the whole pin depends on it: exactly
        // one artifact-lead item at childCount > 2, and it is NOT the item
        // being moved. If a future fixture edit removes it, or adds hazard
        // machinery of a different family, this fires and tells you M8 has
        // stopped testing MAR-324 — rather than passing for a new reason.
        const armers: number[] = [];
        preDoc.descendants((node, pos) => {
            if (
                node.type.name === "list_item" &&
                node.childCount > 2 &&
                isBlankParagraph(node.child(0), node)
            ) {
                armers.push(pos);
            }
            return true;
        });
        expect(armers, "M8 arms via exactly one artifact-lead item").toHaveLength(1);
        expect(armers[0]).toBeLessThan(922); // the Project Atlas item, not the move
        // Same tripwire as M6/M7, plus the target's own identity: 921 is the
        // blockquote the paragraph is being lifted out of.
        expect(preDoc.content.size, "logseq/page.md changed; M8's offsets are stale").toBe(1048);
        expect(preDoc.nodeAt(921)!.type.name).toBe("blockquote");

        // The gesture must be REFUSED, and refused for the RIGHT reason.
        // moveBlocks returns false from six distinct paths (no-op put-back,
        // three resolveMove refusals, the insert backstop, the content-guard
        // veto), so the boolean alone would not tell MAR-324's refusal apart
        // from any of them. The warn line names the path.
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            expect(moveBlocks(v, { from: 922, to: 960 }, 921)).toBe(false);
            expect(
                warn.mock.calls.map((c) => c.join(" ")).join("\n"),
                "must be the save-survival refusal, not one of the other five",
            ).toMatch(/move refused: document would not survive save\+reopen/);
        } finally {
            warn.mockRestore();
        }
        expect(v.state.doc.eq(preDoc)).toBe(true);
    });

    // M10 is the one hazard in this list the merge's own role self-check could
    // never have caught, however widely it were scoped. Every other pin here
    // compares the merged text against `effective` and finds a difference; here
    // `effective` — the serializer's text with the protected region's saved
    // bytes spliced back in — is ALREADY wrong, so both sides of that
    // comparison carry the identical defect and agree. The repair is what broke
    // it: the saved indented-code bytes were correct where they came from and
    // mean something else once `- list item` sits above them.
    //
    // The rule that catches it is deliberately narrow (`losesOpaqueContent`).
    // The obvious wider rule — stand down whenever the repair changed any
    // line's role — was measured across 285 corpus merges and would have stood
    // down on 34 of them, discarding those files' protection repairs to fix
    // one. Changing roles is what a repair DOES; demoting code is not.
    it("merge hazard M10 (MAR-326, fixed): a moved block cannot leave a fenced code block reparsing as a paragraph", async () => {
        const fixture = fixtures.find((f) => f.name === "fence-edges.md")!;
        const editor = await makeEditor(fixture.content);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(fixture.content, editor.action(getMarkdown()));

        // Source: the `- list item` bullet, moved down past the fence below
        // it. Both ends are raw offsets, which cannot assert their own
        // identity, so the node they name is checked directly and the document
        // size pins the target — any edit to this fixture shifts these onto a
        // different gesture, which most likely round-trips clean and goes green
        // having tested nothing. These fire first, and name the cause.
        expect(
            v.state.doc.content.size,
            "fence-edges.md changed; M10's offsets are stale",
        ).toBe(409);
        const src = v.state.doc.nodeAt(218)!;
        expect(src.textContent, "M10's source is no longer the `- list item` bullet").toContain(
            "list item",
        );
        expect(moveBlocks(v, { from: 218, to: 233 }, 271)).toBe(true);

        // The raw serializer is CLEAN here — it emits the code as a fence at
        // column 0. Asserting that first is what makes the pin's subject the
        // MERGE: if this ever goes red the bug has moved upstream and the
        // assertion below would be blaming the wrong layer.
        const serialized = editor.action(getMarkdown());
        const rawReparse = editor.action((ctx) => ctx.get(parserCtx)(serialized)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(rawReparse)),
            ),
            "the serializer itself regressed; M10 is no longer a merge pin",
        ).toBe("lost: (none); gained: (none)");

        const merged = applyMinimalChanges(fixture.content, serialized, protection);
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
        expect(
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
            ),
        ).toBe("lost: (none); gained: (none)");
    });

    it("a move in a document that ALREADY fails round-trip is not refused (the gesture didn't cause it)", async () => {
        const editor = await makeEditor(
            "First.\n\n:::caution\nBody.\n:::\n\nLast.",
        );
        const v = editorView(editor);
        // Simulate the user TYPING raw fence prose above the directive — an
        // untagged transaction the guard never inspects. The document is now
        // in the B hazard shape on its own: its round-trip is dirty before
        // any move happens.
        const para = v.state.schema.nodes["paragraph"]!.create(
            null,
            v.state.schema.text(":::unclosed"),
        );
        v.dispatch(v.state.tr.insert(0, para));
        expect(reparseDelta(editor, v)).not.toBe("lost: (none); gained: (none)");

        // An unrelated paragraph move must still work: refusing every
        // gesture in an already-broken document traps the user instead of
        // protecting them (see reparseRefusal's pre-doc allowance).
        const lastPos = findPos(v.state.doc, "paragraph", "Last.");
        const last = v.state.doc.nodeAt(lastPos)!;
        expect(moveBlocks(v, { from: lastPos, to: lastPos + last.nodeSize }, 0)).toBe(true);
    });

    it("hazard G (MAR-120, fixed): an hr moved to the head of a directive body stays an hr", async () => {
        const editor = await makeEditor(':::info{title="T"}\nBody paragraph.\n:::\n\n---');
        const v = editorView(editor);
        const hrPos = findPos(v.state.doc, "hr", "");
        expect(hrPos).toBeGreaterThan(-1);

        // Target: the first boundary inside the directive.
        expect(moveBlocks(v, { from: hrPos, to: hrPos + 1 }, 1)).toBe(true);

        // The directive serializer now emits a blank line after the open fence
        // when the body opens on a setext-underline-shaped line, so `---`
        // reparses as a thematic break instead of turning the fence into a
        // setext heading.
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
    });

    // MAR-120 (G) in quote containers — the setext hazard for `> text` +
    // `> ---`. Two distinct cases, both pinned here:
    //   - AFTER a paragraph (blockquote or callout): defused by construction —
    //     a paragraph and an hr are two mdast block siblings, so
    //     remark-stringify's block join emits the disambiguating blank `>`
    //     line between them. No serializer special-case needed.
    //   - At the HEAD of a callout body: NOT by construction — the callout's
    //     `[!NOTE]` marker is a synthesized text line (like a directive's
    //     open fence), so the serializer must insert the blank `>` line
    //     itself (callouts.ts, MAR-157; the directive twin lives in
    //     directives.ts).
    it("hazard G in a blockquote: an hr moved in after a paragraph stays an hr", async () => {
        const editor = await makeEditor("> quoted text\n\n---\n\nTail.");
        const v = editorView(editor);
        const hrPos = findPos(v.state.doc, "hr", "");
        const bqPos = findPos(v.state.doc, "blockquote", "quoted text");
        const bq = v.state.doc.nodeAt(bqPos)!;
        expect(hrPos).toBeGreaterThan(-1);

        // Target: the last boundary inside the blockquote (after the paragraph),
        // so the hr serializes as `> ---` under `> quoted text`.
        expect(
            moveBlocks(v, { from: hrPos, to: hrPos + 1 }, bqPos + bq.nodeSize - 1),
        ).toBe(true);
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
    });

    it("hazard G in a callout: an hr moved in after the body stays an hr", async () => {
        const editor = await makeEditor("> [!NOTE]\n> callout body\n\n---\n\nTail.");
        const v = editorView(editor);
        const hrPos = findPos(v.state.doc, "hr", "");
        const coPos = findPos(v.state.doc, "callout", "callout body");
        const co = v.state.doc.nodeAt(coPos)!;
        expect(hrPos).toBeGreaterThan(-1);

        expect(
            moveBlocks(v, { from: hrPos, to: hrPos + 1 }, coPos + co.nodeSize - 1),
        ).toBe(true);
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
    });

    it("hazard G in a callout (MAR-157): an hr moved to the HEAD of the body stays an hr", async () => {
        const editor = await makeEditor("> [!NOTE]\n> callout body\n\n---\n\nTail.");
        const v = editorView(editor);
        const hrPos = findPos(v.state.doc, "hr", "");
        const coPos = findPos(v.state.doc, "callout", "callout body");
        expect(hrPos).toBeGreaterThan(-1);

        // Target: the FIRST boundary inside the callout, so the hr serializes
        // directly under the `> [!NOTE]` marker line. The marker is a
        // synthesized TEXT line (like a directive's open fence), so
        // `> [!NOTE]` + `> ---` reparses as a setext heading unless the
        // serializer emits the disambiguating blank `>` line.
        expect(moveBlocks(v, { from: hrPos, to: hrPos + 1 }, coPos + 1)).toBe(true);
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
    });
});

describe("corpus move-sampling gate — folded variant", { timeout: CORPUS_TIMEOUT_MS }, () => {
    for (const fixture of fixtures) {
        it(`${fixture.name} with its first foldable collapsed should conserve content and fold state`, async () => {
            const editor = await makeEditor(fixture.content);
            const v = editorView(editor);
            const protection = computeRoundTripProtection(
                fixture.content,
                editor.action(getMarkdown()),
            );
            const foldables = allFoldablePositions(v.state.doc);
            if (foldables.length === 0) {
                return; // nothing foldable in this fixture — base tier covers it
            }
            v.dispatch(
                v.state.tr.setMeta(headingFoldPluginKey, {
                    type: "set",
                    pos: foldables[0]!,
                    folded: true,
                } satisfies HeadingFoldMeta),
            );
            // has(), not size === 1: fixtures may declare their own folded
            // callouts (`[!tip]-` collapses by default).
            expect(headingFoldPluginKey.getState(v.state)!.folded.has(foldables[0]!)).toBe(true);

            sampleMoves(editor, v, fixture, protection, (context) => {
                // The fold entry must still resolve to a foldable block —
                // never to whatever filled the gap (the B5 class).
                const foldableNow = new Set(allFoldablePositions(v.state.doc));
                for (const pos of headingFoldPluginKey.getState(v.state)!.folded) {
                    expect(
                        foldableNow.has(pos),
                        `fold entry at ${pos} no longer resolves to a foldable — ${context}`,
                    ).toBe(true);
                }
            });
        });
    }
});

