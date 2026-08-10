/**
 * MAR-343: no reachable move may damage a four-space outline on save.
 *
 * A four-space-per-level outline is what Notion and several Obsidian setups
 * export, and the editor's serializer writes two, so every save of such a file
 * runs the round-trip repair that this bug lives in. The damage is silent —
 * nothing on screen, nothing in the file until it is reopened and a sublist has
 * become one run-together paragraph, or an indented code block.
 *
 * DEPTH IS THE VARIABLE, and settling it is what this ticket was opened to do.
 * The ticket's census found damage only in a fixture written to be hostile
 * (eight levels, colliding with a mermaid fence and an indented code block) and
 * reasoned that "if it needs level 7, reach really is small". It does not: the
 * ladder below reproduces at THREE levels, in a document holding nothing but a
 * heading, two paragraphs and an outline. The colliding constructs multiply the
 * count of damaged pairs (they add drop targets) but are not necessary for any
 * of it.
 *
 * Each depth asserts BOTH halves, which is what keeps the test from going quiet
 * if the bug moves: the unverified merge must still damage this document (or
 * the case has stopped being a reproduction and the fixture needs rebuilding),
 * and the verified merge must not.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parserCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { applyMinimalChanges } from "@birta/minimal-diff";
import type { Node as ProseNode } from "../pm";
import { Slice, TextSelection } from "../pm";
import {
    contentGuardPlugin,
    diffFingerprints,
    fingerprintDoc,
    formatFingerprintDiff,
} from "../plugins/contentGuard";
import { moveBlocks } from "../editing/moveBlocks";
import { markdownProfile, computeRoundTripProtection } from "../utils/minimalDiff";
import { mergeVerified } from "../utils/verifiedMerge";
import {
    editorView,
    enumerateMovePairs,
    hashString,
    loadCorpusFixtures,
    makeCorpusEditor,
    mulberry32,
    shuffled,
} from "./helpers/moveFuzz";

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

const CLEAN = "lost: (none); gained: (none)";

/** A four-space-per-level outline `depth` levels deep, in an ordinary document. */
function fourSpaceOutline(depth: number): string {
    const levels = Array.from(
        { length: depth },
        (_, d) => `${" ".repeat(4 * d)}- level ${d + 1}`,
    );
    return [
        "# Depth probe",
        "",
        "Intro prose so the outline is not the first block.",
        "",
        ...levels,
        "",
        "Trailing prose, so the document does not end inside a construct.",
    ].join("\n");
}

/**
 * Counts are all scoped to gestures the SERIALIZER handled cleanly, because
 * that is the whole of what this fix owns. A gesture whose serializer output is
 * already dirty is damaged before any merge runs; falling back would write
 * equally broken bytes while discarding the file's own spelling, so
 * `mergeVerified` deliberately keeps the merge there. Counting those as
 * failures would demand the save fix documents that no save can fix.
 */
interface Sweep {
    executed: number;
    /** Gestures the serializer alone round-trips cleanly. */
    serializerClean: number;
    /** Of those, how many the plain merge damages — the bug, and this test's
     *  own liveness check. */
    rawDamaged: number;
    /** Of those, how many still ship damaged. Must be zero. */
    verifiedDamaged: number;
}

/**
 * Execute every (source, target) pair the drag UI could express, and count the
 * saves that would reopen holding different content — once through the plain
 * merge, once through the verified one.
 */
async function sweep(source: string, cap = Infinity): Promise<Sweep> {
    const editor = await makeCorpusEditor(source, [contentGuardPlugin]);
    editors.push(editor);
    const v = editorView(editor);
    const protection = computeRoundTripProtection(source, editor.action(getMarkdown()));
    const parse = (text: string): ProseNode | null =>
        editor.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode | null;
    const baseState = v.state;
    const out: Sweep = { executed: 0, serializerClean: 0, rawDamaged: 0, verifiedDamaged: 0 };

    // The ladder documents are small enough to sweep whole; the corpus fixture
    // is not, so it draws a seeded sample. The seed is FIXED for the same
    // reason corpusMoveSampling's is (a rotating seed reddens whichever PR
    // happens to draw a pre-existing bug); the nightly explores the rest.
    const all = enumerateMovePairs(v);
    const pairs = Number.isFinite(cap)
        ? shuffled(all, mulberry32((20260809 ^ hashString(source.slice(0, 64))) >>> 0)).slice(0, cap)
        : all;
    for (const { source: src, target } of pairs) {
        if (!moveBlocks(v, { from: src.from, to: src.to }, target)) {
            v.updateState(baseState);
            continue;
        }
        out.executed++;
        const serialized = editor.action(getMarkdown());
        const live = v.state.doc;
        const reopensDirty = (text: string): boolean =>
            formatFingerprintDiff(
                diffFingerprints(fingerprintDoc(live), fingerprintDoc(parse(text)!)),
            ) !== CLEAN;

        if (!reopensDirty(serialized)) {
            out.serializerClean++;
            if (reopensDirty(applyMinimalChanges(source, serialized, markdownProfile, protection))) {
                out.rawDamaged++;
            }
            if (
                reopensDirty(
                    mergeVerified(source, serialized, markdownProfile, protection, live, parse)
                        .text,
                )
            ) {
                out.verifiedDamaged++;
            }
        }
        v.updateState(baseState);
    }
    return out;
}

