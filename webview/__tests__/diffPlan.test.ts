/**
 * The diff plan, checked against invariants rather than expected output.
 *
 * A plan is four numbers per hunk indexing two different documents, which is
 * the shape of bug that expected-output tests are worst at. Assert that a
 * one-word edit yields "one hunk covering the word" and the assertion agrees
 * with whatever the author believed; swap a base position for a working one
 * and it can still agree, because on a short document the two are often equal.
 *
 * So the load-bearing assertion here is RECONSTRUCTION: take the base
 * document, and for every hunk replace `hunk.base` with the working
 * document's `hunk.working`, applying in reverse so earlier positions stay
 * valid. If the plan describes the change honestly the result IS the working
 * document, node for node. Nothing about the author's expectations enters it,
 * and it fails the moment a position indexes the wrong side — which is exactly
 * the mutation the suite below replays.
 *
 * This is the same property `webview/externalSync.ts` already relies on in
 * production for the same change list, which is what makes it a fair thing to
 * demand: the invariant is not invented for the test.
 *
 * Two things the corpus arm asserts about ITSELF, because a sweep that reached
 * nothing passes: how many pairs produced a real verdict, and that both arms
 * of the inline/block split were actually exercised. A `deletedContext` that
 * only ever came back "inline" would leave the block rendering untested while
 * the suite stayed green.
 */
import { describe, it, expect } from "vitest";
import { Editor, parserCtx } from "@milkdown/core";
import { computeDocDiff } from "@milkdown/plugin-diff";
import { EditorState } from "../pm";
import type { Node as ProseNode } from "../pm";
import { makeCorpusEditor, loadCorpusFixtures } from "./helpers/moveFuzz";
import {
    deletionContextAt,
    hasDeletion,
    hasInsertion,
    planDiffHunks,
    type DiffHunk,
} from "../diffView/diffPlan";

/** One editor, so both sides of every pair are parsed by the same schema. */
let shared: Editor | undefined;
async function parser(): Promise<(markdown: string) => ProseNode> {
    shared ??= await makeCorpusEditor("");
    return (markdown) =>
        shared!.action((ctx) => ctx.get(parserCtx)(markdown)) as unknown as ProseNode;
}

/** Base, working, and the plan between them. */
async function plan(baseMd: string, workingMd: string) {
    const parse = await parser();
    const base = parse(baseMd);
    const working = parse(workingMd);
    return { base, working, hunks: planDiffHunks(working, computeDocDiff(base, working)) };
}

/**
 * Rebuild the working document from the base and the plan.
 *
 * Reverse order matters: replacing at an earlier position shifts everything
 * after it, so applying forwards would invalidate every later hunk's base
 * positions. This is the same reverse-application `externalSync.ts` does.
 */
function reconstruct(base: ProseNode, working: ProseNode, hunks: readonly DiffHunk[]): ProseNode {
    const tr = EditorState.create({ doc: base }).tr;
    for (let i = hunks.length - 1; i >= 0; i--) {
        const hunk = hunks[i];
        tr.replace(hunk.base.from, hunk.base.to, working.slice(hunk.working.from, hunk.working.to));
    }
    return tr.doc;
}

