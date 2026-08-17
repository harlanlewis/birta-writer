/**
 * Round-trip fidelity corpus: every fixture in __tests__/fixtures/ is driven
 * through the REAL Milkdown editor (real parser, real remark-stringify, the
 * production serialization config) plus the real minimal-diff merge with
 * round-trip protection — no mocks.
 *
 * Invariants (the trust contract of the editor):
 *   A. Opening a file and saving without edits reproduces it BYTE-IDENTICALLY.
 *   B. A real edit changes only the edited region: every original significant
 *      line survives verbatim (reference definitions, setext headings, HTML
 *      comments, escaping — nothing is silently dropped or rewritten).
 *   C. Typing INSIDE a block never changes the document's structure: the
 *      merged bytes reparse to the same node tree, modulo the edited text.
 *   D. An edit never introduces a line-ending style the saved file did not
 *      already use.
 *   E. A save carrying edits in SEVERAL blocks — including fenced-code content,
 *      which C never touches — restructures nothing either. C types one
 *      character into one paragraph and saves after each; that pair of limits
 *      is what let MAR-312 corrupt two fixtures sitting in this corpus while C
 *      ran over both and stayed green.
 *
 * Why C exists (2026-07-25): A and B between them never performed an in-place
 * text edit — B only inserts a fresh paragraph at position 0 — so the entire
 * "user types a character" path was ungated. That blind spot hid a document-
 * destroying bug: one keystroke inside a `~~~` fence preceded by a line the
 * serializer canonicalizes produced a MISMATCHED fence pair (``` open, `~~~`
 * close), and every block after it was swallowed into the code block on
 * reopen. B could not see it — no original line was lost, they were merely
 * reclassified as code. C asserts the shape, which is what "lost" actually
 * means to a reader.
 *
 * Two sections follow the four invariants, both added by MAR-237: a fixture-
 * integrity guard (a fixture whose subject is *bytes* can be silently defused
 * by a formatter, and every invariant above stays green when it is), and one
 * pinned repro for an edit shape — the SPLIT — that none of the four tiers
 * performs. Each carries its own reasoning at the section.
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
// Fixture loading, the real-editor factory, and sig() are shared with the
// Layer-3 generative suites (corpusMoveSampling, moveProperty) — one corpus,
// one editor recipe. The sample documents (samples/content-inventory.md, the
// exhaustive corpus, and samples/showcase.md, the human tour) ride along as
// corpus members: every content type they demonstrate must round-trip
// byte-identically, so a sample edit that breaks a fidelity claim fails here.
import { loadCorpusFixtures, makeCorpusEditor as makeEditor, sig } from "./helpers/moveFuzz";

const fixtures = loadCorpusFixtures();

describe("corpus invariant A — open then save without edits is byte-identical", () => {
    for (const { name, content } of fixtures) {
        it(`${name} should round-trip unchanged`, async () => {
            const editor = await makeEditor(content);
            const serialized = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(content, serialized);

            const merged = applyMinimalChanges(content, serialized, protection);

            expect(merged).toBe(content);
            await editor.destroy();
        });
    }
});

describe("corpus invariant B — an edit keeps every original line intact", () => {
    for (const { name, content } of fixtures) {
        it(`${name} should lose nothing when a paragraph is added`, async () => {
            const editor = await makeEditor(content);
            const serialized0 = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(content, serialized0);

            // The edit: a brand-new paragraph inserted at the very top.
            editor.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const para = view.state.schema.nodes["paragraph"].create(
                    null,
                    view.state.schema.text("Corpus edit marker paragraph."),
                );
                view.dispatch(view.state.tr.insert(0, para));
            });
            const serialized = editor.action(getMarkdown());

            const merged = applyMinimalChanges(content, serialized, protection);

            expect(merged).toContain("Corpus edit marker paragraph.");
            // Every original significant line must survive byte-for-byte AND
            // in the original order (an adversarial review found a merge that
            // preserved the line multiset while reordering the document).
            const mergedSig = sig(merged);
            let at = 0;
            for (const line of sig(content)) {
                let found = -1;
                for (let i = at; i < mergedSig.length; i++) {
                    if (mergedSig[i] === line) { found = i; break; }
                }
                expect(found, `original line lost or out of order: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
                at = found + 1;
            }
            // The inserted paragraph must sit at the very top, above all
            // original content — and carry the fixture's OWN line ending. An
            // earlier version stripped a trailing `\r` before comparing, which
            // let one CRLF fixture pass by weakening the assertion for all 33;
            // asserting the ending is both stronger and narrower. Every fixture
            // uses a single style (guarded with invariant D), so the file's
            // ending and its dominant ending are the same thing here.
            const eol = content.includes("\r\n") ? "\r" : "";
            expect(mergedSig[0]).toBe("Corpus edit marker paragraph." + eol);
            await editor.destroy();
        });
    }
});

/** The full node-type tree of `md` after a REAL reparse — what a reader would
 *  actually get back. Text nodes are excluded so the edited character itself
 *  doesn't register as a difference. */
