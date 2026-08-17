/**
 * The launch-perf fixtures must actually CONTAIN the constructs the gate is
 * meant to measure.
 *
 * This is the MAR-310 shape one construct over. There, the prose fixtures ran
 * the proofread matcher over prose that matched nothing, so the harness
 * measured traversal and never the decoration build. Here the subject is the
 * `html` NodeView: no fixture produced a single `html` node, so `launch-perf`
 * could not see any cost in its mount path. A green gate over such a fixture
 * set is evidence of non-interference, not of coverage.
 *
 * It matters because the mount path is per-atom and a document can hold
 * hundreds of atoms: the NodeView resolves a position and walks siblings
 * (`isSoleBlockAtom` in `components/htmlView`), sanitizes per atom through the
 * lazy DOMPurify chunk, and sweeps the rendered subtree for focusables.
 *
 * A grep cannot answer this question, which is why the count runs through the
 * REAL editor (`makeCorpusEditor`: real parser, production serialization
 * config) and reads node types off the resulting document. A raw tag inside a
 * fenced code block is a code block, and a tag inside a mermaid label is a
 * diagram — both look like coverage to a grep and produce no `html` node.
 *
 * This file lives in the jsdom project rather than beside the other fixture
 * guard: `e2e/**\/*.test.mjs` runs in the node environment, and the real editor
 * needs a DOM.
 */
import { describe, it, expect } from "vitest";
import { FIXTURES } from "../../e2e/perf/fixtures.mjs";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";

/** Every node type in the parsed document, with its count. */
async function nodeTypeCounts(markdown: string): Promise<Map<string, number>> {
    const editor = await makeCorpusEditor(markdown);
    const counts = new Map<string, number>();
    editorView(editor).state.doc.descendants((node) => {
        counts.set(node.type.name, (counts.get(node.type.name) ?? 0) + 1);
        return true;
    });
    await editor.destroy();
    return counts;
}

/** The fixture whose job is to isolate the html NodeView's mount path. */
const HTML_FIXTURE = "html-heavy";

/** The GATED fixture that carries a smaller seed of the same branches. */
const GATED_HTML_FIXTURE = "realistic";

/** Split a fixture's html atoms by the branch `isSoleBlockAtom` takes. */
async function htmlBranchCounts(markdown: string): Promise<{ soleBlock: number; inline: number }> {
    const editor = await makeCorpusEditor(markdown);
    let soleBlock = 0;
    let inline = 0;
    editorView(editor).state.doc.descendants((node, _pos, parent) => {
        if (node.type.name !== "html") return true;
        if (parent && parent.type.name === "paragraph" && parent.childCount > 1) inline++;
        else soleBlock++;
        return true;
    });
    await editor.destroy();
    return { soleBlock, inline };
}

describe("launch-perf fixture constructs", () => {
    // Each case parses whole fixtures through the real editor, so the timeouts
    // are per-`it` rather than a raised project-wide default: the sweep below
    // parses every fixture and is the expensive one. The headroom is for a
    // contended machine, which is what turns a fast case into a red one here.
    it(
        "the html fixture should produce html nodes, and enough of them to measure",
        async () => {
            const counts = await nodeTypeCounts(FIXTURES[HTML_FIXTURE]);
            const html = counts.get("html") ?? 0;
            expect(
                html,
                `${HTML_FIXTURE} produced ${html} html nodes; node types present: ${[...counts.keys()].sort().join(", ")}`,
            ).toBeGreaterThan(50);
        },
        30_000,
    );

    it(
        "the html fixture should carry BOTH block atoms and inline pairs",
        async () => {
            // The two shapes take different branches: `isSoleBlockAtom` walks
            // siblings to decide whether an atom owns its whole block, so a
            // fixture of only one shape measures one side of that branch.
            const { soleBlock, inline } = await htmlBranchCounts(FIXTURES[HTML_FIXTURE]);
            expect(soleBlock, "block-level html atoms").toBeGreaterThan(0);
            expect(inline, "inline html atoms sharing a paragraph").toBeGreaterThan(0);
        },
        30_000,
    );

    it(
        "the gated fixture should carry both html branches too, or the gate measures neither",
        async () => {
            // `html-heavy` is ungated, so every assertion above is about a
            // document `launch-perf` never runs. This is the same claim for the
            // fixture that the gate does run: `realistic` pays CI time for its
            // raw HTML on every PR, and it earns that only by reaching both
            // sides of the branch the cost lives in.
            const { soleBlock, inline } = await htmlBranchCounts(FIXTURES[GATED_HTML_FIXTURE]);
            expect(soleBlock, "block-level html atoms").toBeGreaterThan(0);
            expect(inline, "inline html atoms sharing a paragraph").toBeGreaterThan(0);
        },
        30_000,
    );

    it(
        "should report html coverage for every fixture, so a blind spot is visible rather than inferred",
        async () => {
            // A sweep must assert its own coverage: this enumerates the whole
            // fixture set and names what carries the construct, so a fixture
            // added later cannot skip the question. Exactly two fixtures carry
            // html, and which two is the decision, not an accident:
            // `html-heavy` isolates the path ungated, and `realistic` seeds a
            // smaller version so the launch gate can see it (MAR-367). The other
            // gated fixtures stay clean, because seeding one shifts a baseline
            // and buys coverage that `realistic` already provides. This records
            // that state rather than leaving it to a grep.
            const names = Object.keys(FIXTURES);
            expect(names.length, "fixtures enumerated").toBeGreaterThanOrEqual(8);

            const withHtml: string[] = [];
            for (const name of names) {
                const counts = await nodeTypeCounts(FIXTURES[name]);
                if ((counts.get("html") ?? 0) > 0) withHtml.push(name);
            }
            expect(withHtml.sort()).toEqual([HTML_FIXTURE, GATED_HTML_FIXTURE].sort());
        },
        120_000,
    );
});
