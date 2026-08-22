/**
 * The first-run tour, driven through the real editor.
 *
 * It is the first document a new user opens and the only one this repo ships
 * that no corpus walks: `loadCorpusFixtures` reads `__tests__/fixtures` and
 * `samples`, and the tour is a Swift string literal in
 * `jot/Sources/BirtaJotCore/FirstRunNote.swift`. So every check on it was a
 * string check written beside it in Swift, asking whether it contains a `*` or
 * ends in an `=`. Those are hand-derived proxies for what the serializer
 * actually does, and the thing they proxy for is right here and answerable.
 *
 * What this catches that a proxy cannot: the tour's table delimiter row and
 * its two bare links are all three rewritten by remark-stringify, and what
 * puts them back is `computeRoundTripProtection`. That protection is
 * load-bearing for this document and nothing pinned it, so a change to the
 * merge layer would have started rewriting the welcome note under the user's
 * first edit with every test green.
 *
 * Read out of the Swift rather than copied into a fixture, so there is one
 * source and no drift.
 *
 * The invariants are the corpus's own A and C, using the same helpers, so the
 * tour is held to the bar every other document in the repo is held to.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { makeCorpusEditor as makeEditor } from "./helpers/moveFuzz";

const root = path.resolve(__dirname, "../..");

/** The tour's markdown, read out of the Swift that ships it. */
const tour = ((): string => {
    const swift = readFileSync(
        path.join(root, "jot/Sources/BirtaJotCore/FirstRunNote.swift"), "utf8");
    const body = swift.match(/public static let markdown = """\n([\s\S]*?)\n {4}"""/)?.[1];
    if (body === undefined) {
        throw new Error("the tour's markdown literal could not be read out of FirstRunNote.swift");
    }
    // Swift strips the closing delimiter's indentation from every line.
    return body.split("\n").map((line) => line.replace(/^ {4}/, "")).join("\n");
})();

/** The node types of a document, in order: what "same structure" means. */
async function reparsedShape(md: string): Promise<string[]> {
    const editor = await makeEditor(md);
    const kinds: string[] = [];
    editor.action((ctx) => {
        ctx.get(editorViewCtx).state.doc.descendants((node) => {
            if (!node.isText) { kinds.push(node.type.name); }
            return true;
        });
    });
    await editor.destroy();
    return kinds;
}

describe("the first-run tour as a document", () => {
    it("should have been read out of the Swift, and be the tour", () => {
        // An extraction that silently produced an empty string would make
        // every invariant below pass over nothing.
        expect(tour.length).toBeGreaterThan(500);
        expect(tour).toContain("## A table");
        expect(tour).toContain("```mermaid");
        expect(tour.split("\n").filter((l) => l.startsWith("- [ ] ")).length)
            .toBeGreaterThanOrEqual(6);
    });

    it("opening it and saving with no edits should reproduce it byte-identically", async () => {
        const editor = await makeEditor(tour);
        const serialized = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(tour, serialized);
        const merged = applyMinimalChanges(tour, serialized, protection);
        await editor.destroy();
        expect(merged).toBe(tour);
    });

    it("the round-trip protection should be what makes that true", async () => {
        // The arm proving the invariant above is doing work rather than
        // agreeing with a serializer that happened to be a no-op. The raw
        // serialization DOES differ from the tour, so the merge is load
        // bearing here and this document is a real exercise of it.
        const editor = await makeEditor(tour);
        const serialized = editor.action(getMarkdown());
        await editor.destroy();
        expect(serialized,
            "the serializer now reproduces the tour unchanged, so the invariant above no longer tests the merge")
            .not.toBe(tour);
    });

    it("typing into any paragraph should not restructure it", async () => {
        const before = await reparsedShape(tour);
        expect(before.length, "the tour should parse into something").toBeGreaterThan(20);

        const editor0 = await makeEditor(tour);
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
        // The tour is short enough to take every paragraph rather than a
        // sample, so this asserts the count it actually reached.
        expect(targets.length, "no paragraph was found to type into").toBeGreaterThan(10);

        for (const at of targets) {
            const editor = await makeEditor(tour);
            const serialized0 = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(tour, serialized0);
            editor.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                view.dispatch(view.state.tr.insertText("Z", at));
            });
            const merged = applyMinimalChanges(tour, editor.action(getMarkdown()), protection);
            await editor.destroy();
            expect(
                await reparsedShape(merged),
                `typing at ${at} restructured the tour — the saved bytes reparse differently`,
            ).toEqual(before);
        }
    });

    it("ticking one of its boxes should not restructure it", async () => {
        // The tour's central gesture, and the one edit it asks for by name.
        // A task toggle rewrites a list item's marker in place, which is a
        // different edit shape from typing into a paragraph.
        const before = await reparsedShape(tour);
        const ticked = tour.replace("- [ ] ", "- [x] ");
        expect(ticked, "the tour should still have a box to tick").not.toBe(tour);
        const editor = await makeEditor(tour);
        const serialized0 = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(tour, serialized0);
        await editor.destroy();
        const merged = applyMinimalChanges(tour, ticked, protection);
        expect(await reparsedShape(merged)).toEqual(before);
        expect(merged).toContain("- [x] ");
    });
});
