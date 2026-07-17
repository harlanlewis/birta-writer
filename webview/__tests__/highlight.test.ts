/**
 * Highlight (==mark==): strict-grammar micromark construct → highlight PM
 * mark, serialized back to the exact source bytes. Real Milkdown editor with
 * the production serialization config (the wikiLinks harness).
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, commandsCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { toggleHighlightCommand } from "../plugins/highlight";

async function makeEditor(markdown: string): Promise<{
    editor: Editor;
    container: HTMLElement;
    view: EditorView;
}> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(toggleHighlightCommand)
        .create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    return { editor, container, view };
}

async function roundTrip(markdown: string): Promise<string> {
    const { editor } = await makeEditor(markdown);
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

/** Text contents of all highlight-marked ranges in the doc. */
function highlightedTexts(view: EditorView): string[] {
    const texts: string[] = [];
    view.state.doc.descendants((node) => {
        if (node.isText && node.marks.some((m) => m.type.name === "highlight")) {
            texts.push(node.text ?? "");
        }
        return true;
    });
    return texts;
}

describe("highlight parsing", () => {
    it("==text== should become a highlight-marked range", async () => {
        const { editor, view } = await makeEditor("Some ==marked text== here.\n");
        expect(highlightedTexts(view)).toEqual(["marked text"]);
        await editor.destroy();
    });

    it("renders as a <mark> element", async () => {
        const { editor, container } = await makeEditor("A ==glow== word.\n");
        const el = container.querySelector("mark.md-highlight");
        expect(el).not.toBeNull();
        expect(el!.textContent).toBe("glow");
        await editor.destroy();
    });

    it("multiple highlights in one paragraph all parse", async () => {
        const { editor, view } = await makeEditor("==a== then ==b== then ==c==.\n");
        expect(highlightedTexts(view)).toEqual(["a", "b", "c"]);
        await editor.destroy();
    });

    it("strict grammar rejections stay plain text", async () => {
        const cases = [
            "a == spaced == b\n",     // leading/trailing space
            "a ==x=y== b\n",          // `=` inside content
            "a ==trailing == b\n",    // space before closer
            "2==2 equality\n",        // no closer
            "a == b comparison\n",    // bare pair
        ];
        for (const doc of cases) {
            const { editor, view } = await makeEditor(doc);
            expect(highlightedTexts(view), doc).toEqual([]);
            await editor.destroy();
        }
    });

    it("==…== inside inline code stays code", async () => {
        const { editor, view } = await makeEditor("Code: `==in code==`.\n");
        expect(highlightedTexts(view)).toEqual([]);
        await editor.destroy();
    });

    it("an escaped \\== marker stays literal", async () => {
        const { editor, view } = await makeEditor("Escaped \\==not marked== text.\n");
        expect(highlightedTexts(view)).toEqual([]);
        await editor.destroy();
    });
});

describe("highlight round-trip byte-identity", () => {
    const FORMS = [
        "Plain ==highlighted text== inline.\n",
        "Adjacent==tight==highlights here.\n",
        "**==inside bold==** nesting.\n",
        "==a== then ==b== in one line.\n",
        "Unicode ==höhere Café ☕== survives.\n",
        "a == spaced == b stays text.\n",
        "a ==x=y== b stays text.\n",
        "- Item with ==highlight== inside.\n",
        "> Quote with ==highlight== inside.\n",
    ];

    for (const form of FORMS) {
        it(`round-trips ${JSON.stringify(form.trim())} byte-identically`, async () => {
            expect(await roundTrip(form)).toBe(form);
        });
    }
});

describe("escaped highlight literals re-escape on serialize (MAR-121)", () => {
    // A hand-escaped `\==word==` decodes to the plain text `==word==`; without
    // re-escaping, a fresh serialization drops the backslash and the run
    // reparses into a highlight, silently losing the `==` bytes. These forms
    // must survive a raw round trip byte-identically.
    const ESCAPED = [
        "Escaped \\==not a highlight== stays literal.\n",
        "A \\==single== word.\n",
        "Mid \\==höhere Café ☕== unicode.\n",
        "- Item \\==escaped== inside.\n",
        "> Quote \\==escaped== inside.\n",
    ];
    for (const form of ESCAPED) {
        it(`round-trips ${JSON.stringify(form.trim())} byte-identically`, async () => {
            expect(await roundTrip(form)).toBe(form);
        });
    }

    it("does not over-escape a run the grammar rejects (== with = inside)", async () => {
        // `==x=y==` is not a highlight (interior `=`), so it needs no
        // backslash — the escape must fire only on genuine highlight runs.
        expect(await roundTrip("a ==x=y== b stays text.\n")).toBe("a ==x=y== b stays text.\n");
    });
});

