/**
 * MAR-343: the save pipeline's last gate (webview/utils/verifiedMerge.ts).
 *
 * Three branches, and the third is the one that keeps the fix honest: a
 * document whose round trip is ALREADY dirty must not degrade to canonical
 * bytes, or every save of such a file silently discards the user's own
 * spelling forever. That is a worse bug than the one being fixed, and nothing
 * else in the suite would notice it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parserCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { applyMinimalChanges, serializerFallback } from "@birta/minimal-diff";
import type { Node as ProseNode } from "../pm";
import {
    contentGuardPlugin,
    diffFingerprints,
    fingerprintDoc,
    formatFingerprintDiff,
} from "../plugins/contentGuard";
import { moveBlocks } from "../editing/moveBlocks";
import { markdownProfile, computeRoundTripProtection } from "../utils/minimalDiff";
import { mergeVerified } from "../utils/verifiedMerge";
import { editorView, enumerateMovePairs, makeCorpusEditor } from "./helpers/moveFuzz";

vi.mock("../editing/rangeIndicator", () => ({
    flashRange: vi.fn(),
    showRangeVeil: vi.fn(),
    hideRangeVeil: vi.fn(),
}));

let editors: Editor[] = [];
afterEach(async () => {
    for (const e of editors) await e.destroy();
    editors = [];
    document.body.innerHTML = "";
});

async function makeEditor(markdown: string): Promise<Editor> {
    const editor = await makeCorpusEditor(markdown, [contentGuardPlugin]);
    editors.push(editor);
    return editor;
}

const parseWith =
    (editor: Editor) =>
    (text: string): ProseNode | null =>
        editor.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode | null;

/** Does `text` reopen holding exactly the live document's content? */
function reopensClean(editor: Editor, live: ProseNode, text: string): boolean {
    const doc = parseWith(editor)(text)!;
    return (
        formatFingerprintDiff(diffFingerprints(fingerprintDoc(live), fingerprintDoc(doc))) ===
        "lost: (none); gained: (none)"
    );
}

/** The four-space outline whose merge damage MAR-343 owns, at the SHALLOWEST
 *  depth that reproduces it — three levels, an entirely ordinary document. */
const FOUR_SPACE_DEPTH_3 = [
    "# Depth probe",
    "",
    "Intro prose so the outline is not the first block.",
    "",
    "- level 1",
    "    - level 2",
    "        - level 3",
    "",
    "Trailing prose, so the document does not end inside a construct.",
].join("\n");

