/**
 * Callouts (MAR-27): `> [!TYPE]` blockquotes parse to callout nodes and
 * serialize back to the exact source bytes. Drives the REAL Milkdown editor
 * with the production serialization config — no mocks (the wikiLinks.test.ts
 * harness). Byte-identity is the design contract (raw marker bytes), so most
 * tests are round-trip equalities.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, commandsCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { configureSerialization, pureCommonmark } from "../serialization";
import {
    calloutKind,
    insertCalloutCommand,
    markerWithKind,
    parseCalloutMarker,
} from "../plugins/callouts";

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
        .use(gfm)
        .use(insertCalloutCommand)
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

/** First callout node in the doc (with its attrs), or null. */
function findCallout(view: EditorView): PMNode | null {
    let found: PMNode | null = null;
    view.state.doc.descendants((node) => {
        if (!found && node.type.name === "callout") found = node;
        return !found;
    });
    return found;
}

describe("parseCalloutMarker", () => {
    it("parses type, fold, and raw title bytes", () => {
        expect(parseCalloutMarker("[!NOTE]")).toMatchObject({
            rawType: "NOTE", kind: "note", fold: "", rest: "", title: "",
        });
        expect(parseCalloutMarker("[!tip]- My title")).toMatchObject({
            rawType: "tip", kind: "tip", fold: "-", rest: " My title", title: "My title",
        });
        expect(parseCalloutMarker("[!faq]+  spaced")).toMatchObject({
            kind: "question", fold: "+", rest: "  spaced", title: "spaced",
        });
    });

    it("unescapes backslashes in the display title only", () => {
        const parts = parseCalloutMarker("[!note] a \\*literal\\* star");
        expect(parts?.title).toBe("a *literal* star");
        expect(parts?.rest).toBe(" a \\*literal\\* star");
    });

    it("rejects non-marker lines", () => {
        expect(parseCalloutMarker("[!]")).toBeNull();
        expect(parseCalloutMarker("[!123]")).toBeNull();
        expect(parseCalloutMarker("[! NOTE]")).toBeNull();
        expect(parseCalloutMarker("[!NOTE]x")).toBeNull();
        expect(parseCalloutMarker("text [!NOTE]")).toBeNull();
    });
});

describe("calloutKind", () => {
    it("resolves Obsidian aliases onto canonical kinds", () => {
        expect(calloutKind("TLDR")).toBe("abstract");
        expect(calloutKind("hint")).toBe("tip");
        expect(calloutKind("error")).toBe("danger");
        expect(calloutKind("attention")).toBe("warning");
        expect(calloutKind("cite")).toBe("quote");
    });

    it("unknown types fall back to note styling", () => {
        expect(calloutKind("custom-type")).toBe("note");
    });
});

describe("markerWithKind", () => {
    it("preserves fold, raw title bytes, and case convention", () => {
        expect(markerWithKind("[!NOTE]", "warning")).toBe("[!WARNING]");
        expect(markerWithKind("[!note]- My title", "danger")).toBe("[!danger]- My title");
        expect(markerWithKind("[!TIP]  two spaces", "caution")).toBe("[!CAUTION]  two spaces");
    });
});

describe("fixture parse census", () => {
    // Byte round-trips CANNOT catch a mis-parse that serializes identically
    // (a callout and a plain blockquote emit the same bytes), so the corpus
    // fixture is additionally pinned to its exact expected parse.
    it("callouts.md parses to exactly the expected callouts and blockquotes", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const content = readFileSync(join(__dirname, "fixtures", "callouts.md"), "utf8");
        const { editor, view } = await makeEditor(content);

        const kinds: string[] = [];
        let blockquotes = 0;
        view.state.doc.descendants((node) => {
            if (node.type.name === "callout") kinds.push(node.attrs["kind"] as string);
            if (node.type.name === "blockquote") blockquotes++;
            return true;
        });
        expect(kinds).toEqual([
            "note", "tip", "important", "warning", "caution",
            "note",           // [!note] with title
            "tip",            // [!tip]- folded
            "question",       // [!faq]+ (alias)
            "abstract",       // blank-line separated
            "note",           // [!custom-type] → neutral fallback
            "note",           // bare [!NOTE]
            "success", "bug", // nested pair
        ]);
        // The three deliberate degradations stay plain blockquotes:
        // formatted marker line, escaped marker, and the regular quote.
        expect(blockquotes).toBe(3);
        await editor.destroy();
    });
});