describe("fixture parse census", () => {
    // Byte round-trips can't catch a mis-parse (==x== serializes the same
    // whether it's a highlight or plain text), so the fixture is pinned to
    // the exact set of highlighted ranges, in document order.
    it("highlight.md parses to exactly the expected highlighted ranges", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const content = readFileSync(join(__dirname, "fixtures", "highlight.md"), "utf8");
        const { editor, view } = await makeEditor(content);
        expect(highlightedTexts(view)).toEqual([
            "highlighted text",
            "tight",
            "inside bold",
            "first",
            "second",
            "höhere Café ☕",
            "Starts a line",
            "line",
            "highlight", // list item
            "highlight", // blockquote
            "one",       // table header cell
            "y",         // table body cell
        ]);
        await editor.destroy();
    });
});

describe("cross-matching between adjacent rejected forms (documented behavior)", () => {
    it("the tail == of one rejected form pairs with the head of the next", async () => {
        // Paired-delimiter reality check, pinned deliberately: this is why
        // the fixture and the content inventory keep one rejected form per
        // line. If this test starts failing, the grammar changed — update
        // the docs alongside it.
        const { editor, view } = await makeEditor("x ==a=b==, and 2==2.\n");
        expect(highlightedTexts(view)).toEqual([", and 2"]);
        await editor.destroy();
    });
});

describe("typing ==text== should apply the mark (input rule)", () => {
    function typeWithInputRules(v: EditorView, text: string): void {
        for (const ch of text) {
            const { from, to } = v.state.selection;
            const handled = v.someProp("handleTextInput", (f) => f(v, from, to, ch));
            if (!handled) {
                v.dispatch(v.state.tr.insertText(ch, from, to));
            }
        }
    }

    it("applies on the closing = and serializes back", async () => {
        const { editor, view } = await makeEditor("start\n");
        const end = view.state.doc.content.size - 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
        typeWithInputRules(view, " ==bright==");
        expect(highlightedTexts(view)).toEqual(["bright"]);
        expect(editor.action(getMarkdown())).toBe("start ==bright==\n");
        await editor.destroy();
    });
});

describe("mark input rule at the end of the document (listSpreadNormalize regression)", () => {
    // Repro for a latent listSpreadNormalizePlugin crash surfaced by the
    // highlight rule in the real webview: a mark input rule's transaction
    // deletes its markers in TWO steps, and the plugin's appendTransaction
    // unioned per-step map coordinates WITHOUT mapping them through later
    // steps — near the doc end maxTo landed past the final doc size and
    // nodesBetween threw, killing the whole dispatch (mark never applied).
    it("typing ==x== at the very end applies the mark without throwing", async () => {
        const { listSpreadNormalizePlugin } = await import("../plugins");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, container);
                ctx.set(defaultValueCtx, "- item one\n- item two\n\ntail\n");
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .use(listSpreadNormalizePlugin)
            .create();
        const view = editor.action((ctx) => ctx.get(editorViewCtx));
        const end = view.state.doc.content.size - 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));

        for (const ch of " ==glow==") {
            const { from, to } = view.state.selection;
            const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch));
            if (!handled) {
                view.dispatch(view.state.tr.insertText(ch, from, to));
            }
        }

        expect(highlightedTexts(view)).toEqual(["glow"]);
        expect(editor.action(getMarkdown())).toContain("tail ==glow==");
        await editor.destroy();
    });
});

describe("toggleHighlight command", () => {
    it("marks the selection and serializes with == markers", async () => {
        const { editor, view } = await makeEditor("pick a word\n");
        // Select "word" (positions: paragraph starts at 0, text at 1).
        let from = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text?.includes("word")) {
                from = pos + node.text.indexOf("word");
            }
            return true;
        });
        expect(from).toBeGreaterThan(-1);
        view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 4)),
        );
        editor.action((ctx) => {
            ctx.get(commandsCtx).call(toggleHighlightCommand.key as never);
        });
        expect(highlightedTexts(view)).toEqual(["word"]);
        expect(editor.action(getMarkdown())).toBe("pick a ==word==\n");

        // Toggle off again.
        editor.action((ctx) => {
            ctx.get(commandsCtx).call(toggleHighlightCommand.key as never);
        });
        expect(highlightedTexts(view)).toEqual([]);
        expect(editor.action(getMarkdown())).toBe("pick a word\n");
        await editor.destroy();
    });
});
