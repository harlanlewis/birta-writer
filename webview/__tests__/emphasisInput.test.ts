/**
 * Math-aware `*` emphasis (plugins/emphasisInput.ts), driving the REAL editor:
 * star pairs that read as multiplication stay literal text (the calc layer
 * needs the stars; the user never asked for italics), while prose emphasis
 * keeps working exactly as stock. The pure classifier is covered directly;
 * the input-rule wiring through pureCommonmark is covered end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { starPairIsMath } from "../plugins/emphasisInput";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<EditorView> {
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
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Simulates typing at the end of the doc, exercising input rules per char. */
function type(v: EditorView, text: string): void {
    for (const ch of text) {
        const end = v.state.doc.content.size - 1;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)));
        const handled = v.someProp("handleTextInput", (f) => f(v, end, end, ch)) ?? false;
        if (!handled) {
            v.dispatch(v.state.tr.insertText(ch, end, end));
        }
    }
}

const hasEmphasis = (v: EditorView): boolean => {
    let found = false;
    v.state.doc.descendants((node) => {
        if (node.marks.some((m) => m.type.name === "emphasis")) { found = true; }
        return true;
    });
    return found;
};

describe("starPairIsMath (the classifier)", () => {
    it("digit- or paren-flanked pairs over expression material are math", () => {
        expect(starPairIsMath("0", "60")).toBe(true);       // 60*60*
        expect(starPairIsMath("2", "x")).toBe(true);        // 2*x*
        expect(starPairIsMath(")", "2")).toBe(true);        // (a)*2*
        expect(starPairIsMath("t", "2")).toBe(true);        // budget*2*
        expect(starPairIsMath("3", "pi")).toBe(true);       // 4/3*pi*
    });

    it("prose emphasis is never math", () => {
        expect(starPairIsMath(" ", "word")).toBe(false);    // a *word*
        expect(starPairIsMath("", "emphasis")).toBe(false); // line-start *emphasis*
        expect(starPairIsMath("t", "idea")).toBe(false);    // great*idea* — no digit
        expect(starPairIsMath("0", "not math!")).toBe(false); // `!` is not expression material
    });
});

describe("math-aware emphasis in the real editor", () => {
    beforeEach(() => { document.body.innerHTML = ""; });
    afterEach(async () => {
        for (const e of editors) { await e.destroy(); }
        editors = [];
    });

    it("typing 60*60*1000 should keep literal stars (no italics)", async () => {
        const v = await makeEditor("x\n");
        type(v, " time = 60*60*1000ms");
        expect(hasEmphasis(v)).toBe(false);
        expect(v.state.doc.textContent).toBe("x time = 60*60*1000ms");
    });

    it("typing prose *emphasis* should still italicize", async () => {
        const v = await makeEditor("x\n");
        type(v, " a *word* here");
        expect(hasEmphasis(v)).toBe(true);
        expect(v.state.doc.textContent).toContain("word"); // stars consumed by the mark
    });

    it("typing budget*2 with a second star should stay literal", async () => {
        const v = await makeEditor("x\n");
        type(v, " budget*2*12");
        expect(hasEmphasis(v)).toBe(false);
        expect(v.state.doc.textContent).toBe("x budget*2*12");
    });
});
