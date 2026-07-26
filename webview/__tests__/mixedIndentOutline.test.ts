/**
 * Mixed indent units in one outline (MAR-222) — driven through the REAL
 * editor and the REAL save pipeline, because the failure is only visible on
 * a reparse.
 *
 * `minimalDiff.test.ts` pins the merge's bytes for this shape; what it cannot
 * show is the consequence, which is structural: the bytes the merge writes
 * reparse into a different tree than the one the user is looking at. This
 * file asserts the observable a user would actually lose — the nesting — by
 * serializing, merging, and reparsing exactly as a save does.
 *
 * Why not a corpus fixture, which is where a shape like this belongs and
 * where an earlier cut of this change put it: the move-sampling gate also
 * runs every fixture it accepts through block MOVES, and moves reach this
 * same hazard by a path MAR-222 does not fix — an inserted line has no saved
 * counterpart, so the merge writes it with the serializer's indent next to
 * kept lines holding tabs. That is MAR-230, open, and the fixture belongs
 * with it.
 *
 * That gate already carries a fixture-level exclusion for exactly this bug
 * (fixtures/logseq/ — see corpusMoveSampling.test.ts), so a mixed-indent
 * fixture could only be a second entry on that list or an immediate failure.
 * Neither is this ticket's call, hence a plain test file: it pins the typing
 * fix without taking a position on the move gate.
 *
 * NOTE the coverage boundary, which is real and not just caution: the fix
 * learns a file's indent conventions from lines the zero-edit round trip
 * paired one-to-one, so two NEIGHBOURING lines sharing an unusual indent
 * teach it nothing and editing one of them still shifts it. The last test
 * here pins that, so the gap is visible rather than assumed closed.
 */
import { describe, it, expect } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import { editorViewCtx, parserCtx } from "@milkdown/core";
import type { Node as ProseNode } from "../pm";
import { computeRoundTripProtection, applyMinimalChanges } from "../utils/minimalDiff";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";

/** Every non-text node type in document order — the tree a reader gets back. */
function shape(doc: ProseNode): string[] {
    const kinds: string[] = [];
    doc.descendants((node) => {
        if (!node.isText) kinds.push(node.type.name);
        return true;
    });
    return kinds;
}

/**
 * Type `Z` into the paragraph whose text starts with `into`, then run the
 * production save pipeline (serialize → protection → minimal-diff merge) and
 * reparse the bytes that would land on disk.
 */
async function typeAndSave(source: string, into: string) {
    const editor = await makeCorpusEditor(source);
    const v = editorView(editor);
    const protection = computeRoundTripProtection(source, editor.action(getMarkdown()));

    let at = -1;
    v.state.doc.descendants((node, pos, parent) => {
        if (at === -1 && node.isText && node.text?.startsWith(into) && parent?.type.name === "paragraph") {
            at = pos + 1;
        }
        return at === -1;
    });
    expect(at, `no paragraph starting "${into}"`).toBeGreaterThan(-1);

    v.dispatch(v.state.tr.insertText("Z", at));
    const merged = applyMinimalChanges(source, editor.action(getMarkdown()), protection);
    const live = shape(v.state.doc);
    const reparsed = shape(editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode);
    await editor.destroy();
    return { merged, live, reparsed };
}

describe("mixed indent units in one outline (MAR-222)", () => {
    // Level 1 is a plain tab, which normalizes to the serializer's two spaces
    // and so is an edit-proof `keep`. Level 2 is a tab plus three spaces,
    // which does not key equal and is held only by a round-trip protection
    // region — and editing the construct is exactly what releases protection.
    const SOURCE = "- alpha parent\n\t- beta child\n\t   - gamma grandchild\n\t- delta child\n";

    it("typing into the deepest item should not restructure the outline", async () => {
        const { live, reparsed } = await typeAndSave(SOURCE, "gamma");

        // Before the fix the edited line alone came back with the
        // serializer's four spaces, under a parent still holding a tab (four
        // columns, content at column six) — four is not deep enough, so gamma
        // stopped being beta's child and one bullet_list vanished.
        expect(reparsed).toEqual(live);
    });

    it("typing into the deepest item should keep the file's own indent bytes", async () => {
        const { merged } = await typeAndSave(SOURCE, "gamma");

        expect(merged).toBe(
            "- alpha parent\n\t- beta child\n\t   - gZamma grandchild\n\t- delta child\n",
        );
    });

    // KNOWN GAP (MAR-231). Asserted as the DESIRED outcome via `it.fails`, not
    // as the current one: a test that asserts today's wrong bytes would certify
    // the bug, which is exactly how logseqRoundTrip's old "blast radius is
    // LOCAL" assertion kept MAR-131 alive. When this starts passing, delete the
    // `.fails` — do not weaken the assertion.
    //
    // The fix learns an indent's meaning only from lines the zero-edit round
    // trip paired ONE-TO-ONE. Two neighbouring lines that share an unusual
    // indent form a single multi-line run instead, which pairs nothing, so the
    // file teaches nothing about `\t   ` and the edited line still shifts.
    it.fails("typing into one of TWO adjacent mixed-unit lines should not restructure", async () => {
        const { live, reparsed } = await typeAndSave(
            "- a\n\t- b\n\t   - c\n\t   - d\n",
            "c",
        );

        expect(reparsed).toEqual(live);
    });

    it("typing into a plain-tab item should not restructure it either", async () => {
        // The MAR-213 half of the same hazard, in the file that also holds the
        // MAR-222 half: `\t` is ambiguous nowhere here, so both rules agree.
        const { live, reparsed, merged } = await typeAndSave(SOURCE, "beta");

        expect(reparsed).toEqual(live);
        expect(merged).toContain("\t- bZeta child");
    });
});
