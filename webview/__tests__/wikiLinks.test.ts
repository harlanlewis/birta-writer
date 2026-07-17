/**
 * Wikilinks: parse → wiki_link atom node, serialize → the exact source bytes.
 * Drives the REAL Milkdown editor with the production serialization config —
 * no mocks. Byte-identity is the plugin's whole reason to exist (see
 * plugins/wikiLinks.ts), so most tests are round-trip equalities.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { parseWikiRaw, wikiDisplayText } from "../plugins/wikiLinks";

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

describe("parseWikiRaw", () => {
    it("splits target, heading, and alias", () => {
        expect(parseWikiRaw("target")).toEqual({ target: "target", heading: null, alias: null });
        expect(parseWikiRaw("target|alias")).toEqual({ target: "target", heading: null, alias: "alias" });
        expect(parseWikiRaw("target#head")).toEqual({ target: "target", heading: "head", alias: null });
        expect(parseWikiRaw("target#head|alias")).toEqual({ target: "target", heading: "head", alias: "alias" });
    });

    it("trims parts but only for display — spacing semantics stay in raw", () => {
        expect(parseWikiRaw(" target | spaced alias ")).toEqual({
            target: "target",
            heading: null,
            alias: "spaced alias",
        });
    });

    it("splits on the FIRST pipe and FIRST hash only", () => {
        expect(parseWikiRaw("a|b|c")).toEqual({ target: "a", heading: null, alias: "b|c" });
        expect(parseWikiRaw("a#b#c")).toEqual({ target: "a", heading: "b#c", alias: null });
    });

    it("handles a same-page heading link", () => {
        expect(parseWikiRaw("#heading")).toEqual({ target: "", heading: "heading", alias: null });
    });

    it("treats \\| as an escaped pipe (Obsidian's in-table alias form)", () => {
        expect(parseWikiRaw("a\\|b")).toEqual({ target: "a|b", heading: null, alias: null });
        expect(parseWikiRaw("a\\|b|shown")).toEqual({ target: "a|b", heading: null, alias: "shown" });
    });
});

describe("wikiDisplayText", () => {
    it("prefers the alias, then target#heading, then target", () => {
        expect(wikiDisplayText("t|a")).toBe("a");
        expect(wikiDisplayText("t#h")).toBe("t#h");
        expect(wikiDisplayText("t")).toBe("t");
    });

    it("degenerate raws fall back to the bracketed source — never an invisible chip", () => {
        expect(wikiDisplayText(" ")).toBe("[[ ]]");
        expect(wikiDisplayText("|")).toBe("[[|]]");
    });
});

describe("wiki_link node parsing", () => {
    it("renders a wikilink as an inline atom anchor with derived attrs", async () => {
        const { editor, container } = await makeEditor("A [[target#head|alias]] link.\n");
        const el = container.querySelector('a[data-type="wiki-link"]');
        expect(el).not.toBeNull();
        expect(el!.getAttribute("data-raw")).toBe("target#head|alias");
        expect(el!.getAttribute("data-target")).toBe("target");
        expect(el!.getAttribute("data-heading")).toBe("head");
        expect(el!.textContent).toBe("alias");
        await editor.destroy();
    });

    it("does not consume footnote-like or normal-link syntax", async () => {
        const { editor, container } = await makeEditor(
            "A [normal](x.md) link and [shortcut] text.\n",
        );
        expect(container.querySelector('a[data-type="wiki-link"]')).toBeNull();
        await editor.destroy();
    });

    it("leaves a CommonMark [[x]](url) citation to the link parser", async () => {
        const { editor, container } = await makeEditor(
            "A citation [[1]](https://example.com) here.\n",
        );
        expect(container.querySelector('a[data-type="wiki-link"]')).toBeNull();
        expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
        await editor.destroy();
    });

    it("escapes a bare pipe when a wikilink is serialized inside a table cell", async () => {
        const { editor, view } = await makeEditor("| one | two |\n| --- | --- |\n| x | y |\n");
        // Replace the "y" cell content with an alias wikilink atom carrying a
        // BARE pipe (only creation paths can produce one — parsing can't).
        const type = view.state.schema.nodes["wiki_link"];
        let yPos = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === "y") yPos = pos;
        });
        expect(yPos).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.replaceWith(yPos, yPos + 1, type.create({
            raw: "page|shown", target: "page", heading: "", alias: "shown",
        })));

        const out = editor.action(getMarkdown());
        expect(out).toContain("[[page\\|shown]]");
        // The table survives: still a 2-cell data row (split on UNESCAPED pipes).
        const dataRow = out.split("\n").find((l) => l.includes("page"));
        expect(dataRow?.split(/(?<!\\)\|/).length).toBe(4); // | cell | cell | → 4 parts
        await editor.destroy();
    });

    it("leaves [[…]] inside inline code alone", async () => {
        const { editor, container } = await makeEditor("Code: `[[in code]]`.\n");
        expect(container.querySelector('a[data-type="wiki-link"]')).toBeNull();
        await editor.destroy();
    });
});

describe("wiki_link round-trip byte-identity", () => {
    const FORMS = [
        "[[target]]",
        "[[Some Page Name]]",
        "[[target|display text]]",
        "[[ target | spaced alias ]]",
        "[[target#Some Heading]]",
        "[[target#heading|aliased]]",
        "[[write/uber]]",
        "[[notes/2026/plan|the plan]]",
        "[[über#straße|café ☕]]",
    ];

    for (const form of FORMS) {
        it(`round-trips ${form} byte-identically`, async () => {
            const doc = `Before ${form} after.\n`;
            expect(await roundTrip(doc)).toBe(doc);
        });
    }

    it("round-trips adjacent and mark-wrapped wikilinks", async () => {
        const doc = "Text touches[[tight]]on both sides, and **[[bold]]** inside.\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("round-trips multiple wikilinks in one paragraph", async () => {
        const doc = "See [[a]], [[b|c]], and [[d#e]].\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});

// ─── Input rule: typing [[…]] converts on the closing bracket ───────────────
import { TextSelection } from "../pm";

describe("typing [[target]] should create a wiki_link atom", () => {
    /** Simulate typing through the input-rule runner (linkInputRule.test.ts pattern). */
    function typeWithInputRules(v: EditorView, text: string): void {
        for (const ch of text) {
            const { from, to } = v.state.selection;
            const handled = v.someProp("handleTextInput", (f) => f(v, from, to, ch));
            if (!handled) {
                v.dispatch(v.state.tr.insertText(ch, from, to));
            }
        }
    }

    function placeCursorAtEnd(v: EditorView): void {
        const end = v.state.doc.content.size - 1;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)));
    }

    it("converts on the closing bracket and serializes verbatim", async () => {
        const { editor, view } = await makeEditor("start\n");
        placeCursorAtEnd(view);
        typeWithInputRules(view, " [[my page#head|shown]]");

        let found: string | null = null;
        view.state.doc.descendants((node) => {
            if (node.type.name === "wiki_link") found = node.attrs["raw"] as string;
        });
        expect(found).toBe("my page#head|shown");
        expect(editor.action(getMarkdown())).toBe("start [[my page#head|shown]]\n");
        await editor.destroy();
    });

    it("does not convert single brackets", async () => {
        const { editor, view } = await makeEditor("start\n");
        placeCursorAtEnd(view);
        typeWithInputRules(view, " [not a wiki]");

        let count = 0;
        view.state.doc.descendants((node) => {
            if (node.type.name === "wiki_link") count++;
        });
        expect(count).toBe(0);
        await editor.destroy();
    });
});
