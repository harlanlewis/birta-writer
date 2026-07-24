/**
 * The stale/broken cue CLASSIFIER (plugins/calcStale.ts,
 * computeCalcCueDecorations): which arrow equations are cued, as what, and
 * which are deliberately left alone. Pure — a parsed document in, a
 * DecorationSet out; the plugin lifecycle (idle arm, debounce, gate) is
 * covered in calcStaleDeferred.test.ts and the live-editor behavior in
 * calcStalePlugin.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView, Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    computeCalcCueDecorations,
    clearCueIgnores,
    ignoreCueSession,
    type CalcCueSpec,
} from "../plugins/calcStale";
import { ensureCalcUnits } from "../utils/calc";

function setCalcFlags(): void {
    (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
        translations: {},
        isMac: true,
        calcEnabled: true,
        calcAutoInsert: false,
    };
}

/** Parse markdown into a real document (the classifier's only input). */
async function docOf(markdown: string): Promise<ProseNode> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    const doc = editor.action((ctx) => (ctx.get(editorViewCtx) as EditorView).state.doc);
    await editor.destroy();
    return doc;
}

/** Every cue in the doc: the decorated text plus its spec, in order. */
function cuesIn(doc: ProseNode): Array<{ text: string; cue: CalcCueSpec["cue"] }> {
    return computeCalcCueDecorations(doc).set.find().map((d) => ({
        text: doc.textBetween(d.from, d.to),
        cue: (d.spec as CalcCueSpec).cue,
    }));
}

beforeEach(() => {
    document.body.innerHTML = "";
    setCalcFlags();
    clearCueIgnores();
});

describe("before the unit engine loads (lazy chunk)", () => {
    it("a unit-shaped arrow should report needsUnits and carry no cue yet", async () => {
        const doc = await docOf("3 km in mi => 5");
        const scan = computeCalcCueDecorations(doc);
        expect(scan.set.find()).toHaveLength(0);
        expect(scan.needsUnits).toBe(true);
    });

    it("variable arrows should classify even while units are pending", async () => {
        const doc = await docOf("x = 4\n\nx\\*2 => 6\n\n3 km in mi => 5");
        const scan = computeCalcCueDecorations(doc);
        expect(scan.set.find()).toHaveLength(1);
        expect(scan.needsUnits).toBe(true);
    });
});

describe("cue classification (units loaded)", () => {
    beforeAll(() => ensureCalcUnits());

    it("an answer that no longer matches its definition should cue stale with the new value", async () => {
        const doc = await docOf("x = 4\n\nx\\*2 => 6");
        const cues = cuesIn(doc);
        expect(cues).toHaveLength(1);
        expect(cues[0].text).toBe("6");
        expect(cues[0].cue.kind).toBe("stale");
        expect(cues[0].cue.newValue).toBe("8");
        expect(cues[0].cue.expr).toBe("x*2");
    });

    it("an answer that still holds should carry no cue", async () => {
        const doc = await docOf("x = 4\n\nx\\*2 => 8");
        expect(cuesIn(doc)).toHaveLength(0);
    });

    it("the user's comma grouping should still count as the same value", async () => {
        const doc = await docOf("x = 750\n\nx\\*2 => 1,500");
        expect(cuesIn(doc)).toHaveLength(0);
    });

    it("an arrow moved above its definition should cue broken with the missing name", async () => {
        const doc = await docOf("x\\*2 => 8\n\nx = 4");
        const cues = cuesIn(doc);
        expect(cues).toHaveLength(1);
        expect(cues[0].cue.kind).toBe("broken");
        expect(cues[0].cue.missingName).toBe("x");
    });

    it("a constant-only arrow mismatch should never cue (no external premise)", async () => {
        const doc = await docOf("2+3 => 99");
        expect(cuesIn(doc)).toHaveLength(0);
    });

    it("a `=` equation mismatch should never cue (self-contained, possibly prose)", async () => {
        const doc = await docOf("3+4 = 99");
        expect(cuesIn(doc)).toHaveLength(0);
    });

    it("a definition mid-edit (`x =` head) should suppress its dependents' cues", async () => {
        const doc = await docOf("x =\n\nx\\*2 => 8");
        expect(cuesIn(doc)).toHaveLength(0);
    });

    it("a division by zero should cue broken with no missing name", async () => {
        const doc = await docOf("x = 0\n\n1/x => 5");
        const cues = cuesIn(doc);
        expect(cues).toHaveLength(1);
        expect(cues[0].cue.kind).toBe("broken");
        expect(cues[0].cue.missingName).toBeNull();
    });

    it("unit conversions should classify clean / stale / broken", async () => {
        expect(cuesIn(await docOf("3 km in mi => 1.864114"))).toHaveLength(0);
        const stale = cuesIn(await docOf("3 km in mi => 5"));
        expect(stale).toHaveLength(1);
        expect(stale[0].cue.kind).toBe("stale");
        expect(stale[0].cue.newValue).toBe("1.864114");
        const broken = cuesIn(await docOf("3 km in kg => 5"));
        expect(broken).toHaveLength(1);
        expect(broken[0].cue.kind).toBe("broken");
        expect(broken[0].cue.missingName).toBeNull();
    });

    it("a definition inside inline code is source, so the dependent arrow is broken", async () => {
        const doc = await docOf("`x = 4`\n\nx\\*2 => 8");
        const cues = cuesIn(doc);
        expect(cues).toHaveLength(1);
        expect(cues[0].cue.kind).toBe("broken");
        expect(cues[0].cue.missingName).toBe("x");
    });

    it("an arrow inside a code block is source and never cued", async () => {
        const doc = await docOf("x = 4\n\n```\nx*2 => 6\n```");
        expect(cuesIn(doc)).toHaveLength(0);
    });

    it("a definition in a heading is a title, not a data line", async () => {
        const doc = await docOf("# x = 4\n\nx\\*2 => 8");
        const cues = cuesIn(doc);
        expect(cues).toHaveLength(1);
        expect(cues[0].cue.kind).toBe("broken");
    });

    it("a hard-break definition line above an arrow in the SAME block should feed its scope", async () => {
        // `x = 4` and the arrow share one paragraph via a hard break — lines
        // are real (blockCalcText maps hardbreak to \n), and the interleave
        // must feed line 1's definition before classifying line 2's arrow.
        const doc = await docOf("x = 4\\\nx\\*2 => 6");
        const cues = cuesIn(doc);
        expect(cues).toHaveLength(1);
        expect(cues[0].cue.kind).toBe("stale");
        expect(cues[0].cue.newValue).toBe("8");
    });

    it("an ignored equation should stay quiet for the session", async () => {
        const doc = await docOf("x = 4\n\nx\\*2 => 6");
        expect(cuesIn(doc)).toHaveLength(1);
        ignoreCueSession("x*2", "6");
        expect(cuesIn(doc)).toHaveLength(0);
        // Either side changing is a NEW question and cues afresh.
        const changed = await docOf("x = 4\n\nx\\*2 => 7");
        expect(cuesIn(changed)).toHaveLength(1);
    });
});
