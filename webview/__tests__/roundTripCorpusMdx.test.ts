/**
 * Round-trip fidelity corpus for the MDX pipeline (MAR-42): every `.mdx`
 * fixture under __tests__/fixtures/ drives the real editor built with the
 * mdx FormatModule — the multiformat enrollment `loadCorpusFixtures` /
 * `makeCorpusEditor` were parameterized for (MAR-40/41).
 *
 * Invariants A, B, and C are roundTripCorpus.test.ts's, restated over the
 * mdx corpus (see that file for their charters). D (line endings) is not
 * duplicated here: it gates the engine, which both formats share through the
 * same profile, and it needs a CRLF fixture to discriminate — add one here
 * the day an mdx line-ending bug is found.
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { mdxFormat } from "../format/mdx";
import { loadCorpusFixtures, makeCorpusEditor, sig } from "./helpers/moveFuzz";

const fixtures = loadCorpusFixtures(".mdx");

describe("mdx corpus is populated", () => {
    it("the walk should find the mdx fixture family", () => {
        // A discovery regression (renamed directory, changed extension
        // filter) would empty every suite below into a green no-op; this is
        // the same guard shape the markdown corpus carries (MIN_CORPUS_SIZE).
        expect(fixtures.length).toBeGreaterThanOrEqual(3);
        expect(fixtures.map((f) => f.name)).toContain("tools/mdx.mdx");
    });
});

describe("mdx corpus invariant A — open then save without edits is byte-identical", () => {
    for (const { name, content } of fixtures) {
        it(`${name} should round-trip unchanged`, async () => {
            const editor = await makeCorpusEditor(content, [], mdxFormat);
            const serialized = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(content, serialized);

            const merged = applyMinimalChanges(content, serialized, protection);

            expect(merged).toBe(content);
            await editor.destroy();
        });
    }
});

describe("mdx corpus invariant B — an edit keeps every original line intact", () => {
    for (const { name, content } of fixtures) {
        it(`${name} should lose nothing when a paragraph is added`, async () => {
            const editor = await makeCorpusEditor(content, [], mdxFormat);
            const serialized0 = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(content, serialized0);

            editor.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const para = view.state.schema.nodes["paragraph"]!.create(
                    null,
                    view.state.schema.text("Corpus edit marker paragraph."),
                );
                view.dispatch(view.state.tr.insert(0, para));
            });
            const serialized = editor.action(getMarkdown());

            const merged = applyMinimalChanges(content, serialized, protection);

            expect(merged).toContain("Corpus edit marker paragraph.");
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
            expect(mergedSig[0]).toBe("Corpus edit marker paragraph.");
            await editor.destroy();
        });
    }
});

/** The full node-type tree of `mdx` after a REAL reparse (mdx pipeline). */
async function reparsedShape(mdx: string): Promise<string[]> {
    const editor = await makeCorpusEditor(mdx, [], mdxFormat);
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

const INVARIANT_C_TIMEOUT_MS = 30_000;

describe("mdx corpus invariant C — typing inside a block never restructures the document", { timeout: INVARIANT_C_TIMEOUT_MS }, () => {
    for (const { name, content } of fixtures) {
        it(`${name} should keep its structure when a character is typed into every paragraph`, async () => {
            const before = await reparsedShape(content);

            const editor0 = await makeCorpusEditor(content, [], mdxFormat);
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

            // The mdx fixture family is small enough to type into every
            // paragraph; cap it so a future large fixture cannot make this
            // gate unaffordable (the markdown corpus strides for the same
            // reason).
            for (const at of targets.slice(0, 12)) {
                const editor = await makeCorpusEditor(content, [], mdxFormat);
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