describe("planDiffHunks", () => {
    it("identical documents should produce no hunks at all", async () => {
        const { hunks } = await plan("# Title\n\nSome prose.\n", "# Title\n\nSome prose.\n");
        expect(hunks).toEqual([]);
    });

    it("a plan should rebuild the working document from the base", async () => {
        const { base, working, hunks } = await plan(
            "# Title\n\nThe quick brown fox.\n\nGoing away.\n",
            "# Title\n\nThe quick red fox.\n\n- added\n",
        );
        // Reach: a pair that produced no hunks would satisfy the equality
        // below trivially, since reconstruct() of an empty plan is the base.
        expect(hunks.length).toBeGreaterThan(0);
        expect(reconstruct(base, working, hunks).eq(working)).toBe(true);
    });

    it("a word changed mid-sentence should mark the word, not the paragraph", async () => {
        const { working, hunks } = await plan(
            "The quick brown fox jumps over the lazy dog.\n",
            "The quick red fox jumps over the lazy dog.\n",
        );
        const insertedText = hunks
            .filter(hasInsertion)
            .map((h) => working.textBetween(h.working.from, h.working.to))
            .join("");
        // The whole point of a rendered diff over a line diff: the marked run
        // is the word. A line-level result would name the entire sentence and
        // would still be an insertion, so "is there an insertion" proves
        // nothing here.
        expect(insertedText.length).toBeLessThan("The quick red fox".length);
        expect(insertedText).toContain("red");
    });

    it("a deletion inside a paragraph should be inline and one between blocks should not", async () => {
        const inside = await plan("one two three\n", "one three\n");
        const between = await plan("para one\n\npara two\n", "para one\n");
        const contexts = (hs: DiffHunk[]) => hs.filter(hasDeletion).map((h) => h.deletedContext);
        expect(contexts(inside.hunks)).toContain("inline");
        expect(contexts(between.hunks)).toContain("block");
    });

    it("a hunk with neither side should never be planned", async () => {
        const { hunks } = await plan("alpha\n\nbravo\n", "alpha\n\ncharlie\n");
        expect(hunks.length).toBeGreaterThan(0);
        // Not a partition of the loop's own output: `planDiffHunks` maps every
        // change through unfiltered, so an empty change WOULD show up here.
        expect(hunks.filter((h) => !hasInsertion(h) && !hasDeletion(h))).toEqual([]);
    });
});

describe("deletionContextAt", () => {
    it("should discriminate a textblock interior from a block boundary", async () => {
        const parse = await parser();
        const doc = parse("hello world\n");
        // Position 1 is inside the paragraph's text; 0 is the doc boundary.
        expect(deletionContextAt(doc, 1)).toBe("inline");
        expect(deletionContextAt(doc, 0)).toBe("block");
    });
});

describe("planDiffHunks over the corpus", () => {
    /**
     * A realistic edit, applied to a real document: change a word in the first
     * long-enough line, and remove a later one. Deterministic so a failure is
     * reproducible, and shaped like an edit rather than like corruption, so
     * the parse on both sides is a document rather than a diagnostic.
     */
    function mutate(markdown: string): string | null {
        const lines = markdown.split("\n");
        const prose = lines
            .map((line, i) => ({ line, i }))
            .filter(({ line }) => /^[A-Za-z][A-Za-z ,.]{25,}$/.test(line));
        if (prose.length < 2) { return null; }
        const [first, second] = prose;
        const swapped = first.line.replace(/\b[a-z]{4,}\b/, "REPLACEMENT");
        if (swapped === first.line) { return null; }
        lines[first.i] = swapped;
        lines.splice(second.i, 1);
        return lines.join("\n");
    }

    it("every plan over a mutated corpus document should rebuild that document", async () => {
        const fixtures = loadCorpusFixtures();
        expect(fixtures.length).toBeGreaterThan(10);

        let verdicts = 0;
        const contexts = new Set<string>();
        const failures: string[] = [];
        for (const fixture of fixtures) {
            const workingMd = mutate(fixture.content);
            if (workingMd === null) { continue; }
            const { base, working, hunks } = await plan(fixture.content, workingMd);
            if (hunks.length === 0) { continue; }
            verdicts++;
            for (const hunk of hunks) {
                if (hunk.deletedContext) { contexts.add(hunk.deletedContext); }
                // Every position must index the document it claims to. A base
                // position used against the working doc is the bug this catches
                // even where reconstruction happens to survive it.
                expect(hunk.base.from).toBeLessThanOrEqual(hunk.base.to);
                expect(hunk.base.to).toBeLessThanOrEqual(base.content.size);
                expect(hunk.working.from).toBeLessThanOrEqual(hunk.working.to);
                expect(hunk.working.to).toBeLessThanOrEqual(working.content.size);
            }
            if (!reconstruct(base, working, hunks).eq(working)) {
                failures.push(fixture.name);
            }
        }

        // The instrument's own reach: a sweep that mutated nothing, or whose
        // mutations all parsed to the same document, would report success
        // having checked no plan at all.
        expect(verdicts, "corpus documents that produced a real plan").toBeGreaterThan(8);
        // Both arms of the inline/block split were exercised, so neither
        // rendering path is untested behind a green run.
        expect([...contexts].sort()).toEqual(["block", "inline"]);
        expect(failures, "documents whose plan did not rebuild the working doc").toEqual([]);
    }, 60000);
});
