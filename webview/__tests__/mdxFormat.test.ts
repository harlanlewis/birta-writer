/**
 * The MDX FormatModule (MAR-42): structural consistency (the
 * formatModule.test.ts pins, applied to format #2), the never-execute
 * contract, byte-perfect preservation of the five mdx node kinds, prose
 * escaping, and the fatal-parse behavior the provider's fallback rides on.
 *
 * Corpus-wide fidelity invariants for `.mdx` fixtures live in
 * roundTripCorpusMdx.test.ts; this file owns the mdx-specific claims.
 */
import { describe, it, expect } from "vitest";
import { schemaCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mdxFormat, mdxBlockId, mdxInlineId } from "../format/mdx";
import { createMdxBlockView, createMdxInlineView, mdxBlockLabel } from "../format/mdx/views";
import { markdownFormat } from "../format/markdown";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { makeCorpusEditor, serializeCorpus, sig } from "./helpers/moveFuzz";

const fixture = (name: string): string =>
    readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("MDX FormatModule structure", () => {
    it("every NodeView it declares should name a node in the schema its presets build", async () => {
        const editor = await makeCorpusEditor("hello", [], mdxFormat);
        const schema = editor.action((ctx) => ctx.get(schemaCtx));
        for (const [nodeId] of mdxFormat.nodeViews) {
            expect(
                schema.nodes[nodeId],
                `nodeViews registers "${nodeId}" but the presets build no such node`,
            ).toBeDefined();
        }
        await editor.destroy();
    });

    it("its presets should extend markdown's rather than fork them", () => {
        // MDX is markdown plus the five structural node kinds, so every
        // markdown preset must be present — a fork would let the two formats'
        // serialization drift apart silently.
        for (const preset of markdownFormat.presets) {
            expect(mdxFormat.presets).toContain(preset);
        }
        expect(mdxFormat.presets.length).toBe(markdownFormat.presets.length + 1);
    });
});

describe("the five mdx node kinds parse as opaque islands", () => {
    it("the tools fixture should map each construct to its raw node with exact source bytes", async () => {
        const content = fixture("tools/mdx.mdx");
        const editor = await makeCorpusEditor(content, [], mdxFormat);
        const found: Record<string, string[]> = {};
        editor.action((ctx) => {
            ctx.get(editorViewCtx).state.doc.descendants((node) => {
                if (node.type.name === mdxBlockId || node.type.name === mdxInlineId) {
                    const kind = node.attrs["kind"] as string;
                    (found[kind] ??= []).push(node.attrs["value"] as string);
                }
                return true;
            });
        });
        await editor.destroy();
        // The import and export lines are ESM (one island — no blank line
        // separates them, so micromark reads one continuous mdxjsEsm run).
        expect(found["mdxjsEsm"]?.[0]).toBe(
            "import {Chart} from './snowfall.js'\nexport const year = 2023",
        );
        // Inline expressions carry their braces.
        expect(found["mdxTextExpression"]).toContain("{year}");
        expect(found["mdxTextExpression"]).toContain("{1 + 1}");
        // The component usage is byte-exact, quoting included.
        expect(found["mdxJsxFlowElement"]).toContain('<Chart color="#fcb32c" year={year} />');
        // The JSX block keeps its nested markdown verbatim inside the island.
        expect(found["mdxJsxFlowElement"]?.some((v) => v.includes("This is *markdown* inside JSX."))).toBe(true);
        // The MDX comment is a flow expression.
        expect(found["mdxFlowExpression"]?.[0]).toContain("MDX comments use JS syntax");
    });

    it("the docs fixture's inline JSX should be an inline island inside its paragraph", async () => {
        const editor = await makeCorpusEditor(fixture("mdx/docs-page.mdx"), [], mdxFormat);
        const inlineValues: string[] = [];
        editor.action((ctx) => {
            ctx.get(editorViewCtx).state.doc.descendants((node) => {
                if (node.type.name === mdxInlineId) {
                    inlineValues.push(node.attrs["value"] as string);
                }
                return true;
            });
        });
        await editor.destroy();
        expect(inlineValues).toContain("<kbd>Cmd</kbd>");
        expect(inlineValues).toContain("{metrics.users}");
    });
});

