/**
 * Unit tests for the math plugin's pure logic: the inline input-rule regex
 * (currency / escaped-dollar guards) and LaTeX language detection.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection } from "../pm";
import { INLINE_MATH_RULE_REGEX, isRealInlineMath } from "../plugins/math";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { normalizeCodeLanguage } from "../codeLanguages";
import { runEditorCommand } from "../editorCommands";

// The rule fires on the just-typed text before the caret, so simulate that by
// matching the text that would sit before the closing `$`.
function firesOn(textBeforeCaret: string): string | null {
    const m = textBeforeCaret.match(INLINE_MATH_RULE_REGEX);
    return m ? m[1] : null;
}

describe("inline math input-rule regex", () => {
    it("a delimited formula with non-space edges should convert", () => {
        expect(firesOn("$E=mc^2$")).toBe("E=mc^2");
    });

    it("a formula containing inner spaces should still convert", () => {
        expect(firesOn("$a + b$")).toBe("a + b");
    });

    it("a single-character formula should convert", () => {
        expect(firesOn("$x$")).toBe("x");
    });

    it("currency like '$5 and $10' should NOT convert (trailing space edge)", () => {
        // Typing the closing `$` of the pair leaves "...5 and $" before caret.
        expect(firesOn("it costs $5 and $")).toBeNull();
    });

    it("an escaped dollar '\\$5$' should NOT convert (backslash lookbehind)", () => {
        expect(firesOn("price \\$5$")).toBeNull();
    });

    it("a leading-space inner like '$ x$' should NOT convert", () => {
        expect(firesOn("$ x$")).toBeNull();
    });

    it("a trailing-space inner like '$x $' should NOT convert", () => {
        expect(firesOn("$x $")).toBeNull();
    });

    it("a block-math opener '$$x$' should NOT convert as inline ($$ lookbehind)", () => {
        expect(firesOn("$$x$")).toBeNull();
    });
});

describe("isRealInlineMath (parse-time currency guard)", () => {
    it("a value with non-space edges should be real math", () => {
        expect(isRealInlineMath("E=mc^2")).toBe(true);
        expect(isRealInlineMath("a + b")).toBe(true);
        expect(isRealInlineMath("x")).toBe(true);
    });

    it("a value with a trailing space (currency like '$5 and $10') should NOT be math", () => {
        // remark-math parses "$5 and $10" into inlineMath with value "5 and ".
        expect(isRealInlineMath("5 and ")).toBe(false);
    });

    it("a value with a leading space should NOT be math", () => {
        expect(isRealInlineMath(" x")).toBe(false);
    });

    it("an empty value should NOT be math", () => {
        expect(isRealInlineMath("")).toBe(false);
    });
});

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

describe("inline math parsing in a real editor (currency guard)", () => {

    function mathNodeCount(editor: Editor): number {
        let count = 0;
        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.state.doc.descendants((n) => {
                if (n.type.name === "math_inline") count++;
            });
        });
        return count;
    }

    it("a loaded document with '$5 and $10' should render NO inline math node", async () => {
        const editor = await makeEditor(
            "Currency like $5 and $10 stays as plain text.",
        );
        expect(mathNodeCount(editor)).toBe(0);
    });

    it("a loaded document with a real formula should still render inline math", async () => {
        const editor = await makeEditor("Inline $E = mc^2$ here.");
        expect(mathNodeCount(editor)).toBe(1);
    });

    it("a currency line should round-trip byte-identically through the save pipeline", async () => {
        const src = "Currency like $5 and $10 stays as plain text.\n";
        const editor = await makeEditor(src);
        const serialized = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(src, serialized);
        const merged = applyMinimalChanges(src, serialized, protection);
        expect(merged).toBe(src);
    });
});

describe("insertInlineMathCommand where inline math cannot live", () => {
    // Regression: with the caret inside a code block (content `text*`),
    // replaceSelectionWith cannot place the math node at selection.from and
    // NodeSelection.create then threw "Cannot read properties of null
    // (reading 'nodeSize')". Reproduced via toolbar: insert code block, then
    // the math button. The command must refuse instead.
    it("with the caret inside a code block should be a safe no-op", async () => {
        const editor = await makeEditor("```js\nlet x = 1\n```");
        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            let inside = -1;
            view.state.doc.descendants((n, pos) => {
                if (n.type.name === "code_block") {
                    inside = pos + 1;
                }
                return inside < 0;
            });
            expect(inside).toBeGreaterThan(-1);
            view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, inside + 2)),
            );
        });
        const before = editor.action(getMarkdown());
        // the exact toolbar/command-palette path
        expect(() => runEditorCommand("insertMath", () => editor)).not.toThrow();
        expect(editor.action(getMarkdown())).toBe(before);
    });

    it("in a paragraph the command should still wrap the selection as math", async () => {
        const editor = await makeEditor("energy is E = mc^2 here\n");
        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            // select "E = mc^2": paragraph starts at 0, text at 1
            view.dispatch(
                view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, 11, 19),
                ),
            );
        });
        runEditorCommand("insertMath", () => editor);
        expect(editor.action(getMarkdown())).toContain("$E = mc^2$");
    });
});

describe("LaTeX code language detection", () => {
    it("the 'LaTeX' label should normalize to 'latex'", () => {
        expect(normalizeCodeLanguage("LaTeX")).toBe("latex");
    });

    it("the 'tex' alias should normalize to 'latex'", () => {
        expect(normalizeCodeLanguage("tex")).toBe("latex");
    });

    it("an unrelated language should not normalize to 'latex'", () => {
        expect(normalizeCodeLanguage("python")).not.toBe("latex");
    });
});