describe("four-space outline moves (MAR-343)", () => {
    // Three is the shallowest depth that reproduces; eight is the fixture's.
    for (const depth of [3, 4, 5, 6, 7, 8]) {
        it(`a ${depth}-level four-space outline should survive every reachable move`, {
            timeout: 120_000,
        }, async () => {
            const { executed, serializerClean, rawDamaged, verifiedDamaged } = await sweep(
                fourSpaceOutline(depth),
            );

            expect(executed, "no moves were executable — the sweep tested nothing").toBeGreaterThan(
                0,
            );
            expect(serializerClean, "no move left a serializable document").toBeGreaterThan(0);
            // Liveness: without the verification this document IS damaged. If
            // this ever fails, the bug moved and the assertion below has
            // stopped meaning anything.
            expect(
                rawDamaged,
                `depth ${depth} no longer reproduces through the plain merge — ` +
                    `this test has gone vacuous and needs rebuilding, not deleting`,
            ).toBeGreaterThan(0);
            expect(
                verifiedDamaged,
                `${verifiedDamaged} of ${serializerClean} reachable moves the serializer ` +
                    `handled cleanly still corrupt a ${depth}-level four-space outline on save`,
            ).toBe(0);
        });
    }

    // A PASTE, not a move. The first cut of this fix verified only merges that
    // relocated content, on the reasoning that a block move is what lands saved
    // bytes beside neighbours they were never spelled for. MAR-343's census had
    // found damage only in moves — but it enumerated only moves, so the
    // evidence was circular. A paste lands one document's bytes beside
    // another's just as squarely, and on the real fixture 163 of 1194 paste
    // positions were damaged with the gate in place.
    it("a paste into a four-space outline should survive the save", async () => {
        const source = fourSpaceOutline(3);
        const editor = await makeCorpusEditor(source, [contentGuardPlugin]);
        editors.push(editor);
        const v = editorView(editor);
        const protection = computeRoundTripProtection(source, editor.action(getMarkdown()));
        const parse = (text: string): ProseNode | null =>
            editor.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode | null;
        const baseState = v.state;
        const pasted = parse("- pasted a\n    - pasted b\n")!;

        let rawDamaged = 0;
        let verifiedDamaged = 0;
        let applied = 0;
        let serializerClean = 0;
        for (let pos = 1; pos < v.state.doc.content.size; pos++) {
            // A paste lands at the CURSOR, so only positions a caret can
            // actually occupy count. Inserting at every offset would sweep
            // places no gesture reaches and claim user impact the product
            // never has — the distinction this repo keeps between corpus pins
            // M8 (unreachable, guards the gate) and M9 (a real drop slot).
            let sel;
            try {
                sel = TextSelection.near(v.state.doc.resolve(pos), 1);
            } catch {
                continue;
            }
            if (sel.from !== pos || !sel.empty) {
                continue; // the caret settles elsewhere; this offset is not its own
            }
            const tr = v.state.tr.setSelection(sel);
            try {
                tr.replaceSelection(new Slice(pasted.content, 0, 0));
            } catch {
                continue;
            }
            if (!tr.docChanged) {
                continue;
            }
            v.dispatch(tr);
            applied++;
            const serialized = editor.action(getMarkdown());
            const live = v.state.doc;
            const dirty = (text: string): boolean =>
                formatFingerprintDiff(
                    diffFingerprints(fingerprintDoc(live), fingerprintDoc(parse(text)!)),
                ) !== CLEAN;

            if (!dirty(serialized)) {
                serializerClean++;
                if (dirty(applyMinimalChanges(source, serialized, markdownProfile, protection))) {
                    rawDamaged++;
                }
                if (
                    dirty(
                        mergeVerified(source, serialized, markdownProfile, protection, live, parse)
                            .text,
                    )
                ) {
                    verifiedDamaged++;
                }
            }
            v.updateState(baseState);
        }

        expect(applied, "no caret-reachable paste positions were exercised").toBeGreaterThan(0);
        expect(serializerClean, "no paste left a serializable document").toBeGreaterThan(0);
        expect(
            rawDamaged,
            "pasting no longer damages this document through the plain merge — this test has gone vacuous",
        ).toBeGreaterThan(0);
        expect(
            verifiedDamaged,
            `${verifiedDamaged} of ${serializerClean} paste positions the serializer handled ` +
                `cleanly still corrupt a four-space outline on save`,
        ).toBe(0);
    }, 180_000);

    // The merge must not decide anything differently because a file uses CRLF.
    //
    // Read this before quoting it as coverage for `coreOf`'s stripEol: it is
    // NOT. Reverting that line leaves this green, because the flag it corrects
    // no longer changes any output the save path ships (see the comment on
    // `coreOf` itself). What this pins is the broader property both rest on,
    // where a future EOL regression with real consequences would show up.
    it("a CRLF file and its LF twin should merge to the same bytes, modulo endings", async () => {
        const lf = fourSpaceOutline(4);
        const crlf = lf.replace(/\n/g, "\r\n");

        const run = async (source: string): Promise<string[]> => {
            const editor = await makeCorpusEditor(source, [contentGuardPlugin]);
            editors.push(editor);
            const v = editorView(editor);
            const protection = computeRoundTripProtection(source, editor.action(getMarkdown()));
            const baseState = v.state;
            const outs: string[] = [];
            for (const { source: src, target } of enumerateMovePairs(v)) {
                if (!moveBlocks(v, { from: src.from, to: src.to }, target)) {
                    v.updateState(baseState);
                    continue;
                }
                outs.push(
                    applyMinimalChanges(
                        source,
                        editor.action(getMarkdown()),
                        markdownProfile,
                        protection,
                    ),
                );
                v.updateState(baseState);
            }
            return outs;
        };

        const lfOuts = await run(lf);
        const crlfOuts = await run(crlf);
        expect(lfOuts.length).toBeGreaterThan(0);
        expect(crlfOuts.length).toBe(lfOuts.length);
        const divergent = crlfOuts.filter((c, i) => c.replace(/\r\n/g, "\n") !== lfOuts[i]).length;
        expect(
            divergent,
            `${divergent} of ${lfOuts.length} moves merge differently on a CRLF file`,
        ).toBe(0);
    }, 180_000);

    // The relocation gate read its signal off a flag that was EOL-sensitive:
    // `coreOf` compared line content with the trailing `\r` still attached, so
    // on a CRLF file the saved and serialized cores of the same line differed
    // by one byte and a real relocation went unreported. The gate is gone, but
    // the engine's own depth self-check still rides that flag, so the fix is
    // pinned here where a CRLF document is actually driven.
    it("a move in a CRLF four-space outline should survive the save", async () => {
        const source = fourSpaceOutline(4).replace(/\n/g, "\r\n");
        const { executed, serializerClean, verifiedDamaged } = await sweep(source);

        expect(executed).toBeGreaterThan(0);
        expect(serializerClean).toBeGreaterThan(0);
        expect(
            verifiedDamaged,
            `${verifiedDamaged} of ${serializerClean} CRLF moves corrupt on save`,
        ).toBe(0);
    }, 180_000);

    // The fixture the ticket's census measured: every damaged pair it found
    // was in this file, and none in the other forty. Sampled rather than swept
    // whole (the full space costs about half a minute), which is why the
    // ladder above exists — it is exhaustive, and it is where the guarantee
    // actually comes from.
    it("four-space-outline.md should survive a sampled sweep of its move space", {
        timeout: 180_000,
    }, async () => {
        const fixture = loadCorpusFixtures().find((f) => f.name === "four-space-outline.md");
        expect(fixture, "four-space-outline.md is missing from the corpus").toBeTruthy();

        const { executed, serializerClean, rawDamaged, verifiedDamaged } = await sweep(
            fixture!.content,
            200,
        );

        expect(executed).toBeGreaterThan(0);
        expect(serializerClean).toBeGreaterThan(0);
        expect(
            rawDamaged,
            "the fixture no longer reproduces through the plain merge — this sample has gone vacuous",
        ).toBeGreaterThan(0);
        expect(
            verifiedDamaged,
            `${verifiedDamaged} of ${serializerClean} sampled moves the serializer handled ` +
                `cleanly still corrupt four-space-outline.md on save`,
        ).toBe(0);
    });
});
