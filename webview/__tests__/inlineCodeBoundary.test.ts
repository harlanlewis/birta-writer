/**
 * What an inline-code span's END boundary does, driving the REAL editor.
 *
 * `inlineCode` is `inclusive: false` (Milkdown 7.22.1), the same call
 * `plugins/linkBoundary.ts` makes for links and for the same reason: a span
 * has a closed end, and typing past it is how a writer leaves it. Two things
 * follow, and both are load-bearing enough that a bump which quietly reverted
 * either should fail here rather than in a feature that reads the caret.
 *
 * `$from.marks()` is the question "what marks will the next typed character
 * carry", which is why `plugins/caretSuggest.ts` refuses inline code by asking
 * it. At a span's end boundary the answer is now no marks, so a suggestion
 * that refuses inline code offers there, correctly: what it would write lands
 * outside the span, where the maintenance engines can see it.
 *
 * The mark input rules key off the same flag: a `*` typed inside a code span
 * is literal, so `markRule` stands down there. That one needs its control, or
 * a rule that never fires anywhere reads exactly like a rule that stood down.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

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

function at(v: EditorView, pos: number): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
}

/** Type one character at `pos` through the input rules, as the view would. */
function typeAt(v: EditorView, pos: number, ch: string): boolean {
    at(v, pos);
    const handled = v.someProp("handleTextInput", (f) => f(v, pos, pos, ch)) ?? false;
    if (!handled) { v.dispatch(v.state.tr.insertText(ch, pos, pos)); }
    return handled;
}

/** Every text child of the first paragraph, with whether it is code. */
function shape(v: EditorView): Array<{ text: string; code: boolean; marks: string[] }> {
    const out: Array<{ text: string; code: boolean; marks: string[] }> = [];
    v.state.doc.firstChild!.forEach((child) => {
        out.push({
            text: child.text ?? "",
            code: child.marks.some((m) => m.type.spec.code),
            marks: child.marks.map((m) => m.type.name),
        });
    });
    return out;
}

describe("the caret at an inline-code boundary", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        delete window.__i18n;
    });

    afterEach(async () => {
        await Promise.all(editors.map((e) => e.destroy()));
        editors = [];
    });

    it("a position inside the span should report the code mark, the end boundary should not", async () => {
        const v = await makeEditor("`2+3`\n");
        // The instrument reached its subject: one code-marked text node.
        expect(v.state.doc.firstChild!.textContent).toBe("2+3");
        expect(shape(v)).toEqual([{ text: "2+3", code: true, marks: ["inlineCode"] }]);

        const reports = (pos: number): boolean => {
            at(v, pos);
            return v.state.selection.$from.marks().some((m) => m.type.spec.code);
        };
        // Positions 2 and 3 sit between characters of "2+3"; 4 is the end.
        expect(reports(2)).toBe(true);
        expect(reports(3)).toBe(true);
        expect(reports(4)).toBe(false);
    });

    it("text typed at the end boundary should land outside the span as plain text", async () => {
        const v = await makeEditor("`2+3`\n");
        typeAt(v, 4, "=");

        expect(v.state.doc.firstChild!.textContent).toBe("2+3=");
        expect(shape(v)).toEqual([
            { text: "2+3", code: true, marks: ["inlineCode"] },
            { text: "=", code: false, marks: [] },
        ]);
    });

    // The control for the two above, and deliberately not a pin: this one holds
    // under `inclusive: true` as well, so it cannot fail on a reverted bump. It
    // is here because "typed text leaves the span" is only meaningful beside a
    // position where it does not.
    it("text typed inside the span should stay inside it", async () => {
        const v = await makeEditor("`2+3 `\n");
        // Position 4 is after "3" and before the trailing space: inside.
        typeAt(v, 4, "=");

        expect(v.state.doc.firstChild!.textContent).toBe("2+3= ");
        expect(shape(v)).toEqual([{ text: "2+3= ", code: true, marks: ["inlineCode"] }]);
    });
});

describe("a mark input rule inside an inline-code span", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        delete window.__i18n;
    });

    afterEach(async () => {
        await Promise.all(editors.map((e) => e.destroy()));
        editors = [];
    });

    it("the closing star should italicize in prose and stay literal in code", async () => {
        // One gesture, two contexts. The code reading is only evidence against
        // a control that fires: `handleTextInput` returning false means no rule
        // consumed the keystroke, which is also what a rule that is broken
        // everywhere returns.
        const plain = await makeEditor("a *b c\n");
        expect(plain.state.doc.firstChild!.textContent).toBe("a *b c");
        const handledInPlain = typeAt(plain, 5, "*");

        document.body.innerHTML = "";
        const code = await makeEditor("`a *b c`\n");
        expect(code.state.doc.firstChild!.textContent).toBe("a *b c");
        expect(shape(code)[0]!.code).toBe(true);
        const handledInCode = typeAt(code, 5, "*");

        // The control consumed the keystroke and wrote emphasis.
        expect(handledInPlain).toBe(true);
        expect(shape(plain).flatMap((s) => s.marks)).toContain("emphasis");

        // Inside the span the rule stood down and the stars stayed literal.
        expect(handledInCode).toBe(false);
        expect(code.state.doc.firstChild!.textContent).toBe("a *b* c");
        expect(shape(code).flatMap((s) => s.marks)).not.toContain("emphasis");
    });
});
