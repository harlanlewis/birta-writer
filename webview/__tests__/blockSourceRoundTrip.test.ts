/**
 * The fidelity gate behind source-peek (MAR-20).
 *
 * Opening a block as Markdown and committing it unchanged must return the
 * document to exactly where it was. The sweep runs the whole corpus through
 * both arms — parsing a block ALONE, the naive commit, against
 * `blocksFromSource`, which puts the document's definitions in scope — so the
 * control arm is what proves the scoped arm is doing work rather than
 * agreeing with itself.
 *
 * The alone arm is expected to DRIFT. If it ever reaches zero, the corpus has
 * lost its reference links and footnotes and this gate has stopped measuring
 * anything; that is why its count is asserted from below.
 */
import { describe, expect, it } from "vitest";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/core";
import type { Node as ProseNode } from "@/pm";
import { blocksFromSource, sourceOfBlocks, type BlockSourcePipeline } from "@/editing/blockSource";
import { loadCorpusFixtures, makeCorpusEditor } from "./helpers/moveFuzz";

interface Drift {
    fixture: string;
    type: string;
    typed: string;
    got: string;
}

describe("block source round trip", () => {
    it("committing an unedited block should return the document unchanged", async () => {
        const fixtures = loadCorpusFixtures();
        const aloneDrifts: Drift[] = [];
        const scopedDrifts: Drift[] = [];
        const typesSeen = new Set<string>();
        let blocks = 0;

        for (const fixture of fixtures) {
            const editor = await makeCorpusEditor(fixture.content);
            editor.action((ctx) => {
                const pipeline: BlockSourcePipeline = {
                    serialize: (doc) => ctx.get(serializerCtx)(doc),
                    parse: (markdown) => {
                        const out = ctx.get(parserCtx)(markdown);
                        return typeof out === "string" || !out ? null : (out as ProseNode);
                    },
                };
                const { doc, schema } = ctx.get(editorViewCtx).state;

                doc.forEach((node: ProseNode) => {
                    blocks += 1;
                    typesSeen.add(node.type.name);
                    const typed = sourceOfBlocks(pipeline, schema, [node]);

                    // Control: the naive commit, parsing the block alone.
                    const alone = pipeline.parse(typed);
                    const aloneOut = alone ? pipeline.serialize(alone) : "<no parse>";
                    if (aloneOut !== typed) {
                        aloneDrifts.push({ fixture: fixture.name, type: node.type.name, typed, got: aloneOut });
                    }

                    // The shipped path.
                    const scoped = blocksFromSource(pipeline, doc, typed);
                    const scopedOut = scoped ? sourceOfBlocks(pipeline, schema, scoped) : "<no parse>";
                    if (scopedOut !== typed) {
                        scopedDrifts.push({ fixture: fixture.name, type: node.type.name, typed, got: scopedOut });
                    }
                });
            });
            await editor.destroy();
        }

        // A sweep that enumerated nothing passes, so it asserts its own size.
        expect(fixtures.length).toBeGreaterThanOrEqual(40);
        expect(blocks).toBeGreaterThanOrEqual(500);
        expect([...typesSeen].sort()).toEqual([
            "blockquote",
            "bullet_list",
            "callout",
            "code_block",
            "container_directive",
            "footnote_definition",
            "heading",
            "hr",
            "link_definition",
            "notion_callout",
            "ordered_list",
            "paragraph",
            "table",
        ]);

        // The control must stay live: these are the document-scoped references
        // whose definitions a lone block cannot see.
        expect(aloneDrifts.length).toBeGreaterThanOrEqual(10);

        expect(scopedDrifts).toEqual([]);
    }, 120_000);
});

describe("blocksFromSource", () => {
    it("a reference whose definition sits elsewhere should survive the round trip", async () => {
        const editor = await makeCorpusEditor(
            "Cite it here[^1] and link it [like this][ref].\n\n[^1]: The note.\n\n[ref]: https://example.com\n",
        );
        editor.action((ctx) => {
            const pipeline: BlockSourcePipeline = {
                serialize: (doc) => ctx.get(serializerCtx)(doc),
                parse: (markdown) => {
                    const out = ctx.get(parserCtx)(markdown);
                    return typeof out === "string" || !out ? null : (out as ProseNode);
                },
            };
            const { doc, schema } = ctx.get(editorViewCtx).state;
            const first = doc.firstChild as ProseNode;
            const typed = sourceOfBlocks(pipeline, schema, [first]);
            expect(typed).toContain("[^1]");
            expect(typed).not.toContain("\\[^1]");

            const back = blocksFromSource(pipeline, doc, typed);
            expect(back).not.toBeNull();
            expect(sourceOfBlocks(pipeline, schema, back as ProseNode[])).toBe(typed);
        });
        await editor.destroy();
    });

    it("an emptied block should parse to no blocks rather than failing", async () => {
        const editor = await makeCorpusEditor("Some prose.\n");
        editor.action((ctx) => {
            const pipeline: BlockSourcePipeline = {
                serialize: (doc) => ctx.get(serializerCtx)(doc),
                parse: (markdown) => {
                    const out = ctx.get(parserCtx)(markdown);
                    return typeof out === "string" || !out ? null : (out as ProseNode);
                },
            };
            const { doc } = ctx.get(editorViewCtx).state;
            expect(blocksFromSource(pipeline, doc, "")).toEqual([]);
        });
        await editor.destroy();
    });

    it("edited source should parse into the blocks the new syntax names", async () => {
        const editor = await makeCorpusEditor("Plain paragraph.\n");
        editor.action((ctx) => {
            const pipeline: BlockSourcePipeline = {
                serialize: (doc) => ctx.get(serializerCtx)(doc),
                parse: (markdown) => {
                    const out = ctx.get(parserCtx)(markdown);
                    return typeof out === "string" || !out ? null : (out as ProseNode);
                },
            };
            const { doc } = ctx.get(editorViewCtx).state;
            const back = blocksFromSource(pipeline, doc, "## A heading\n\n- one\n- two\n");
            expect(back?.map((n) => n.type.name)).toEqual(["heading", "bullet_list"]);
        });
        await editor.destroy();
    });
});
