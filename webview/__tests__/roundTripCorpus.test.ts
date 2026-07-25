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
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
// Fixture loading, the real-editor factory, and sig() are shared with the
// Layer-3 generative suites (corpusMoveSampling, moveProperty) — one corpus,
// one editor recipe. The showcase (samples/content-inventory.md) rides along
// as a corpus member: every content type it demonstrates must round-trip
// byte-identically, so an inventory edit that breaks a fidelity claim fails
// here.
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
            // original content. Compared without its line ending: in a CRLF
            // fixture the new line correctly arrives CRLF (invariant D owns
            // that), while `sig` above stays byte-exact so the surviving
            // original lines are still checked down to their endings.
            expect(mergedSig[0].replace(/\r$/, "")).toBe("Corpus edit marker paragraph.");
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

describe("corpus invariant C — typing inside a block never restructures the document", () => {
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

            for (const at of targets.slice(0, 12)) {
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
