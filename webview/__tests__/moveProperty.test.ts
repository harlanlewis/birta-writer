/**
 * Property-based move/duplicate sequences (MAR-113, data-fidelity design §5
 * "Layer 3", tier "property-based"): a small seeded generator — no
 * fast-check, no new dependency — assembles bounded random documents over
 * the REAL schema from a vocabulary of nasty markdown fragments (nested
 * callouts, callout-in-blockquote, task lists in quotes, containers in list
 * items, deep mixed lists, code fences, tables, math), then applies random
 * sequences of moves and duplicates through the real primitives
 * (editing/moveBlocks, blockMenu's duplicateBlockRange), asserting after
 * every op:
 *
 *   - the doc still satisfies every schema invariant (strict doc.check());
 *   - fingerprint conservation per the guard's OWN oracle — checkMove for
 *     moves, checkDuplicate (against the duplicate's declared gain) for
 *     duplicates — the exact functions the runtime guard runs;
 *   - parse(serialize(doc)) is fingerprint-equal to the doc (markdown
 *     re-parse equivalence: the move/duplicate never produced a document
 *     the serializer cannot express — the interactive cousin of B8);
 *   - a failed op left the document REFERENCE-identical (the B2 contract).
 *
 * Bounded and deterministic: DOC_COUNT docs × OPS_PER_DOC ops, seeded PRNG
 * (mulberry32), NO Math.random. Override the seed with
 * MDW_PROP_SEED=<number>. Every failure message carries the seed, the
 * generated document's markdown, and the op list so far — enough to pin a
 * minimized repro as a named regression test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parserCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import {
    checkDuplicate,
    checkMove,
    contentGuardPlugin,
    diffFingerprints,
    fingerprintDoc,
    formatFingerprintDiff,
} from "../plugins/contentGuard";
import { dissolvedMarkersFor, moveBlocks } from "../editing/moveBlocks";
import { duplicateBlockRange } from "../components/blockMenu";
import {
    childrenInRange,
    editorView,
    enumerateMovePairs,
    enumerateMoveSources,
    makeCorpusEditor,
    mulberry32,
    randomInt,
} from "./helpers/moveFuzz";

// The landing flash and range veil are geometry no-ops under jsdom.
vi.mock("../components/blockMenu/rangeIndicator", () => ({
    flashRange: vi.fn(),
    showRangeVeil: vi.fn(),
    hideRangeVeil: vi.fn(),
}));

/** Deterministic default; override with MDW_PROP_SEED=<number>. */
const SEED = Number(process.env["MDW_PROP_SEED"] ?? "20260712");
const DOC_COUNT = 25;
const OPS_PER_DOC = 8;
const MIN_FRAGMENTS = 3;
const MAX_FRAGMENTS = 8;

/**
 * The fragment vocabulary. Every entry must round-trip fingerprint-stable
 * on its own (the per-doc precondition asserts the ASSEMBLED doc reparses
 * clean before any op runs), so a failure after an op is attributable to
 * the op. Directives, raw `<aside>` html, and literal `==...==` prose are
 * deliberately absent — their serializer bugs are already pinned in
 * corpusMoveSampling.test.ts (hazards A–G).
 */
const VOCABULARY: readonly string[] = [
    "Plain paragraph with **bold**, *emphasis*, and `code` inside.",
    "## Section heading\n\nBody paragraph under the heading.",
    "> [!NOTE]\n> Outer callout body.\n>\n> > [!TIP]\n> > Nested callout body.",
    "> A quote paragraph.\n>\n> - [ ] open task in quote\n> - [x] done task in quote",
    "- first item\n- second item\n  - nested item\n    1. deep ordered\n    2. deeper still",
    "1. ordered one\n2. ordered two\n   > a quote inside an ordered item",
    "- item with a container\n\n  > [!WARNING]\n  > a callout inside a list item",
    "```ts\nconst answer: number = 42;\n```",
    "| alpha | beta |\n| --- | --- |\n| one | two |",
    "A paragraph with inline math $a^2 + b^2 = c^2$ in prose.",
    "$$\nE = mc^2\n$$",
    "### Deep heading\n\n> [!IMPORTANT]\n> Callout under a heading.",
];

interface OpRecord {
    op: "move" | "duplicate";
    source: { from: number; to: number };
    target?: number;
    dir?: -1 | 1;
    ok: boolean;
}

let editors: Editor[] = [];
let errorSpy: ReturnType<typeof vi.spyOn>;

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

/** The [ContentGuard] console.error lines emitted so far. */
function guardErrors(): string[] {
    return errorSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((line) => line.includes("[ContentGuard]"));
}

function generateMarkdown(rng: () => number): string {
    const count = MIN_FRAGMENTS + randomInt(rng, MAX_FRAGMENTS - MIN_FRAGMENTS + 1);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
        parts.push(VOCABULARY[randomInt(rng, VOCABULARY.length)]!);
    }
    return parts.join("\n\n");
}