describe("callout parsing", () => {
    it("a GitHub alert becomes a callout node with derived attrs", async () => {
        const { editor, view } = await makeEditor("> [!NOTE]\n> Body text.\n");
        const node = findCallout(view);
        expect(node).not.toBeNull();
        expect(node!.attrs["kind"]).toBe("note");
        expect(node!.attrs["marker"]).toBe("[!NOTE]");
        expect(node!.attrs["attached"]).toBe(true);
        expect(node!.attrs["title"]).toBe("");
        await editor.destroy();
    });

    it("an Obsidian callout keeps title, fold, and alias-resolved kind", async () => {
        const { editor, view } = await makeEditor("> [!hint]- Pro tip\n> Body.\n");
        const node = findCallout(view);
        expect(node!.attrs["kind"]).toBe("tip");
        expect(node!.attrs["rawType"]).toBe("hint");
        expect(node!.attrs["fold"]).toBe("-");
        expect(node!.attrs["title"]).toBe("Pro tip");
        await editor.destroy();
    });

    it("a blank-line-separated body records attached=false", async () => {
        const { editor, view } = await makeEditor("> [!abstract]\n>\n> Separate body.\n");
        const node = findCallout(view);
        expect(node!.attrs["attached"]).toBe(false);
        await editor.destroy();
    });

    it("a formatted marker line stays a plain blockquote", async () => {
        const { editor, view } = await makeEditor("> [!NOTE] a **bold** title\n> Body.\n");
        expect(findCallout(view)).toBeNull();
        await editor.destroy();
    });

    it("an escaped \\[!NOTE] marker stays a plain blockquote", async () => {
        const { editor, view } = await makeEditor("> \\[!NOTE] not a callout\n");
        expect(findCallout(view)).toBeNull();
        await editor.destroy();
    });

    it("a plain blockquote is untouched", async () => {
        const { editor, view } = await makeEditor("> Just a quote.\n");
        expect(findCallout(view)).toBeNull();
        await editor.destroy();
    });

    it("[!NOTE] outside a blockquote stays prose", async () => {
        const { editor, view } = await makeEditor("Text with [!NOTE] inline.\n");
        expect(findCallout(view)).toBeNull();
        await editor.destroy();
    });

    it("nested callouts parse on both levels", async () => {
        const { editor, view } = await makeEditor(
            "> [!success] Outer\n> Body.\n>\n> > [!bug] Inner\n> > Inner body.\n",
        );
        let count = 0;
        view.state.doc.descendants((node) => {
            if (node.type.name === "callout") count++;
            return true;
        });
        expect(count).toBe(2);
        await editor.destroy();
    });
});

describe("callout round-trip byte-identity", () => {
    const FORMS = [
        "> [!NOTE]\n> Attached body.\n",
        "> [!TIP]\n> Tip body.\n",
        "> [!IMPORTANT]\n> Important body.\n",
        "> [!WARNING]\n> Warning body.\n",
        "> [!CAUTION]\n> Caution body.\n",
        "> [!note] Title here\n> Body.\n",
        "> [!tip]- Folded title\n> Body.\n",
        "> [!faq]+ Open fold\n> Body.\n",
        "> [!abstract]\n>\n> Blank-line separated body.\n",
        "> [!custom-type] Unknown kind\n> Body.\n",
        "> [!NOTE]\n",
        "> [!note]   Extra marker spacing\n> Body.\n",
        "> [!danger] Multi-paragraph\n> First.\n>\n> Second.\n",
        "> [!success] Outer\n> Body.\n>\n> > [!bug] Inner\n> > Inner body.\n",
        "> [!note] Escaped \\*title\\* bytes\n> Body.\n",
    ];

    for (const form of FORMS) {
        it(`round-trips ${JSON.stringify(form.split("\n")[0])} byte-identically`, async () => {
            expect(await roundTrip(form)).toBe(form);
        });
    }

    it("round-trips a callout between other blocks unchanged", async () => {
        const doc = "Before.\n\n> [!WARNING] Careful\n> Watch out.\n\nAfter.\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});

describe("typing [!kind] in a blockquote should convert it (input rule)", () => {
    function typeWithInputRules(v: EditorView, text: string): void {
        for (const ch of text) {
            const { from, to } = v.state.selection;
            const handled = v.someProp("handleTextInput", (f) => f(v, from, to, ch));
            if (!handled) {
                v.dispatch(v.state.tr.insertText(ch, from, to));
            }
        }
    }

    it("converts the blockquote and strips the typed marker", async () => {
        const { editor, view } = await makeEditor("> body\n");
        // Place the caret at the start of the blockquote's paragraph.
        let paraPos = -1;
        view.state.doc.descendants((node, pos) => {
            if (paraPos < 0 && node.type.name === "paragraph") paraPos = pos;
            return paraPos < 0;
        });
        view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, paraPos + 1)),
        );
        typeWithInputRules(view, "[!warning] ");

        const node = findCallout(view);
        expect(node).not.toBeNull();
        expect(node!.attrs["kind"]).toBe("warning");
        expect(editor.action(getMarkdown())).toBe("> [!warning]\n> body\n");
        await editor.destroy();
    });

    it("does not convert in a plain paragraph", async () => {
        const { editor, view } = await makeEditor("start\n");
        const end = view.state.doc.content.size - 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
        typeWithInputRules(view, " [!note] ");
        expect(findCallout(view)).toBeNull();
        await editor.destroy();
    });
});

describe("insertCallout command", () => {
    it("wraps the current block in an uppercase GitHub-style note", async () => {
        const { editor, view } = await makeEditor("some text\n");
        const end = view.state.doc.content.size - 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
        editor.action((ctx) => {
            ctx.get(commandsCtx).call(insertCalloutCommand.key as never);
        });
        const node = findCallout(view);
        expect(node).not.toBeNull();
        expect(node!.attrs["marker"]).toBe("[!NOTE]");
        expect(editor.action(getMarkdown())).toBe("> [!NOTE]\n> some text\n");
        await editor.destroy();
    });

    it("inserts extended kinds lowercase (Obsidian convention)", async () => {
        const { editor, view } = await makeEditor("faq body\n");
        const end = view.state.doc.content.size - 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
        editor.action((ctx) => {
            ctx.get(commandsCtx).call(insertCalloutCommand.key as never, "question");
        });
        const node = findCallout(view);
        expect(node!.attrs["marker"]).toBe("[!question]");
        await editor.destroy();
    });
});

describe("editing inside a callout", () => {
    it("body edits serialize under the unchanged marker", async () => {
        const { editor, view } = await makeEditor("> [!TIP] Stable title\n> Body.\n");
        // Append text at the end of the callout body.
        let textEnd = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === "Body.") textEnd = pos + node.nodeSize;
            return true;
        });
        expect(textEnd).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.insertText(" More.", textEnd));
        expect(editor.action(getMarkdown())).toBe("> [!TIP] Stable title\n> Body. More.\n");
        await editor.destroy();
    });
});
