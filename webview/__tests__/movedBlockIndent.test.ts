/**
 * A moved block keeps the outline's own indentation (MAR-230) — driven through
 * the REAL move primitive and the REAL save pipeline, because the failure is
 * only visible on a reparse.
 *
 * This is `mixedIndentOutline.test.ts`'s twin, reached by the other merge path.
 * There, an EDITED line has a saved counterpart, so the merge can carry its
 * bytes forward (`reconcileReplacement`). A MOVED line has none: it is a pure
 * insertion, so its bytes came from the serializer verbatim — two-space indents
 * dropped between kept lines still holding tabs. A tab is four columns and two
 * spaces are two, so the file reparses with different nesting than the document
 * on screen. Unlike MAR-222 this needs no unusual indent units at all: a plain
 * tab outline, the ordinary Logseq/Obsidian shape, is enough.
 *
 * What the merge writes an insertion from is the file's own testimony in the
 * merge being performed — its `keep` pairs, each a saved line beside the bytes
 * the serializer just emitted for it (`mergeFacts` / `reconcileInsertion`).
 * That evidence is fresh by construction and, unlike round-trip protection,
 * exists even for a file that round-trips cleanly: `fixtures/logseq/journal.md`
 * gets NO protection object at all, and still broke on 4 of its 22 executable
 * moves before this change.
 *
 * Every test asserts the reparsed TREE against the live one, not the bytes the
 * fix manipulates: the nesting is what a user would lose, and the merged-bytes
 * assertions below exist only to say which spelling was chosen, never as the
 * proof that the document survived.
 */
import { describe, it, expect } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import { parserCtx } from "@milkdown/core";
import type { Node as ProseNode } from "../pm";
import { computeRoundTripProtection, applyMinimalChanges } from "../utils/minimalDiff";
import { moveBlocks } from "../editing/moveBlocks";
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
 * Move the top-level-or-nested block whose paragraph text starts with `block`
 * so that it lands at the boundary just before the block whose text starts with
 * `before`, then run the production save pipeline (serialize → protection →
 * minimal-diff merge) and reparse the bytes that would land on disk.
 */
async function moveAndSave(
    source: string,
    block: string | { from: number; to: number },
    before: string | number,
    blockType = "list_item",
    beforeType = "list_item",
) {
    const editor = await makeCorpusEditor(source);
    const v = editorView(editor);
    const protection = computeRoundTripProtection(source, editor.action(getMarkdown()));

    /** The block of type `type` whose text starts with `text`. */
    const locate = (text: string, type = "list_item"): { from: number; to: number } => {
        let found: { from: number; to: number } | null = null;
        v.state.doc.descendants((node, pos) => {
            if (found) return false;
            if (node.type.name !== type) return true;
            // An item whose content is a heading opens with an EMPTY paragraph
            // (`list_item` is `paragraph block*`), so its first child names
            // nothing — fall back to the item's own text.
            const first = type === "list_item" ? node.firstChild?.textContent : undefined;
            const body = first || node.textContent;
            if (body.startsWith(text)) {
                found = { from: pos, to: pos + node.nodeSize };
                return false;
            }
            return true;
        });
        expect(found, `no ${type} starting "${text}"`).not.toBeNull();
        return found as unknown as { from: number; to: number };
    };

    // A raw range/position is accepted for the pairs no text label can name —
    // a move to a boundary that has no block after it, which is where MAR-297's
    // reproductions live. The ticket cites those pairs numerically.
    const source_ = typeof block === "string" ? locate(block, blockType) : block;
    // "START" is the document-start boundary — the only target for a top-level
    // block, whose slots are not inside any list.
    const target =
        typeof before === "number"
            ? before
            : before === "START"
              ? 0
              : locate(before, beforeType).from;
    expect(moveBlocks(v, source_, target), "the move was refused").toBe(true);

    const merged = applyMinimalChanges(source, editor.action(getMarkdown()), protection);
    const liveDoc = v.state.doc;
    const reparsedDoc = editor.action((ctx) => ctx.get(parserCtx)(merged)) as ProseNode;
    const live = shape(liveDoc);
    const reparsed = shape(reparsedDoc);
    const liveText = liveDoc.textContent;
    const reparsedText = reparsedDoc.textContent;
    await editor.destroy();
    return { merged, live, reparsed, liveText, reparsedText };
}