async function reparsedShape(md: string): Promise<string[]> {
    const editor = await makeEditor(md);
    const kinds: string[] = [];
    editor.action((ctx) => {
        ctx.get(editorViewCtx).state.doc.descendants((node) => {
            if (!node.isText) kinds.push(node.type.name);
            return true;
        });
    });
    await editor.destroy();
    return kinds;
}

/**
 * Fixtures invariant C fails on TODAY, each with the ticket that owns it. An
 * entry is a real, reproducible structure loss awaiting a design decision in
 * the merge layer — never a flake, and never acceptable behaviour.
 *
 * Currently EMPTY, and that is the goal state. The three founding entries
 * (`logseq/journal.md`, `logseq/page.md`, `table-cell-breaks.md`) were all one
 * bug — an in-place replacement committed the serializer's whole line, so an
 * edited line's untouched parts (its outline indent unit, its other table
 * cells) were canonicalized while its neighbours kept their saved bytes. Closed
 * by `FormatProfile.reconcileReplacement` (MAR-213 / MAR-214).
 *
 * DELETE a line here the moment its ticket lands — an entry that stops failing
 * is a gate silently doing nothing.
 */
const INVARIANT_C_KNOWN_FAILURES: Record<string, string> = {};

/**
 * At most `budget` entries of `items`, spread EVENLY across the whole array
 * (first and last always included) rather than taken from the front.
 *
 * C types into a bounded number of paragraphs — the budget is what keeps this
 * gate affordable on every PR. Taking the first N made that budget a function
 * of where a fixture's prose sits: a file with a long non-subject preamble
 * spent all twelve edits inside the preamble and never reached its own subject,
 * so the gate read as coverage while testing nothing the fixture was written
 * for (MAR-237 hit it while adding fixtures with realistic preambles;
 * `reference-heavy-with-preamble.md` has 36 targets and its first 12 are all
 * preamble). A stride costs exactly the same twelve edits and cannot be
 * defeated by document layout.
 */
function stridedSample<T>(items: readonly T[], budget: number): T[] {
    if (items.length <= budget) {
        return [...items];
    }
    const step = (items.length - 1) / (budget - 1);
    const picked = new Set<number>();
    for (let i = 0; i < budget; i++) {
        picked.add(Math.round(i * step));
    }
    return [...picked].map((i) => items[i]!);
}

// Invariant C types a character into EVERY paragraph of a fixture and reparses
// after each one, so its cost scales with paragraph count rather than file size.
// On the largest fixture (`content-inventory.md`) that measured 6608 ms, above
// the 5 s default. Headroom over a measured cost, scoped to this suite so the
// other three invariants keep the tight default.
const INVARIANT_C_TIMEOUT_MS = 30_000;

