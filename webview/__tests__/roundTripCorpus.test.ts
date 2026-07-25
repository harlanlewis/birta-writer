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
            // original content.
            expect(mergedSig[0]).toBe("Corpus edit marker paragraph.");
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
