/**
 * MAR-344: round-trip protection describes the CURRENT saved baseline.
 *
 * Protection is computed once from the file as loaded and pins each construct
 * the round trip cannot reproduce to its saved bytes. A save that falls back to
 * the serializer's canonical text writes a baseline holding none of those
 * spellings — so protection computed from the old one no longer describes
 * anything on disk, and repairing the next serialization with it restores the
 * former spelling over the new baseline. The file swings out on one save and
 * back on the next, which is the "what did it do to my file" experience the
 * product exists to prevent, even though no content is lost.
 *
 * The invariant asserted here is the user-visible one: A SAVE WITH NO EDIT
 * BEHIND IT WRITES NOTHING. It is stated over the production editor because the
 * lifecycle being pinned is editor.ts's module state, not the merge's return
 * value, and driven through flushPendingEdit because that is the save a Cmd+S
 * actually reaches.
 *
 * THE FIXTURE IS LOAD-BEARING AND WAS GOT WRONG ONCE. An inline three-level
 * four-space outline reproduces MAR-343's merge damage but NOT this churn: its
 * fallback rewrites the outline far enough that the recorded regions stop
 * matching the next serialization, the repair never fires, and keeping or
 * dropping protection agree — so the test passed with the fix reverted. The
 * corpus fixture keeps enough of its shape for the regions to still match, and
 * churns. Nothing here trusts it to stay that way: the search asserts it found
 * a qualifying gesture, and each premise is asserted before the invariant.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { editorViewCtx, parserCtx, serializerCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { applyMinimalChanges, serializerFallback } from "@birta/minimal-diff";
import type { EditorView, Node as ProseNode } from "../pm";
import { moveBlocks } from "../editing/moveBlocks";
import { diffFingerprints, fingerprintDoc, formatFingerprintDiff } from "../plugins/fingerprints";
import { markdownProfile, computeRoundTripProtection } from "../utils/minimalDiff";
import { createEditor, flushPendingEdit } from "../editor";
import {
    enumerateMovePairs,
    hashString,
    loadCorpusFixtures,
    mulberry32,
    shuffled,
} from "./helpers/moveFuzz";

vi.mock("../editing/rangeIndicator", () => ({
    flashRange: vi.fn(),
    showRangeVeil: vi.fn(),
    hideRangeVeil: vi.fn(),
}));

// Driving the real production stack, like savePipeline.test.ts: jsdom has no
// ResizeObserver and no rAF, and the first editor built in a process pays a
// one-time deferred-plugin charge the 5s default does not fit.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
beforeAll(() => {
    if (typeof globalThis.ResizeObserver === "undefined") {
        globalThis.ResizeObserver = class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        } as unknown as typeof ResizeObserver;
    }
    if (typeof globalThis.requestAnimationFrame === "undefined") {
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
            setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((id: number) =>
            clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
    }
});

const FIXTURE = loadCorpusFixtures().find((f) => f.name === "four-space-outline.md")!;

let editor: Editor | null = null;
afterEach(async () => {
    if (editor) await editor.destroy();
    editor = null;
    document.body.innerHTML = "";
});

/** A fresh production editor over `markdown`, with a pristine save baseline. */
async function open(markdown: string): Promise<EditorView> {
    if (editor) await editor.destroy();
    document.body.innerHTML = "";
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor = await createEditor(container, markdown, () => {});
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Does `text` reopen holding exactly the content the live document has? */
function reopensClean(v: EditorView, text: string): boolean {
    let doc: ProseNode | null;
    try {
        doc = editor!.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode | null;
    } catch {
        return false;
    }
    if (!doc) return false;
    return (
        formatFingerprintDiff(diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(doc))) ===
        "lost: (none); gained: (none)"
    );
}