/** Serialize → reparse → fingerprint diff vs the live doc ("" = equal). */
function reparseDiff(editor: Editor, v: EditorView): string {
    const serialized = editor.action(getMarkdown());
    const reparsed = editor.action((ctx) => ctx.get(parserCtx)(serialized)) as ProseNode | null;
    if (!reparsed) {
        return "reparse returned nothing";
    }
    const delta = diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(reparsed));
    const diff = formatFingerprintDiff(delta);
    return diff === "lost: (none); gained: (none)" ? "" : diff;
}

describe("seeded move/duplicate property suite", () => {
    for (let docIndex = 0; docIndex < DOC_COUNT; docIndex++) {
        it(`generated doc ${docIndex} should stay valid, conserving, and re-parse equal through random ops`, async () => {
            const rng = mulberry32((SEED + Math.imul(docIndex + 1, 0x9e3779b9)) >>> 0);
            const markdown = generateMarkdown(rng);
            const ops: OpRecord[] = [];
            const context = (): string =>
                `MDW_PROP_SEED=${SEED} doc=${docIndex}\n--- generated markdown ---\n${markdown}\n` +
                `--- ops so far ---\n${ops.map((o) => JSON.stringify(o)).join("\n") || "(none)"}`;

            const editor = await makeCorpusEditor(markdown, [
                headingFoldPlugin,
                historyPlugin,
                contentGuardPlugin,
            ]);
            editors.push(editor);
            const v = editorView(editor);

            // Vocabulary precondition: the assembled doc reparses clean
            // BEFORE any op, so later failures are attributable to ops.
            expect(reparseDiff(editor, v), `generated doc not reparse-stable — ${context()}`).toBe("");

            let successes = 0;
            for (let opIndex = 0; opIndex < OPS_PER_DOC; opIndex++) {
                const docBefore = v.state.doc;
                const fpBefore = fingerprintDoc(docBefore);
                const guardErrorsBefore = guardErrors().length;
                let record: OpRecord;

                if (rng() < 0.75) {
                    // Move: any UI-expressible pair, nothing excluded. B/F
                    // fence-hazard pairs are refused by the save-survival
                    // check (MAR-120) and exercise the failed-op no-op
                    // branch below; the MERGE-tier bugs (MAR-161) are fixed.
                    const pairs = enumerateMovePairs(v);
                    if (pairs.length === 0) {
                        continue;
                    }
                    const { source, target } = pairs[randomInt(rng, pairs.length)]!;
                    const ok = moveBlocks(v, { from: source.from, to: source.to }, target);
                    record = { op: "move", source: { from: source.from, to: source.to }, target, ok };
                    ops.push(record);
                    if (ok) {
                        // Same emptied-container declaration the primitive
                        // tags — declared dissolution is not loss.
                        const violation = checkMove(
                            diffFingerprints(fpBefore, fingerprintDoc(v.state.doc)),
                            new Set(dissolvedMarkersFor(docBefore, { from: source.from, to: source.to })),
                        );
                        expect(violation, `move violated conservation — ${context()}`).toBeNull();
                    }
                } else {
                    // Duplicate: declared gain is exactly the copied run. No
                    // B/F filter: a duplicate inserts ADJACENT to its
                    // original and never re-parents, so it cannot newly
                    // create a B/F fence shape a clean doc didn't have (an
                    // opener above the original means the doc was dirty
                    // before the op — excluded by the precondition). The
                    // former MERGE-tier exclusion (MAR-161) is gone: those
                    // applyMinimalChanges bugs are fixed.
                    const sources = enumerateMoveSources(v);
                    if (sources.length === 0) {
                        continue;
                    }
                    const source = sources[randomInt(rng, sources.length)]!;
                    const dir: -1 | 1 = rng() < 0.5 ? -1 : 1;
                    const expected = childrenInRange(v.state.doc, source);
                    const ok = duplicateBlockRange(
                        v,
                        { from: source.from, to: source.to },
                        dir,
                    );
                    record = { op: "duplicate", source: { from: source.from, to: source.to }, dir, ok };
                    ops.push(record);
                    if (ok) {
                        expect(expected, `duplicate source range did not tile children — ${context()}`).not.toBeNull();
                        const violation = checkDuplicate(
                            diffFingerprints(fpBefore, fingerprintDoc(v.state.doc)),
                            fingerprintDoc(expected!),
                        );
                        expect(violation, `duplicate violated its declared gain — ${context()}`).toBeNull();
                    }
                }

                // The guard must never fire on a legal, UI-enumerated op.
                expect(
                    guardErrors().slice(guardErrorsBefore),
                    `content guard fired — ${context()}`,
                ).toEqual([]);

                if (!record.ok) {
                    // A failed op is a PERFECT no-op (reference identity).
                    expect(v.state.doc, `failed op mutated the doc — ${context()}`).toBe(docBefore);
                    continue;
                }
                successes++;
                expect(
                    () => v.state.doc.check(),
                    `doc.check() failed — ${context()}`,
                ).not.toThrow();
                expect(reparseDiff(editor, v), `re-parse equivalence broken — ${context()}`).toBe("");
            }
            expect(successes, `no op ever succeeded — ${context()}`).toBeGreaterThan(0);
        });
    }
});