describe("zero-edit round trip (invariant A for the mdx pipeline)", () => {
    // The tools fixture round-trips byte-identically at the SERIALIZER level,
    // before the minimal-diff merge even runs — the raw islands carry their
    // exact source slices, so the serializer's only work is the prose.
    it("tools/mdx.mdx should serialize back to its own bytes", async () => {
        const content = fixture("tools/mdx.mdx");
        expect(await serializeCorpus(content, mdxFormat)).toBe(content);
    });
});

describe("an edit elsewhere leaves every mdx construct byte-perfect", () => {
    it("adding a paragraph should not disturb any island, adjacency included", async () => {
        const content = fixture("mdx/docs-page.mdx");
        const editor = await makeCorpusEditor(content, [], mdxFormat);
        const serialized0 = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(content, serialized0);
        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const para = view.state.schema.nodes["paragraph"]!.create(
                null,
                view.state.schema.text("MDX edit marker paragraph."),
            );
            view.dispatch(view.state.tr.insert(0, para));
        });
        const merged = applyMinimalChanges(content, editor.action(getMarkdown()), protection);
        await editor.destroy();

        expect(merged).toContain("MDX edit marker paragraph.");
        // Every original line survives verbatim and in order — the same
        // significant-line contract corpus invariant B states, asserted here
        // on the file whose islands are adjacent, quote-mixed, and nested.
        const mergedSig = sig(merged);
        let at = 0;
        for (const line of sig(content)) {
            let foundAt = -1;
            for (let i = at; i < mergedSig.length; i++) {
                if (mergedSig[i] === line) { foundAt = i; break; }
            }
            expect(foundAt, `original line lost or out of order: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
            at = foundAt + 1;
        }
    });
});

describe("prose editing cannot produce invalid MDX", () => {
    it("a typed { and < in prose should serialize escaped and reparse cleanly", async () => {
        const editor = await makeCorpusEditor("A plain paragraph.\n", [], mdxFormat);
        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(view.state.tr.insertText("cost {5} is < 10 ", 1));
        });
        const out = editor.action(getMarkdown());
        await editor.destroy();
        // In MDX `{` opens an expression and `<` opens JSX, so the prose
        // spellings must escape — that is remark-mdx's toMarkdown extension
        // at work, and it is what keeps a save valid MDX.
        expect(out).toContain("\\{5} is \\< 10");
        // The escaped output must itself be valid MDX (parse, don't throw).
        const reparse = await makeCorpusEditor(out, [], mdxFormat);
        await reparse.destroy();
    });
});

describe("fatal parse (the provider fallback's premise)", () => {
    it("an unclosed expression should reject editor creation", async () => {
        await expect(makeCorpusEditor("a {unclosed\n", [], mdxFormat)).rejects.toThrow();
    });

    it("an unclosed JSX tag should reject editor creation", async () => {
        await expect(makeCorpusEditor("<Unclosed>\n", [], mdxFormat)).rejects.toThrow();
    });

    it("the same bytes should still open fine as markdown", async () => {
        // Markdown has no fatal parses — this pair is what confines the
        // fallback path to mdx documents.
        const editor = await makeCorpusEditor("a {unclosed\n<Unclosed>\n", [], markdownFormat);
        await editor.destroy();
    });
});

describe("never execute document code", () => {
    it("a hostile island should render as inert text, not live DOM", () => {
        const hostile = '<script>window.__pwned = true</script><img src=x onerror="window.__pwned2 = true">';
        const block = createMdxBlockView({ attrs: { value: hostile, kind: "mdxJsxFlowElement" } });
        const inline = createMdxInlineView({ attrs: { value: hostile, kind: "mdxJsxTextElement" } });
        for (const view of [block, inline]) {
            // The source bytes are visible to the user...
            expect(view.dom.textContent).toContain("window.__pwned");
            // ...but never parsed as markup: no element materializes.
            expect(view.dom.querySelector("script, img")).toBeNull();
        }
        expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
        expect((window as unknown as Record<string, unknown>)["__pwned2"]).toBeUndefined();
    });

    it("block labels should describe the island without evaluating it", () => {
        expect(mdxBlockLabel("mdxjsEsm", "import x from 'y'")).toBe("MDX import/export");
        expect(mdxBlockLabel("mdxFlowExpression", "{1 + 1}")).toBe("MDX expression");
        expect(mdxBlockLabel("mdxJsxFlowElement", '<Chart data={metrics} />')).toBe("JSX <Chart>");
        expect(mdxBlockLabel("mdxJsxFlowElement", "<>\nfragment\n</>")).toBe("JSX");
    });
});