describe("corpus invariant C — typing inside a block never restructures the document", { timeout: INVARIANT_C_TIMEOUT_MS }, () => {
    // The stride is the point: a budget taken from the FRONT is a budget a
    // fixture's own layout can spend before the gate reaches its subject. This
    // case fails the moment the sampler goes back to `slice(0, budget)`.
    it("a budget smaller than the target list should still reach the end of it", () => {
        const items = Array.from({ length: 100 }, (_, i) => i);
        const picked = stridedSample(items, 12);
        expect(picked.length).toBe(12);
        expect(picked[0]).toBe(0);
        expect(picked.at(-1)).toBe(99);
        expect(picked).not.toEqual(items.slice(0, 12));
        // A list at or under budget is taken whole, unchanged.
        expect(stridedSample([1, 2, 3], 12)).toEqual([1, 2, 3]);
    });

    for (const { name, content } of fixtures) {
        const known = INVARIANT_C_KNOWN_FAILURES[name];
        const label = known
            ? `${name} should keep its structure when a character is typed into every paragraph [known failure: ${known}]`
            : `${name} should keep its structure when a character is typed into every paragraph`;
        (known ? it.fails : it)(label, async () => {
            const before = await reparsedShape(content);

            // Type into EVERY paragraph in turn, one editor per edit, so a
            // construct is exercised wherever it sits rather than only at the
            // first one the walk happens to reach.
            const editor0 = await makeEditor(content);
            const targets: number[] = [];
            editor0.action((ctx) => {
                ctx.get(editorViewCtx).state.doc.descendants((node, pos, parent) => {
                    if (node.isText && (node.text?.length ?? 0) > 2 && parent?.type.name === "paragraph") {
                        targets.push(pos + 1);
                    }
                    return true;
                });
            });
            await editor0.destroy();

            for (const at of stridedSample(targets, 12)) {
                const editor = await makeEditor(content);
                const serialized0 = editor.action(getMarkdown());
                const protection = computeRoundTripProtection(content, serialized0);
                editor.action((ctx) => {
                    const view = ctx.get(editorViewCtx);
                    view.dispatch(view.state.tr.insertText("Z", at));
                });
                const merged = applyMinimalChanges(content, editor.action(getMarkdown()), protection);
                await editor.destroy();

                expect(
                    await reparsedShape(merged),
                    `typing at ${at} restructured the document — the saved bytes reparse differently`,
                ).toEqual(before);
            }
        });
    }
});

/**
 * Invariant E — one save carrying edits in SEVERAL blocks.
 *
 * Differs from C on both axes at once: it types into fenced-code content as
 * well as paragraphs, and saves ONCE at the end. Edits go back to front so an
 * insertion cannot shift a position still to come.
 *
 * Both axes are load-bearing. The shape C cannot reach: round-trip protection
 * repairs a canonicalized line back to its saved bytes, one region per line,
 * each anchored to its neighbours. A tilde fence's two marker lines are two
 * regions — edit the prose above the fence AND inside its content in one save,
 * and the open line's anchors are both invalidated while the close line's
 * following anchor survives. One end repairs to `~~~`, the other keeps ```, the
 * fence never terminates, and the rest of the document is swallowed as code.
 *
 * A save carries every edit made since the last one (MAR-303), so "several
 * edits, one save" is an ordinary sitting's work — which is why a gate that
 * saves after every keystroke overstates its coverage.
 */
const INVARIANT_E_TIMEOUT_MS = 30_000;

describe("corpus invariant E — one save carrying several edits never restructures the document", { timeout: INVARIANT_E_TIMEOUT_MS }, () => {
    for (const { name, content } of fixtures) {
        it(`${name} should keep its structure when several blocks are edited before one save`, async () => {
            const before = await reparsedShape(content);

            const editor = await makeEditor(content);
            const protection = computeRoundTripProtection(content, editor.action(getMarkdown()));

            const targets: number[] = [];
            editor.action((ctx) => {
                ctx.get(editorViewCtx).state.doc.descendants((node, pos, parent) => {
                    const holder = parent?.type.name;
                    if (
                        node.isText &&
                        (node.text?.length ?? 0) > 2 &&
                        (holder === "paragraph" || holder === "code_block")
                    ) {
                        targets.push(pos + 1);
                    }
                    return true;
                });
            });

            const picked = stridedSample(targets, 12).sort((a, b) => b - a);
            // A fixture with fewer than two eligible blocks has nothing
            // multi-block to say. Asserted rather than returned silently: a
            // bare `return` here reports green, so a change that stopped
            // FINDING targets — a renamed node type, a moved directory — would
            // empty this gate across every fixture at once and look like a pass.
            expect(
                picked.length,
                `${name}: fewer than two editable blocks, so this fixture exercises nothing`,
            ).toBeGreaterThan(1);

            editor.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                let tr = view.state.tr;
                for (const at of picked) tr = tr.insertText("Z", at);
                view.dispatch(tr);
            });
            const merged = applyMinimalChanges(content, editor.action(getMarkdown()), protection);
            await editor.destroy();

            expect(
                await reparsedShape(merged),
                `editing ${picked.length} blocks before ONE save restructured the document`,
            ).toEqual(before);
        });
    }
});