describe("mergeVerified", () => {
    it("a merge that reopens cleanly should be returned untouched", async () => {
        const saved = "# Title\n\nOne paragraph.\n\n- a\n- b\n";
        const editor = await makeEditor(saved);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(saved, editor.action(getMarkdown()));
        // An ordinary edit: retype the paragraph.
        const para = v.state.doc.child(1);
        const at = v.state.doc.resolve(0).posAtIndex(1);
        v.dispatch(v.state.tr.insertText(" Edited.", at + para.nodeSize - 1));

        const serialized = editor.action(getMarkdown());
        const out = mergeVerified(
            saved,
            serialized,
            markdownProfile,
            protection,
            v.state.doc,
            parseWith(editor),
        );

        expect(out).toBe(applyMinimalChanges(saved, serialized, markdownProfile, protection));
        expect(out).toContain("Edited.");
        // The saved file's own spelling survived — this is the merge doing its job.
        expect(out).toContain("- a");
        expect(reopensClean(editor, v.state.doc, out)).toBe(true);
    });

    it("a merge that damages content the serializer carried should fall back to the serializer", async () => {
        const editor = await makeEditor(FOUR_SPACE_DEPTH_3);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(
            FOUR_SPACE_DEPTH_3,
            editor.action(getMarkdown()),
        );
        const baseState = v.state;

        // The gesture: the intro paragraph dropped into the outline. Found by
        // sweep rather than addressed positionally — a raw offset cannot assert
        // its own identity, and this fixture's damaged pairs are exactly the
        // ones where the merged bytes and the serializer's disagree.
        let found = false;
        for (const { source, target } of enumerateMovePairs(v)) {
            if (!moveBlocks(v, { from: source.from, to: source.to }, target)) {
                v.updateState(baseState);
                continue;
            }
            const serialized = editor.action(getMarkdown());
            const merged = applyMinimalChanges(
                FOUR_SPACE_DEPTH_3,
                serialized,
                markdownProfile,
                protection,
            );
            if (!reopensClean(editor, v.state.doc, merged)) {
                found = true;
                // The premise: the serializer alone is CLEAN here, so the
                // damage is the merge's own and there is something better to
                // write. If this ever fails the bug has moved upstream.
                expect(
                    reopensClean(editor, v.state.doc, serialized),
                    "the serializer's own output should be clean for this pair",
                ).toBe(true);

                const out = mergeVerified(
                    FOUR_SPACE_DEPTH_3,
                    serialized,
                    markdownProfile,
                    protection,
                    v.state.doc,
                    parseWith(editor),
                );
                expect(out).not.toBe(merged);
                expect(out).toBe(serialized);
                expect(reopensClean(editor, v.state.doc, out)).toBe(true);
                v.updateState(baseState);
                break;
            }
            v.updateState(baseState);
        }
        expect(found, "no damaged pair in the depth-3 four-space outline").toBe(true);
    });

    it("an already-broken document should keep the merge rather than churn to canonical bytes", async () => {
        // A document whose round trip is dirty BEFORE any merge: raw `:::`
        // prose above a closed directive re-pairs the fences on reparse
        // (hazard B, corpusMoveSampling). The user typed it; no gesture caused
        // it, and no save can fix it.
        //
        // The DOUBLE blank line is load-bearing, not scenery. The serializer
        // emits one blank between blocks; the merge keeps the file's own
        // spacing, so its output DIFFERS from the fallback. Without some such
        // difference the two candidates are byte-identical, "keep the merge"
        // and "take the fallback" agree, and this test passes whatever the
        // code does — which is exactly how it read on its first cut, with `+`
        // bullets that the serializer turned out to preserve anyway.
        const saved = "Some prose.\n\n\nMore prose.\n\n:::caution\nBody.\n:::\n\nLast.\n";
        const editor = await makeEditor(saved);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(saved, editor.action(getMarkdown()));
        const para = v.state.schema.nodes["paragraph"]!.create(
            null,
            v.state.schema.text(":::unclosed"),
        );
        v.dispatch(v.state.tr.insert(0, para));

        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(saved, serialized, markdownProfile, protection);
        const fallback = serializerFallback(saved, serialized);
        // Three premises, all asserted because the branch under test is
        // unreachable without them.
        expect(merged, "the merge must differ from the fallback").not.toBe(fallback);
        expect(reopensClean(editor, v.state.doc, serialized)).toBe(false);
        expect(reopensClean(editor, v.state.doc, merged)).toBe(false);

        const out = mergeVerified(
            saved,
            serialized,
            markdownProfile,
            protection,
            v.state.doc,
            parseWith(editor),
        );
        // The merge is kept: degrading here would discard the file's own
        // spelling on every save of a file that can never verify clean.
        expect(out).toBe(merged);
        expect(out, "the file's own blank-line spacing survives").toContain("prose.\n\n\nMore");
    });

    it("a parser that throws should not propagate out of the save path", async () => {
        const editor = await makeEditor(FOUR_SPACE_DEPTH_3);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(
            FOUR_SPACE_DEPTH_3,
            editor.action(getMarkdown()),
        );
        const serialized = editor.action(getMarkdown());
        expect(() =>
            mergeVerified(
                FOUR_SPACE_DEPTH_3,
                serialized,
                markdownProfile,
                protection,
                v.state.doc,
                () => {
                    throw new Error("parser exploded");
                },
            ),
        ).not.toThrow();
    });
});