describe("round-trip protection lifecycle", () => {
    it("a save that falls back to canonical bytes should leave the next save nothing to write", async () => {
        expect(FIXTURE, "the four-space outline fixture must exist").toBeTruthy();
        const saved = FIXTURE.content;
        const v = await open(saved);
        const base = v.state;
        const protection = computeRoundTripProtection(saved, editor!.action(getMarkdown()));
        expect(
            protection?.regions.length,
            "the fixture must carry protection, or there is nothing to go stale",
        ).toBeGreaterThan(0);

        // Phase 1 — find the gestures, saving nothing. flushPendingEdit rewrites
        // the baseline on every call, so a flush per candidate would leave the
        // damaging pair diffing against an earlier pair's output; an earlier cut
        // of this test did exactly that and passed with the fix reverted.
        //
        // Selected by the fallback's own condition (the merge loses content the
        // serializer alone carries) AND by the churn premise (the load-time
        // protection can still rewrite those bytes). Both asked with the
        // fingerprint oracle and the engine, never of the code under test.
        const rng = mulberry32(hashString(FIXTURE.name));
        const damaging: { from: number; to: number; target: number }[] = [];
        for (const { source, target } of shuffled([...enumerateMovePairs(v)], rng)) {
            if (!moveBlocks(v, { from: source.from, to: source.to }, target)) {
                v.updateState(base);
                continue;
            }
            const serialized = editor!.action(getMarkdown());
            const merged = applyMinimalChanges(saved, serialized, markdownProfile, protection);
            const fallback = serializerFallback(saved, serialized);
            if (
                merged !== fallback &&
                !reopensClean(v, merged) &&
                reopensClean(v, fallback) &&
                applyMinimalChanges(fallback, serialized, markdownProfile, protection) !== fallback
            ) {
                damaging.push({ from: source.from, to: source.to, target });
            }
            v.updateState(base);
            if (damaging.length >= 3) break;
        }
        expect(
            damaging.length,
            "no move in this fixture both falls back and leaves protection able to churn",
        ).toBeGreaterThan(0);

        // Phase 2 — each gesture on its own pristine editor, so every case
        // starts from the file as loaded rather than the previous case's output.
        for (const move of damaging) {
            const v2 = await open(saved);
            expect(moveBlocks(v2, { from: move.from, to: move.to }, move.target)).toBe(true);
            const serialized = editor!.action(getMarkdown());

            const first = flushPendingEdit();
            // Premise: this save really did write canonical bytes. Without it
            // the rest is a stability check on an ordinary merge.
            expect(first, "the save should have fallen back to the serializer").toBe(
                serializerFallback(saved, serialized),
            );

            // The invariant: nothing was edited between the saves.
            expect(flushPendingEdit()).toBe(first);
            // And a third, since the reported symptom settled on save three:
            // the file must be still, not merely alternating more slowly.
            expect(flushPendingEdit()).toBe(first);
        }
    });

    it("canonical serializer output should reparse and re-serialize to itself, for every protected fixture", async () => {
        // The premise the drop rests on, as a test rather than a comment.
        // Dropping protection instead of recomputing it is only equivalent
        // because a reload of canonical bytes computes no regions, and that is
        // true only where the serializer's output is a fixed point. A census
        // stated in a comment cannot fail; MAR-343 shipped a gate justified by
        // one, and a paste walked straight through it. This one goes red the
        // day a construct stops round-tripping to itself, which is the day
        // `mergeForSave` would start dropping protection a reload would keep.
        const offenders: string[] = [];
        let examined = 0;
        for (const fx of loadCorpusFixtures()) {
            const v = await open(fx.content);
            const serialized = editor!.action(getMarkdown());
            if (!computeRoundTripProtection(fx.content, serialized)?.regions.length) continue;
            examined++;
            const reparsed = editor!.action((ctx) => ctx.get(parserCtx)(serialized)) as
                | ProseNode
                | null;
            const again = reparsed
                ? editor!.action((ctx) => ctx.get(serializerCtx)(reparsed))
                : null;
            if (again !== serialized) offenders.push(fx.name);
            void v;
        }
        // Liveness: an empty `offenders` proves nothing if the filter above
        // matched nothing. The floor is deliberately loose, since the corpus
        // grows and the exact count is not the subject.
        expect(examined, "no protected fixture was examined").toBeGreaterThan(15);
        expect(offenders, "canonical output is not a fixed point for these fixtures").toEqual([]);
    });

    it("an ordinary save should still spell an edited line the file's own way", async () => {
        // The other side of the invariant: protection is dropped only when the
        // bytes written were canonical, never as a matter of course. This file
        // indents four spaces per level and the serializer writes two, so the
        // indent unit is knowable only from the baseline round trip that
        // protection carries (MAR-222).
        //
        // THE PIN IS THE LAST LINE, and where it fires is worth stating because
        // it is not where the story suggests. Drop protection unconditionally
        // and the FIRST save is still entirely correct — it ran with protection
        // in hand, so both `toContain` assertions below pass. The damage lands
        // on the second save, which merges against a baseline it no longer has
        // any facts about and canonicalizes the whole outline. So the two
        // `toContain`s are premises (the edit landed where it was aimed), and
        // only the stability assertion discriminates.
        const saved = FIXTURE.content;
        const v = await open(saved);

        let at = -1;
        v.state.doc.descendants((node, pos) => {
            if (at >= 0) return false;
            if (node.isText && node.text === "level 3") {
                at = pos + node.text.length;
                return false;
            }
            return true;
        });
        expect(at, "the fixture must still contain a 'level 3' item").toBeGreaterThan(0);
        v.dispatch(v.state.tr.insertText(" edited", at));

        const first = flushPendingEdit();
        expect(first).toContain("        - level 3 edited");
        expect(first).toContain("            - level 4");
        expect(flushPendingEdit()).toBe(first);
    });
});