/** The distinct line-ending styles a text uses, e.g. `["CRLF"]` or
 *  `["CRLF","LF"]`. The final element of a `\n` split is the text after the
 *  last ending, not a line, so it never contributes.
 *
 *  Deliberately a SET, which bounds what D can catch: it proves no new style
 *  was introduced, not that each individual line kept its own. On an
 *  already-mixed document D would therefore permit endings to be shuffled
 *  between lines. No fixture is mixed today, and the per-line guarantee is
 *  pinned directly in the engine's suite (`packages/minimal-diff`, "a document
 *  with MIXED endings should keep each untouched line's own ending"); tighten
 *  this if a mixed fixture is ever added. */
function eolStyles(text: string): string[] {
    const parts = text.split("\n").slice(0, -1);
    return [...new Set(parts.map((l) => (l.endsWith("\r") ? "CRLF" : "LF")))].sort();
}

describe("corpus invariant D — an edit never introduces a line ending the file did not use", () => {
    // D can only catch anything on a fixture that is NOT plain LF: on an LF
    // file the serializer's own output already matches, so the assertion holds
    // no matter what the engine does. Exactly one fixture discriminates today.
    // Without this guard, deleting or LF-normalizing that one file (a stray
    // `.gitattributes`, an editor "fixing" line endings on save) would turn D
    // into 33 green no-ops that still read like coverage.
    it("at least one fixture must use CRLF, or every case below is vacuous", () => {
        const crlf = fixtures.filter((f) => f.content.includes("\r\n")).map((f) => f.name);
        expect(crlf, "no CRLF fixture left in the corpus — invariant D now proves nothing").not.toEqual([]);
    });

    // The per-fixture cases compare SETS of styles, so they prove no new style
    // appeared, not that each line kept its own. That is only equivalent while
    // fixtures are internally uniform. If a deliberately mixed fixture is ever
    // added, this guard fires — tighten D to a per-line comparison then, and
    // see the engine's "MIXED endings" case for the guarantee it should assert.
    it("every fixture should use exactly one line-ending style", () => {
        for (const { name, content } of fixtures) {
            expect(eolStyles(content).length, `${name} mixes line-ending styles`).toBeLessThanOrEqual(1);
        }
    });

    // Why D exists (MAR-223): A and B and C are all blind to line endings. A
    // passed on the CRLF fixture only because round-trip protection was
    // holding every line — the serializer emits LF, the `\r` sat inside the
    // comparison key, so a zero-edit round trip read as a whole-file rewrite.
    // Editing anything unprotected its region and wrote it back LF-only,
    // leaving a file that is neither CRLF nor LF. B could not see it (the
    // original lines all survived, elsewhere in the file) and C could not
    // either (line endings are not document shape).
    for (const { name, content } of fixtures) {
        it(`${name} should keep its line-ending style when a character is typed`, async () => {
            const before = eolStyles(content);

            const editor = await makeEditor(content);
            const serialized0 = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(content, serialized0);
            let at = -1;
            editor.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                view.state.doc.descendants((node, pos, parent) => {
                    if (at === -1 && node.isText && (node.text?.length ?? 0) > 2
                        && parent?.type.name === "paragraph") { at = pos + 1; }
                    return true;
                });
                if (at !== -1) view.dispatch(view.state.tr.insertText("Z", at));
            });
            const merged = applyMinimalChanges(content, editor.action(getMarkdown()), protection);
            await editor.destroy();

            if (at === -1) return; // no editable paragraph in this fixture
            expect(
                eolStyles(merged),
                "typing introduced a line-ending style the saved file did not use",
            ).toEqual(before);
        });
    }
});

// ── Fixture integrity (MAR-237) ─────────────────────────────────────────────
//
// Same reasoning as invariant D's CRLF guard above: some fixtures carry their
// subject in bytes an editor, a formatter, or a `.gitattributes` rule would
// happily "fix" on the way past — and every invariant here would stay green
// afterwards while proving nothing. These cases fail instead.

