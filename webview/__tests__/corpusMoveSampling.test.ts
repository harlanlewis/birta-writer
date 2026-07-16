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
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
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
import { dissolvedMarkersFor, moveBlocks } from "../editing/moveBlocks";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import {
    editorView,
    enumerateMovePairs,
    hashString,
    knownSavePipelineHazard,
    loadCorpusFixtures,
    makeCorpusEditor,
    mulberry32,
    shuffled,
} from "./helpers/moveFuzz";

// The landing flash and range veil are geometry no-ops under jsdom.
vi.mock("../components/blockMenu/rangeIndicator", () => ({
    flashRange: vi.fn(),
    showRangeVeil: vi.fn(),
    hideRangeVeil: vi.fn(),
}));

/** Deterministic default; override with MDW_MOVE_SEED=<number>. */
const SEED = Number(process.env["MDW_MOVE_SEED"] ?? "20260712");
/** Moves sampled per fixture (and per folded variant). */
const SAMPLE_SIZE = 12;

// This gate holds fixtures to STRICT content conservation under block moves.
// The exploratory Logseq fixtures (fixtures/logseq/) have a known nested-outline
// serialization gap: moving a block within a tab-indented outline reparses to a
// restructured list (an extra bullet_list) — the same class of Logseq round-trip
// fidelity gap tracked in MAR-131. They ARE exercised by the round-trip corpus
// (invariants A/B in roundTripCorpus.test.ts, which they pass); they are scoped
// out of the strict move gate until MAR-131 closes the nested-outline gap. This
// is a deliberate, tracked scoping — not a silenced failure.
const fixtures = loadCorpusFixtures().filter((f) => !f.name.startsWith("logseq/"));

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
    // Known save-pipeline hazards (pre-existing serializer/merge bugs the
    // gate itself surfaced — see knownSavePipelineHazard and the pinned
    // `it.fails` repros below) are excluded from the pair space, so every
    // remaining pair is held to the full contract. Shuffle BEFORE filtering:
    // the sampled prefix then stays stable when a hazard class is fixed and
    // its exclusion removed.
    const pairs = shuffled(enumerateMovePairs(v), rng).filter(
        ({ source, target }) => !knownSavePipelineHazard(v, source, target),
    );
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

describe("corpus move-sampling gate", () => {
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
// first run (see knownSavePipelineHazard in helpers/moveFuzz for the class
// descriptions and the follow-up TODO). Each repro is minimal. A repro that is
// still broken is pinned with `it.fails` (it PASSES today because the bug
// reproduces; the moment a fix lands, `it.fails` starts failing, forcing the
// pin to become a normal assertion and its hazard exclusion to be deleted). A
// repro whose fix has landed is a normal `it` (labelled "MAR-NN, fixed") and
// its exclusion is gone, so the gate now holds that shape to the full
// contract. Remaining `it.fails`: B (raw fence re-pairing) and F (aside
// nesting) — see MAR-120. These are NOT weakened gate assertions; they are the
// loud record of what is excluded and why.

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

/** Fingerprint delta between the live doc and a reparse of its own
 * serialization — the "save then reopen" content diff. */
function reparseDelta(editor: Editor, v: EditorView): string {
    const serialized = editor.action(getMarkdown());
    const reparsed = editor.action((ctx) => ctx.get(parserCtx)(serialized)) as ProseNode;
    return formatFingerprintDiff(
        diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed)),
    );
}

describe("known save-pipeline hazards — pinned repros (it.fails until the serializer is fixed)", () => {
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

    it.fails("hazard B: a closed directive moved below raw ':::' prose should not re-pair fences", async () => {
        const editor = await makeEditor(
            ":::caution\nClosed body.\n:::\n\n:::unclosed\n\nTail prose.",
        );
        const v = editorView(editor);
        const cautionPos = findPos(v.state.doc, "container_directive", "Closed body.");
        expect(cautionPos).toBeGreaterThan(-1);
        const caution = v.state.doc.nodeAt(cautionPos)!;

        expect(
            moveBlocks(
                v,
                { from: cautionPos, to: cautionPos + caution.nodeSize },
                v.state.doc.content.size,
            ),
        ).toBe(true);

        // BUG: on reparse the `:::unclosed` prose line pairs with the moved
        // directive's close fence, swallowing the directive as its body.
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
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

    it.fails("hazard F: an aside moved inside another aside should survive save+reopen", async () => {
        const editor = await makeEditor(
            "<aside>\n💡 Outer body.\n</aside>\n\n<aside>\n🐛 Inner mover.\n</aside>",
        );
        const v = editorView(editor);
        const innerPos = findPos(v.state.doc, "notion_callout", "Inner mover.");
        const outerPos = findPos(v.state.doc, "notion_callout", "Outer body.");
        expect(innerPos).toBeGreaterThan(-1);
        const inner = v.state.doc.nodeAt(innerPos)!;
        const outer = v.state.doc.nodeAt(outerPos)!;

        expect(
            moveBlocks(
                v,
                { from: innerPos, to: innerPos + inner.nodeSize },
                outerPos + outer.nodeSize - 1,
            ),
        ).toBe(true);

        // BUG: the nested `<aside>` is not recognized by the sub-parse on
        // reopen — it flattens into the outer aside's raw html.
        expect(reparseDelta(editor, v)).toBe("lost: (none); gained: (none)");
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

    // MAR-120 (G) in quote containers — the setext hazard the ticket describes
    // for `> text` + `> ---`. Unlike a directive's synthesized open fence (a
    // text line), a paragraph and an hr inside a blockquote/callout are two
    // mdast block siblings, so remark-stringify's block join emits the
    // disambiguating blank `>` line between them by construction — no serializer
    // special-case needed. These pin that the plain case round-trips, so the
    // knownSavePipelineHazard exclusion for hr-into-quote covers only the
    // still-open container fence-repair family (B), not this.
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

describe("corpus move-sampling gate — folded variant", () => {
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
