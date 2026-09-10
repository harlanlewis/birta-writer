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
 * The mark input rules key off the same flag: a delimiter typed inside a code
 * span is literal, so `markRule` stands down there. Every delimiter the
 * CHANGELOG entry claims is driven, not one standing in for the rest, and each
 * needs its control: a rule that never fires anywhere reads exactly like a rule
 * that stood down.
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

    // Every one of these is a separate input rule, and the CHANGELOG entry
    // claims the whole set, so the whole set is driven rather than one of them
    // standing in for the rest. Table-driven so a new delimiter joins by adding
    // a row, and the `ch` field carries BOTH characters of a two-character
    // delimiter: typing one `*` of a `**` pair matches nothing, and a probe
    // that types only the first reads as a rule standing down when it is really
    // a rule that was never offered its trigger.
    const DELIMITERS = [
        { name: "**strong**", text: "a **b c", pos: 6, ch: "**", mark: "strong" },
        // Both spellings of emphasis, because they are not one rule: the star
        // is `mathAwareEmphasisStarInputRule`, which WRAPS `markRule` to keep
        // `60*60*1000` literal, and a wrapper is exactly where the upstream
        // guard could be bypassed. The underscore is the stock rule.
        { name: "*emphasis*", text: "a *b c", pos: 5, ch: "*", mark: "emphasis" },
        { name: "_emphasis_", text: "a _b c", pos: 5, ch: "_", mark: "emphasis" },
        { name: "~~strike~~", text: "a ~~b c", pos: 6, ch: "~~", mark: "strike_through" },
        { name: "==highlight==", text: "a ==b c", pos: 6, ch: "==", mark: "highlight" },
    ] as const;

    // The list is the assertion's own subject, so an empty or truncated table
    // would otherwise pass by enumerating nothing.
    it("the table should cover every delimiter the entry claims", () => {
        expect(DELIMITERS.map((d) => d.name).sort()).toEqual(
            ["**strong**", "*emphasis*", "==highlight==", "_emphasis_", "~~strike~~"],
        );
    });

    for (const d of DELIMITERS) {
        it(`${d.name} should fire in prose and stand down inside a code span`, async () => {
            // One gesture, two contexts. The code reading is only evidence
            // against a control that fires: `handleTextInput` returning false
            // means no rule consumed the keystroke, which is also what a rule
            // broken everywhere returns.
            const plain = await makeEditor(`${d.text}\n`);
            expect(plain.state.doc.firstChild!.textContent).toBe(d.text);
            expect(shape(plain)[0]!.code).toBe(false);
            [...d.ch].forEach((ch, i) => typeAt(plain, d.pos + i, ch));

            document.body.innerHTML = "";
            const code = await makeEditor(`\`${d.text}\`\n`);
            expect(code.state.doc.firstChild!.textContent).toBe(d.text);
            expect(shape(code)[0]!.code).toBe(true);
            [...d.ch].forEach((ch, i) => typeAt(code, d.pos + i, ch));

            // The control wrote the mark.
            expect(shape(plain).flatMap((x) => x.marks)).toContain(d.mark);
            // Inside the span the rule stood down and the delimiters are literal.
            expect(shape(code).flatMap((x) => x.marks)).not.toContain(d.mark);
            expect(code.state.doc.firstChild!.textContent).toBe(
                `${d.text.slice(0, d.pos - 1)}${d.ch}${d.text.slice(d.pos - 1)}`,
            );
        });
    }
});