describe("corpus fixture integrity — the bytes a fixture exists FOR must still be in it", () => {
    const fixture = (name: string): string =>
        fixtures.find((f) => f.name === name)?.content ?? "";

    it("encoding-and-scripts.md should still carry its whitespace conventions verbatim", () => {
        const content = fixture("encoding-and-scripts.md");
        expect(content, "fixture missing").not.toBe("");
        const lines = content.split("\n");
        expect(lines.some((l) => /[^ ]  $/.test(l)), "no two-space hard break left").toBe(true);
        expect(lines.some((l) => /[^ ] $/.test(l)), "no single trailing space left").toBe(true);
        expect(lines.some((l) => /[^\\]\\$/.test(l)), "no backslash hard break left").toBe(true);
        expect(lines.some((l) => !l.startsWith("|") && l.includes("\t")), "no hard tab in prose left").toBe(true);
        expect(lines.some((l) => l.startsWith("|") && l.includes("\t")), "no hard tab in a table cell left").toBe(true);
    });

    it("outline-tables.md should still be indented with TABS", () => {
        const content = fixture("outline-tables.md");
        expect(content, "fixture missing").not.toBe("");
        // Its whole subject is a table whose rows sit at a TAB-indented block's
        // content column; respelled with spaces it becomes a duplicate of the
        // coverage tables-and-code.md already has, and the MAR-241 net is gone.
        expect(content.split("\n").filter((l) => l.startsWith("\t")).length).toBeGreaterThan(4);
        expect(content).toContain("\t  |");
    });
});

// ── Pinned edit-tier repro the corpus tiers cannot express (MAR-237) ─────────
//
// A–D drive three edits: none, a paragraph inserted at position 0, and one
// typed character (corpusMoveSampling adds a fourth, the block move). A SPLIT —
// pressing Enter mid-paragraph — is none of those, and a corpus-wide split
// sweep run while growing this file found losses all four tiers are blind to.
// The one below is pinned because it is small, deterministic, and entirely
// inside the serializer.
//
// The sweep itself is deliberately NOT shipped: splitting at a word boundary
// legitimately moves a space across the split, which the content fingerprint
// reads as a changed text node, so most of its findings were that noise. A
// split gate needs a whitespace-insensitive oracle before it can be a gate.

describe("pinned edit-tier repro — splitting inside an inline mark", () => {
    /** Split `src` between its two words and return what would be saved. */
    async function splitBetweenWords(src: string): Promise<string> {
        const editor = await makeEditor(src);
        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(view.state.tr.split(view.state.doc.textContent.indexOf("two") + 1));
        });
        const out = editor.action(getMarkdown());
        await editor.destroy();
        return out;
    }

    // The control, and the reason the case below is a bug rather than a quirk:
    // for a BUILT-IN mark remark-stringify moves the boundary space OUTSIDE the
    // delimiters, which keeps the mark valid.
    it("a split inside bold should leave the space outside the delimiters", async () => {
        expect(await splitBetweenWords("Unicode **one two** survives.\n"))
            .toBe("Unicode **one** \n\n**two** survives.\n");
    });

    // MAR-237-found, fixed by Milkdown 7.22.0. `==` is a paired inline
    // delimiter with the same flanking rule, so a closer preceded by
    // whitespace does not close: `==one ==` reopened as LITERAL TEXT and the
    // highlight was gone from the file. The old `#moveSpaces` hunted for the
    // first and last TEXT child anywhere in a mark's child list and trimmed
    // those, which skipped the boundary when the real first/last child was
    // something else; #2405 trims the actual first/last child, or nothing.
    //
    // Note what does NOT catch this — the corrupt output was a round-trip
    // FIXED POINT (`==one ==` re-serializes to itself, since `==` in prose is
    // not escaped), so serialize→parse→serialize stability, the invariant this
    // repo otherwise prefers, was green on it. The delimiters have to be
    // asserted directly.
    it("a split inside a highlight should leave the space outside the delimiters [MAR-237-found]", async () => {
        expect(await splitBetweenWords("Unicode ==one two== survives.\n"))
            .toBe("Unicode ==one== \n\n==two== survives.\n");
    });
});