describe("a moved block keeps the outline's indentation (MAR-230)", () => {
    // A plain tab outline. No mixed units anywhere — every indent is whole tabs,
    // which is precisely why this case is not MAR-222's.
    const TABS = "- alpha\n\t- beta\n\t\t- gamma\n\t- delta\n";

    it("moving a block within a tab outline should not restructure it", async () => {
        const { live, reparsed } = await moveAndSave(TABS, "delta", "beta");

        // Before the fix the inserted `- delta` arrived with the serializer's
        // two spaces beside a kept `\t- beta` (a tab is four columns), so beta
        // stopped being delta's SIBLING and became its child: the reparse
        // gained a bullet_list that the document on screen does not have.
        expect(reparsed).toEqual(live);
    });

    it("a moved line should be written with the file's own indent bytes", async () => {
        const { merged, live, reparsed } = await moveAndSave(TABS, "delta", "beta");

        expect(reparsed).toEqual(live);
        expect(merged).toBe("- alpha\n\t- delta\n\t- beta\n\t\t- gamma\n");
    });

    it("a run landing under a re-canonicalized line should not be re-based", async () => {
        // The load-bearing case for anchoring a substitution to the line above
        // it. Moving `d`'s subtree shallower makes `  - d` an in-place
        // REPLACEMENT whose depth genuinely moved, so the serializer's
        // canonical two spaces correctly win there. Re-basing the inserted `e`
        // beneath it onto the file's tabs — which the file really does use, at
        // that depth, everywhere else — puts a child eight columns under a
        // parent whose content indent is four: `e` stops being a list item and
        // survives only as literal text glued into d's paragraph.
        //
        // Found by adversarially probing the first cut of this fix, which
        // introduced this loss while removing others. A file-wide fact answers
        // "how does this document spell that depth", never "is the neighbour
        // above spelled that way".
        const source = `- a\n\t- b\n\t\t- c\n\t\t\t- d\n\t\t\t\t- e\n\t- z\n`;
        const { live, reparsed, liveText, reparsedText } = await moveAndSave(source, "d", "z");

        expect(reparsedText).toEqual(liveText);
        expect(reparsed).toEqual(live);
    });

    it("a moved block in a CRLF outline should not mix line endings", async () => {
        // The engine owns line endings and the profile never sees one, so a
        // re-based insertion must still come back with the document's ending.
        const source = "- alpha\r\n\t- beta\r\n\t\t- gamma\r\n\t- delta\r\n";
        const { merged, live, reparsed } = await moveAndSave(source, "delta", "beta");

        expect(reparsed).toEqual(live);
        expect(merged).toBe("- alpha\r\n\t- delta\r\n\t- beta\r\n\t\t- gamma\r\n");
        expect(merged.split("\r\n").join("")).not.toContain("\n");
    });

    it("a move that CHANGES a block's depth should still use the file's indent", async () => {
        // delta descends a level, so its line is not merely relocated — the
        // serializer renders it at a canonical depth the saved file never
        // spelled for it. The spelling still has to come from the file, which
        // writes that depth as two tabs.
        const { live, reparsed, merged } = await moveAndSave(TABS, "delta", "gamma");

        expect(reparsed).toEqual(live);
        expect(merged).toContain("\t\t- delta");
    });

    it("a moved item's continuation lines should move with its marker", async () => {
        // The marker line and the lines that continue the item meet at the same
        // canonical width one level apart (`\t\t-` against `\t  `), so a merge
        // that files both spellings under the width alone learns nothing and
        // respells neither. Tearing the two apart is not a cosmetic error: the
        // marker moves to a tab, its content stays at the serializer's columns,
        // and the content stops belonging to the item.
        const source = "- alpha\n\t- beta\n\t  continued beta text\n\t- gamma\n\t- delta\n";
        const { live, reparsed, merged } = await moveAndSave(source, "beta", "delta");

        expect(reparsed).toEqual(live);
        expect(merged).toContain("\t  continued beta text");
    });

    it("a moved item containing a fence should keep the fence's contents", async () => {
        // Verbatim lines must ride along with the construct that opened above
        // them rather than resolve an indent of their own. Resolving them
        // independently moved a nested fence while leaving its body behind, and
        // the body reparsed as an indented code block with the fence gone —
        // corruption produced by an earlier cut of this very fix.
        const source =
            "- alpha\n\t- beta\n\t  ```js\n\t  const x = 1;\n\t    indented();\n\t  ```\n\t- gamma\n\t- delta\n";
        const { live, reparsed, merged } = await moveAndSave(source, "beta", "delta");

        expect(reparsed).toEqual(live);
        // The body keeps its own two-space offset INSIDE the fence: re-basing
        // substitutes the indent it matched and nothing more.
        expect(merged).toContain("\t    indented();");
    });

    it("a marker and a continuation at the same width should not cancel out", async () => {
        // The load-bearing case for keeping the two indent ROLES apart. Here a
        // depth-2 marker (`\t\t-`) and a depth-1 continuation (`\t  `) are both
        // rendered by the serializer at four columns, so filing spellings under
        // the width alone sees four columns meaning two different things,
        // calls it ambiguous, and learns NOTHING — leaving the moved line at
        // the serializer's four columns beside a parent whose tab is four,
        // where it is a sibling rather than a child.
        //
        // Every other document here has only one construct per width, which is
        // why they cannot see this: they pass with the roles merged.
        const source =
            "- alpha\n\t- beta\n\t  continued beta\n\t- gamma\n\t\t- deep\n\t- delta\n";
        const { live, reparsed, merged } = await moveAndSave(source, "delta", "deep");

        expect(reparsed).toEqual(live);
        expect(merged).toContain("\t\t- delta");
    });

    it("moving a top-level fence should not re-indent its body", async () => {
        // Guards the exclusion of verbatim lines from the lookup. Inside a fence
        // the leading whitespace is the user's CONTENT, and the outline above
        // teaches that four columns are written `\t  ` — so a body line that
        // resolved an indent of its own would have its code silently
        // re-indented. It may only ever ride along with its fence.
        //
        // Note what this test does and does not prove: it passes with the whole
        // fix reverted (nothing is re-based at all then), so it is not evidence
        // of the bug being fixed. It is a mutation guard — delete the `\x00`
        // check in `reconcileInsertion` and it is the test that goes red.
        const source =
            "- alpha\n\t- beta\n\t  continued beta\n\t- gamma\n\n```text\n    four-space code line\n```\n\n- delta\n";
        const { liveText, reparsedText, merged } = await moveAndSave(
            source,
            "    four-space",
            "START",
            "code_block",
        );

        expect(reparsedText).toEqual(liveText);
        expect(merged).toContain("\n    four-space code line\n");
    });

    it("moving a fence item to the top of a tab outline should not re-nest its siblings", async () => {
        // The MAR-230 follow-up, and a regression this file's own fix caused.
        //
        // Putting an item's content on the marker line means a fence can now
        // OPEN there (`- ```js`) — legal CommonMark, but a shape the serializer
        // never emitted before. `classifyLines` tested its fence regex against
        // the trimStart'd line, so the opener was invisible; the scanner then
        // read the fence's own CLOSING line as an opener and classified every
        // line below it as fence content. `reconcileInsertion` skips a lookup
        // for verbatim lines, so the inserted `- one` kept the serializer's two
        // spaces beside a kept `\t- plain`, and `plain` came back as `one`'s
        // CHILD. Measured over every enumerable move of this shape: 3 losses in
        // 12 executable moves, against 2 before MAR-230 — the one pair the fix
        // made worse.
        const source = "- root\n\t- one\n\t- ```js\n\t  x\n\t  ```\n\t- plain\n";
        const { live, reparsed, merged } = await moveAndSave(source, "x", "root");

        expect(reparsed).toEqual(live);
        expect(merged).toContain("\t- one");
    });

    // Was the boundary of this fix, pinned as `it.fails`; closed by dropping the
    // schema-artifact empty paragraph at serialization (plugins/list.ts →
    // `itemContentForMarkdown`), which is what put the heading back on the
    // marker line and left the construct with nothing to misparse.
    //
    // The `it.fails` it replaces was VACUOUS, and worth naming: it moved `beta`
    // to the boundary just before `delta` — the two are already adjacent, so
    // `moveBlocks` correctly refused, and the test "failed" on its own
    // `expect(moved).toBe(true)` guard without ever reaching a save. It read as
    // a live pin on the heading construct for as long as it existed. The move
    // below is a real one: the heading item travels past a sibling.
    it("moving an item whose content is a heading should not restructure it", async () => {
        const source = "- alpha\n\t- beta\n\t- # Heading item\n\t- delta\n";
        const { live, reparsed, merged } = await moveAndSave(source, "Heading item", "beta");

        // Before the fix this wrote a bare `\t-` with `\t  # Heading item`
        // beneath it, and the reparse kept `# Heading item` only as the TEXT of
        // an indented code block.
        expect(reparsed).toEqual(live);
        expect(merged).toContain("\t- # Heading item");
    });

    it("a moved item whose content is a table should keep the table (MAR-241)", async () => {
        // The same family as the fence case above, reached the other way. A
        // table is several source lines, and its rows key WITHOUT their indent
        // (`normalizeSepRow` / `normalizeTableDataRow` both trim), so a row at
        // depth 1 keyed equal to the same row at depth 0. The merge called that
        // a `keep` and emitted the saved bytes verbatim — carrying `\t  `, the
        // indent of the nesting the item had just left — while the marker line
        // moved to column 0. Six columns of leading space under a top-level
        // item is not the table's continuation, so every table node was lost
        // and the user got three lines of literal pipe text.
        //
        // Note it is the SAVED indent that lands, not the serializer's: the
        // merged bytes carried the saved `| --- | --- |` spelling, which only a
        // keep can produce. That is what identifies the layer.
        const source = "- root\n\t- | a | b |\n\t  | --- | --- |\n\t  | 1 | 2 |\n\t- plain\n";
        const { live, reparsed, merged } = await moveAndSave(source, "ab", "root");

        expect(reparsed).toEqual(live);
        // The rows re-base to the moved item's new depth...
        expect(merged).toContain("\n  |---|---|\n");
        // ...and the outline the move did NOT touch keeps its tab.
        expect(merged).toContain("\t- plain");
    });

    // ── MAR-297: the anchor gate's two false negatives ──────────────────────
    //
    // Both are `reconcileInsertion` refusing a re-spelling it should have made,
    // and both cost the same thing: the inserted marker line keeps the
    // serializer's two spaces beside a KEPT line still holding the file's tab,
    // so the kept line reparses as the inserted one's child and the document
    // gains a `bullet_list`. The table survives in both — this is MAR-241's
    // residual, not MAR-241.
    //
    // The ticket blamed `baselineIndents` "learning one canonical rendering per
    // source indent and dropping ambiguous ones". Measured, nothing is dropped:
    // for the first case below `mergeIndents` distils
    // `{"m": "", "m  ": "\t", "c    ": "\t  "}` and `baselineIndents`
    // `{"": "", "\t": "  ", "\t  ": "    ", "    ": "  "}` — the facts are all
    // present and consistent. What fails is the anchor's PREFIX test, which is
    // a byte comparison standing in for "the same convention".

    it("a bullet moved past a 4-space branch in a tab outline should not re-nest", async () => {
        // Reproduction A. `    - four space` and `\t- plain` are siblings the
        // file spells two different ways, and `baselineIndents` records both
        // rendering to the same canonical `"  "` — so they are one depth, not
        // two.
        //
        // The 4-space line reaches the merge wearing its SAVED bytes: the
        // baseline round trip re-spells it, so it becomes a protected region
        // and `repairSerialized` splices the saved bytes back in BEFORE the
        // diff. It then anchors the run at `"    "`, against which `plain`'s
        // correct `"\t"` is neither a prefix nor a continuation — vetoed, left
        // at two columns, and the kept `\t- | a | b |` below became its child.
        //
        // Pinned line: the `rendered?.get(anchor) === sub.canonical` grant in
        // `reconcileInsertion`. Delete it and this test is the one that reddens.
        const source =
            "- root\n\t- | a | b |\n\t  | --- | --- |\n\t  | 1 | 2 |\n    - four space\n\t- plain\n";
        const { live, reparsed, merged, liveText, reparsedText } = await moveAndSave(
            source,
            { from: 9, to: 39 },
            62,
        );

        expect(reparsedText).toEqual(liveText);
        expect(reparsed).toEqual(live);
        // The siblings end up at one depth. `four space` keeps the spelling the
        // file gave it; `plain` takes the tab the file uses at that depth. The
        // leading newline is load-bearing: `"\t- plain"` alone is also a
        // substring of `"\t\t- plain"`, so it would pass at the wrong depth.
        expect(merged).toContain("\n\t- plain");
    });

    it("a bullet moved under a table row should not anchor on the row's continuation", async () => {
        // The second false negative, and one the ticket does not describe. No
        // protection is involved at all here (the file round-trips to null), so
        // it is reached by a different route than the case above.
        //
        // The run lands under `\t  | 1 | 2 |` — a table row, which is a
        // CONTINUATION line, spelled `\t` + two spaces. The moved marker
        // resolves to `\t\t`. Both are the same tab convention, but a marker
        // spelling and a continuation spelling are never prefixes of each
        // other, so the gate compared the two ROLES and refused. `plain` stayed
        // at four columns where the file writes eight, and the kept
        // `\t\t- | c | d |` below it became its child.
        //
        // Pinned line: the `spelled.has(anchor)` grant. Delete it and this test
        // reddens while the one above stays green — they are independent.
        const source =
            "- root\n\t- | a | b |\n\t  | --- | --- |\n\t  | 1 | 2 |\n\t\t- | c | d |\n\t\t  | --- | --- |\n\t\t  | 3 | 4 |\n\t- plain\n";
        const { live, reparsed, merged, liveText, reparsedText } = await moveAndSave(
            source,
            { from: 71, to: 80 },
            39,
        );

        expect(reparsedText).toEqual(liveText);
        expect(reparsed).toEqual(live);
        expect(merged).toContain("\n\t\t- plain");
    });

    // ── MAR-299: the REPLACEMENT path's version of the same loss ────────────
    //
    // Everything above is `reconcileInsertion` — a moved line with no saved
    // counterpart. But a move that only changes an item's DEPTH leaves its text
    // untouched, so the diff pairs the line with itself and the merge takes the
    // in-place replacement branch instead. There `carrySavedIndent` returned
    // early when the leading whitespace was the only difference (the whitespace
    // is then the edit, and carrying the saved bytes back was MAR-161's data
    // loss) — and "don't carry the saved indent" was writing the SERIALIZER's,
    // which in a tab outline is two columns where four were meant.
    //
    // Both moves below are given as raw pairs from the enumeration rather than
    // named blocks: the target is a boundary with no block after it, which no
    // text label can name.

    it("outdenting an item by a move should keep the outline's own tab (MAR-299)", async () => {
        // The flagship shape, and what says this is not an exotic-document bug:
        // TABS is a plain tab outline with no mixed units anywhere, and it loses
        // 1 of its 13 executable moves. `gamma` outdents to sit beside `beta`;
        // before the fix its line was written `  - gamma` beside a kept
        // `\t- delta`, so delta reparsed as gamma's CHILD.
        //
        // Pinned line: the `respellMovedIndent` call in `carrySavedIndent`.
        // Restore the bare `return serial` there and this test reddens.
        const { live, reparsed, merged } = await moveAndSave(TABS, { from: 18, to: 27 }, 29);

        expect(reparsed).toEqual(live);
        expect(merged).toBe("- alpha\n\t- beta\n\t- gamma\n\t- delta\n");
    });

    it("the same move in a four-space outline should keep four spaces (MAR-299)", async () => {
        // The other arm. Here the file's unit is WIDER than the serializer's, so
        // no prefix of the saved `        ` renders to the serializer's `  `
        // except `  ` itself — the line's own bytes cannot answer, and the
        // spelling comes from the baseline round trip read backwards instead.
        //
        // Pinned line: the `sourceSpellingOf` lookup in `respellMovedIndent`.
        // Delete that block and this test reddens while the tab one above stays
        // green — the two arms are independent.
        const source = "- alpha\n    - beta\n        - gamma\n    - delta\n";
        const { live, reparsed, merged } = await moveAndSave(source, { from: 18, to: 27 }, 29);

        expect(reparsed).toEqual(live);
        expect(merged).toBe("- alpha\n    - beta\n    - gamma\n    - delta\n");
    });

    // ── MAR-328: the same loss reached through ROUND-TRIP PROTECTION ────────
    //
    // A file whose outline is spelled wider than the serializer writes it makes
    // every one of its outline lines a round-trip difference, so protection
    // records each as a region and the repair pass puts the saved bytes back
    // before the diff ever runs. That is right while the document's shape holds
    // and wrong the moment a block moves: a region matches on its own interior
    // neighbours, which a block carries with it, so the moved lines come back
    // wearing the spelling of the depth they LEFT, beside a new parent the merge
    // wrote canonically. The merge's own indent rules never see them — those
    // answer per line and in context, which is exactly what a repair does not
    // do.
    //
    // Neither test below is a spelling preference. Each asserts the reparsed
    // tree, because what a user loses here is nesting: the sublist stops being a
    // list and comes back as hardbreak-joined paragraph text.
    //
    // Both halves are scoped to a merge that RELOCATED content. Every pin above
    // this block and in mixedIndentOutline.test.ts is an ordinary edit, and they
    // are what says the scoping holds: a repair keeping a neighbour's saved
    // bytes intact across an edit (MAR-231) has to go on doing that.

    const FOUR_SPACE = "- alpha\n    - beta\n        - gamma\n    - delta\n";

    it("a moved sublist should not be respelled to the depth it left (MAR-328)", async () => {
        // `delta` moves in beside `gamma`, so `gamma` is a pure insertion at a
        // new position while its saved bytes are what the repair hands over.
        //
        // The bytes here are the SERIALIZER's own, not the file's spelling: with
        // the outline unprotected the merge's output self-check finally has a
        // reference that does not carry the same defect (with a region for every
        // outline line, the repaired text and the merged text were wrong in the
        // same way and the roles agreed), so it sees the divergence and stands
        // the save down. Churn, borne once, in place of a sublist that stopped
        // being a list. Whether the save degrades is not the assertion — the
        // reparsed tree is.
        //
        // Pinned line: the `hadRelocatedContent && ... reindentOnly` retry in
        // `applyMinimalChanges`. Delete it and this test reddens while the
        // MAR-299 pairs above stay green.
        const { live, reparsed, merged } = await moveAndSave(FOUR_SPACE, { from: 29, to: 38 }, 18);

        expect(reparsed).toEqual(live);
        expect(merged).toBe("- alpha\n  - beta\n    - delta\n    - gamma\n");
    });

    it("a moved item whose marker the edit rewrote should keep the file's indent (MAR-328)", async () => {
        // The replacement path's half. `gamma` outdents to the top level, which
        // changes its bullet character as well as its depth, so its saved and
        // serialized bodies differ and rule 3's identical-body branch is not the
        // one reached. Writing the serializer's canonical indent there leaves a
        // two-space line among four-space siblings.
        //
        // Pinned line: the `respellMovedIndent` call at the END of
        // `carrySavedIndent`. Restore the bare `return serial` and this reddens
        // while the test above stays green.
        const { live, reparsed, merged } = await moveAndSave(FOUR_SPACE, { from: 18, to: 27 }, 10);

        expect(reparsed).toEqual(live);
        expect(merged).toBe("- alpha\n    - gamma\n    - beta\n    - delta\n");
    });

    it("a heading item nested under a sibling should round-trip with no move at all", async () => {
        // The same defect without any move: the serializer's own canonical
        // output for this shape does not survive its own reparse, because a
        // bare `-` under a paragraph line is a setext heading underline. No
        // tabs, no mixed units, no insertion path — which is why this is the
        // test that would have caught the construct first.
        const source = "- normal\n  - # H\n    body\n";
        const editor = await makeCorpusEditor(source);
        const serialized = editor.action(getMarkdown());
        const reparsed = editor.action((ctx) => ctx.get(parserCtx)(serialized)) as ProseNode;

        // `normal` came back as a heading, and the nested item was gone.
        expect(shape(reparsed)).toEqual(shape(editorView(editor).state.doc));
        expect(serialized).toBe(source);
        await editor.destroy();
    });
});
