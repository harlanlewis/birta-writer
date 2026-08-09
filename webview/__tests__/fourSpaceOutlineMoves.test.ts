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

interface Sweep {
    executed: number;
    rawDamaged: number;
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
    const out: Sweep = { executed: 0, rawDamaged: 0, verifiedDamaged: 0 };

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

        if (reopensDirty(applyMinimalChanges(source, serialized, markdownProfile, protection))) {
            out.rawDamaged++;
        }
        if (
            reopensDirty(
                mergeVerified(source, serialized, markdownProfile, protection, live, parse),
            )
        ) {
            out.verifiedDamaged++;
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
            const { executed, rawDamaged, verifiedDamaged } = await sweep(fourSpaceOutline(depth));

            expect(executed, "no moves were executable — the sweep tested nothing").toBeGreaterThan(
                0,
            );
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
                `${verifiedDamaged} of ${executed} reachable moves corrupt a ` +
                    `${depth}-level four-space outline on save`,
            ).toBe(0);
        });
    }

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

        const { executed, rawDamaged, verifiedDamaged } = await sweep(fixture!.content, 200);

        expect(executed).toBeGreaterThan(0);
        expect(
            rawDamaged,
            "the fixture no longer reproduces through the plain merge — this sample has gone vacuous",
        ).toBeGreaterThan(0);
        expect(
            verifiedDamaged,
            `${verifiedDamaged} of ${executed} sampled moves corrupt four-space-outline.md on save`,
        ).toBe(0);
    });
});
