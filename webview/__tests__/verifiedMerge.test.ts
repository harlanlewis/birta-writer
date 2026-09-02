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
import { parserCtx, serializerCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { applyMinimalChanges, serializerFallback } from "@birta/minimal-diff";
import type { Node as ProseNode } from "../pm";
import { contentGuardPlugin } from "../plugins/contentGuard";
import { diffFingerprints, fingerprintDoc, formatFingerprintDiff } from "../plugins/fingerprints";
import { moveBlocks } from "../editing/moveBlocks";
import { markdownProfile, computeRoundTripProtection } from "../utils/minimalDiff";
import { mergeVerified, mergeVerifiedWith, reopensAs, type VerifiedMerge } from "../utils/verifiedMerge";
import { editorView, enumerateMovePairs, loadCorpusFixtures, makeCorpusEditor } from "./helpers/moveFuzz";

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
        const { text: out, canonical } = mergeVerified(
            saved,
            serialized,
            markdownProfile,
            protection,
            v.state.doc,
            parseWith(editor),
        );

        expect(out).toBe(applyMinimalChanges(saved, serialized, markdownProfile, protection));
        // Canonical, and legitimately so: this saved file is already the
        // serializer's own spelling, so the merge output and the fallback are
        // the same bytes. Dropping protection on that is a no-op — a canonical
        // file has none — which is why the flag can afford to be this broad.
        expect(canonical).toBe(true);
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

                const { text: out, canonical } = mergeVerified(
                    FOUR_SPACE_DEPTH_3,
                    serialized,
                    markdownProfile,
                    protection,
                    v.state.doc,
                    parseWith(editor),
                );
                expect(out).not.toBe(merged);
                expect(out).toBe(serialized);
                expect(canonical, "the caller must be told its baseline was replaced").toBe(true);
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

        const { text: out, canonical } = mergeVerified(
            saved,
            serialized,
            markdownProfile,
            protection,
            v.state.doc,
            parseWith(editor),
        );
        expect(canonical, "the file's own spelling was kept, so this is not canonical").toBe(
            false,
        );
        // The merge is kept: degrading here would discard the file's own
        // spelling on every save of a file that can never verify clean.
        expect(out).toBe(merged);
        expect(out, "the file's own blank-line spacing survives").toContain("prose.\n\n\nMore");
    });

    it("a merge the ENGINE already stood down should still be reported as a fallback", async () => {
        // MAR-344. `applyMinimalChanges` writes the serializer's own text
        // whenever its output self-check trips, without consulting this
        // function at all, and a corpus sweep found that road far better
        // travelled than this one's own fallback. Both leave the caller's
        // round-trip protection describing a baseline that no longer exists, so
        // both must be reported: the early return is not only an optimization.
        //
        // An empty saved file is the cheap way to reach it: there is nothing to
        // preserve, so the merge IS the serializer's text and the verifier
        // returns before it parses anything.
        const editor = await makeEditor("");
        const v = editorView(editor);
        v.dispatch(v.state.tr.insertText("Typed into a new file."));
        const serialized = editor.action(getMarkdown());
        expect(
            applyMinimalChanges("", serialized, markdownProfile, null),
            "premise: the engine returns its own fallback here",
        ).toBe(serializerFallback("", serialized));

        const { text, canonical } = mergeVerified(
            "",
            serialized,
            markdownProfile,
            null,
            v.state.doc,
            parseWith(editor),
        );
        expect(text).toBe(serializerFallback("", serialized));
        expect(canonical).toBe(true);
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

/**
 * MAR-430: the same decision with its reparse run elsewhere. The two forms
 * share `candidates` and nothing else, so this holds them together where
 * they could drift: every corpus fixture through a real edit, and the one
 * merge the corpus is known to damage, both with an oracle that is the
 * synchronous check awaited.
 */
describe("mergeVerifiedWith decides as mergeVerified", () => {
    /** The synchronous check, awaited, counting how often it was consulted. */
    function countingOracle(editor: Editor): { reopens: (fp: ReadonlyMap<string, number>, text: string) => Promise<boolean>; asked: () => number } {
        let asked = 0;
        const parse = parseWith(editor);
        return {
            reopens: async (fp, text) => {
                asked++;
                return reopensAs(fp, text, parse);
            },
            asked: () => asked,
        };
    }

    it("over the corpus, through a real edit, both forms should return the same bytes and the same verdict", async () => {
        const editor = await makeEditor("");
        const parse = parseWith(editor);
        const serialize = (doc: ProseNode): string => editor.action((ctx) => ctx.get(serializerCtx)(doc));
        const oracle = countingOracle(editor);
        const disagreements: string[] = [];
        let compared = 0;
        for (const f of loadCorpusFixtures()) {
            const opened = parse(f.content)!;
            const protection = computeRoundTripProtection(f.content, serialize(opened));
            // The edit: a paragraph appended to the document as the user sees it.
            const live = parse(`${serialize(opened)}\nAppended by the test.\n`)!;
            const serialized = serialize(live);
            const sync = mergeVerified(f.content, serialized, markdownProfile, protection, live, parse);
            const off: VerifiedMerge = await mergeVerifiedWith(
                f.content,
                serialized,
                markdownProfile,
                protection,
                () => fingerprintDoc(live),
                oracle.reopens,
            );
            compared++;
            if (sync.text !== off.text || sync.canonical !== off.canonical) disagreements.push(f.name);
        }
        expect(disagreements).toEqual([]);
        expect(compared).toBeGreaterThan(20);
        // The oracle was consulted, so the agreement is not the short-circuit
        // agreeing with itself over a corpus the serializer spells canonically.
        expect(oracle.asked()).toBeGreaterThan(0);
    }, 120_000);

    it("on the merge the corpus is known to damage, both forms should choose the serializer's bytes", async () => {
        const editor = await makeEditor(FOUR_SPACE_DEPTH_3);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(FOUR_SPACE_DEPTH_3, editor.action(getMarkdown()));
        const baseState = v.state;
        let found = false;
        for (const { source, target } of enumerateMovePairs(v)) {
            if (!moveBlocks(v, { from: source.from, to: source.to }, target)) {
                v.updateState(baseState);
                continue;
            }
            const serialized = editor.action(getMarkdown());
            const merged = applyMinimalChanges(FOUR_SPACE_DEPTH_3, serialized, markdownProfile, protection);
            if (!reopensClean(editor, v.state.doc, merged)) {
                found = true;
                const live = v.state.doc;
                const oracle = countingOracle(editor);
                const sync = mergeVerified(FOUR_SPACE_DEPTH_3, serialized, markdownProfile, protection, live, parseWith(editor));
                const off = await mergeVerifiedWith(
                    FOUR_SPACE_DEPTH_3,
                    serialized,
                    markdownProfile,
                    protection,
                    () => fingerprintDoc(live),
                    oracle.reopens,
                );
                expect(off).toEqual(sync);
                expect(off.text).toBe(serialized);
                expect(off.canonical).toBe(true);
                // Both questions were asked: the merge's, answered no, then the fallback's.
                expect(oracle.asked()).toBe(2);
                v.updateState(baseState);
                break;
            }
            v.updateState(baseState);
        }
        expect(found, "no damaged pair in the depth-3 four-space outline").toBe(true);
    });
});
