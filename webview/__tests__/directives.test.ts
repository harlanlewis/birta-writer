/**
 * Container directives: `:::name … :::` paragraph runs parse to
 * container_directive nodes and serialize back to the exact source bytes.
 * Real Milkdown editor with the production serialization config (the
 * wikiLinks/callouts harness) — byte-identity is the design contract.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import type { Node as PMNode } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    closeFenceColons,
    directiveTitle,
    parseOpenFence,
} from "../plugins/directives";

async function makeEditor(markdown: string): Promise<{
    editor: Editor;
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
    return { editor, view };
}

async function roundTrip(markdown: string): Promise<string> {
    const { editor } = await makeEditor(markdown);
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

function findDirectives(view: EditorView): PMNode[] {
    const found: PMNode[] = [];
    view.state.doc.descendants((node) => {
        if (node.type.name === "container_directive") found.push(node);
        return true;
    });
    return found;
}

describe("parseOpenFence / closeFenceColons / directiveTitle", () => {
    it("parses name, colon count, and raw rest", () => {
        expect(parseOpenFence(":::note")).toEqual({ colons: 3, name: "note", rest: "" });
        expect(parseOpenFence("::::tip A title")).toEqual({
            colons: 4, name: "tip", rest: " A title",
        });
        expect(parseOpenFence(':::info{title="x"}')).toEqual({
            colons: 3, name: "info", rest: '{title="x"}',
        });
    });

    it("rejects non-fences: spaced names, escapes, references, short fences", () => {
        expect(parseOpenFence("::: note")).toBeNull();
        expect(parseOpenFence("::note")).toBeNull();
        expect(parseOpenFence(":::note \\*x\\*")).toBeNull();
        expect(parseOpenFence(":::note a &amp; b")).toBeNull();
    });

    it("closing fences are colons only", () => {
        expect(closeFenceColons(":::")).toBe(3);
        expect(closeFenceColons("::::")).toBe(4);
        expect(closeFenceColons("::: x")).toBe(0);
        expect(closeFenceColons("::")).toBe(0);
    });

    it("directiveTitle strips a trailing attribute block", () => {
        expect(directiveTitle(" My title")).toBe("My title");
        expect(directiveTitle(' Title {title="x"}')).toBe("Title");
        expect(directiveTitle('{title="x"}')).toBe("");
    });
});

describe("fixture parse census", () => {
    // Pins directives.md to its exact expected parse — byte round-trips
    // can't distinguish a directive from the same lines as plain paragraphs.
    it("directives.md parses to exactly the expected directives", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const content = readFileSync(join(__dirname, "fixtures", "directives.md"), "utf8");
        const { editor, view } = await makeEditor(content);

        const names: string[] = [];
        view.state.doc.descendants((node) => {
            if (node.type.name === "container_directive") {
                names.push(node.attrs["name"] as string);
            }
            return true;
        });
        expect(names).toEqual([
            "note", "tip", "warning", "info",
            "danger", "note",   // nested pair (outer 4-colon, inner 3)
            "note",             // multi-block body
            "caution",
            "note",             // footnote reference inside, definition outside
            "note",             // footnote reference AND definition both inside, blank line before close
            // Close fences a lazy continuation swallowed (MAR-362).
            "note",             // ... under a footnote definition
            "note",             // ... under a list item
            "note",             // ... under a blockquote
        ]);
        // The unclosed fence and the spaced name stay ordinary text.
        expect(names).not.toContain("unclosed");
        expect(view.state.doc.textContent).toContain(":::unclosed");
        await editor.destroy();
    });
});

describe("directive parsing", () => {
    it("a single-paragraph directive parses with attached fences", async () => {
        const { editor, view } = await makeEditor(":::note\nBody text.\n:::\n");
        const [node] = findDirectives(view);
        expect(node).toBeDefined();
        expect(node!.attrs["name"]).toBe("note");
        expect(node!.attrs["openFence"]).toBe(":::note");
        expect(node!.attrs["closeFence"]).toBe(":::");
        expect(node!.attrs["openAttached"]).toBe(true);
        expect(node!.attrs["closeAttached"]).toBe(true);
        await editor.destroy();
    });

    it("a titled fence records the display title", async () => {
        const { editor, view } = await makeEditor(":::tip Pro tip\nBody.\n:::\n");
        const [node] = findDirectives(view);
        expect(node!.attrs["title"]).toBe("Pro tip");
        await editor.destroy();
    });

    it("blank-line separated fences record detached flags", async () => {
        const { editor, view } = await makeEditor(":::warning\n\nBody.\n\n:::\n");
        const [node] = findDirectives(view);
        expect(node!.attrs["openAttached"]).toBe(false);
        expect(node!.attrs["closeAttached"]).toBe(false);
        await editor.destroy();
    });

    it("multi-block content (paragraphs + list) is contained", async () => {
        const { editor, view } = await makeEditor(
            ":::note\nFirst.\n\nSecond.\n\n- item\n\n:::\n",
        );
        const nodes = findDirectives(view);
        expect(nodes).toHaveLength(1);
        expect(nodes[0]!.childCount).toBe(3);
        await editor.destroy();
    });

    it("4-colon fences nest a 3-colon directive inside", async () => {
        const { editor, view } = await makeEditor(
            "::::danger Outer\nOuter body.\n\n:::note Inner\nInner body.\n:::\n\n::::\n",
        );
        const nodes = findDirectives(view);
        expect(nodes).toHaveLength(2);
        const names = nodes.map((n) => n.attrs["name"]);
        expect(names).toContain("danger");
        expect(names).toContain("note");
        await editor.destroy();
    });

    it("an unclosed fence stays ordinary paragraphs", async () => {
        const { editor, view } = await makeEditor(":::note\nNo closer here.\n");
        expect(findDirectives(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("a spaced name is not a directive", async () => {
        const { editor, view } = await makeEditor("::: note\nBody.\n:::\n");
        expect(findDirectives(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("a formatted fence line is not a directive", async () => {
        const { editor, view } = await makeEditor(":::note **bold** rest\nBody.\n:::\n");
        expect(findDirectives(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("directives inside a blockquote parse too", async () => {
        const { editor, view } = await makeEditor("> :::note\n> Quoted body.\n> :::\n");
        expect(findDirectives(view)).toHaveLength(1);
        await editor.destroy();
    });
});

describe("directive round-trip byte-identity", () => {
    const FORMS = [
        ":::note\nBody text.\n:::\n",
        ":::tip Pro tip title\nBody.\n:::\n",
        ":::warning\n\nDetached body.\n\n:::\n",
        ':::info{title="Attrs"}\nBody.\n:::\n',
        ":::note\nFirst.\n\nSecond with **bold**.\n\n:::\n",
        // Tight list inside a directive body stays tight (MAR-48): no blank
        // lines appear between the list items on a raw round trip.
        ":::note\n\n- item\n- item two\n\n:::\n",
        // Fence adjacent to a non-paragraph block (no blank lines anywhere).
        ":::note\n```js\ncode();\n```\n:::\n",
        "::::danger Outer\nOuter.\n\n:::note Inner\nInner.\n:::\n\n::::\n",
        ":::note\n:::\n",
        ":::note\nAttached open.\n\n:::\n",
        ":::note\n\nDetached open, attached close.\n:::\n",
        ":::note\nNo closer stays text.\n",
        "::: note\nSpaced name stays text.\n:::\n",
        "> :::note\n> Quoted body.\n> :::\n",
    ];

    for (const form of FORMS) {
        it(`round-trips ${JSON.stringify(form.split("\n")[0])} byte-identically`, async () => {
            expect(await roundTrip(form)).toBe(form);
        });
    }

    it("round-trips a directive between other blocks unchanged", async () => {
        const doc = "Before.\n\n:::tip Careful\nWatch out.\n:::\n\nAfter.\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});

describe("typing :::name should convert an empty paragraph (input rule)", () => {
    function typeWithInputRules(v: EditorView, text: string): void {
        for (const ch of text) {
            const { from, to } = v.state.selection;
            const handled = v.someProp("handleTextInput", (f) => f(v, from, to, ch));
            if (!handled) {
                v.dispatch(v.state.tr.insertText(ch, from, to));
            }
        }
    }

    it("converts and serializes with attached fences", async () => {
        const { editor, view } = await makeEditor("before\n\nx\n");
        // Select the placeholder paragraph content ("x") and replace it.
        let xPos = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === "x") xPos = pos;
            return true;
        });
        view.dispatch(
            view.state.tr.setSelection(
                TextSelection.create(view.state.doc, xPos, xPos + 1),
            ),
        );
        typeWithInputRules(view, ":::note ");

        const nodes = findDirectives(view);
        expect(nodes).toHaveLength(1);
        expect(nodes[0]!.attrs["openFence"]).toBe(":::note");
        expect(editor.action(getMarkdown())).toBe("before\n\n:::note\n:::\n");
        await editor.destroy();
    });

    it("does not convert mid-paragraph", async () => {
        const { editor, view } = await makeEditor("start\n");
        const end = view.state.doc.content.size - 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
        typeWithInputRules(view, " :::note ");
        expect(findDirectives(view)).toHaveLength(0);
        await editor.destroy();
    });
});

describe("editing inside a directive", () => {
    it("body edits serialize inside the unchanged fences", async () => {
        const { editor, view } = await makeEditor(":::tip Stable\nBody.\n:::\n");
        let textEnd = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === "Body.") textEnd = pos + node.nodeSize;
            return true;
        });
        expect(textEnd).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.insertText(" More.", textEnd));
        expect(editor.action(getMarkdown())).toBe(":::tip Stable\nBody. More.\n:::\n");
        await editor.destroy();
    });
});

describe("nested directive fences (MAR-120 case A)", () => {
    // The outer fence must be strictly longer than any fence in its body, or
    // the inner directive's close fence closes the outer one on reparse and
    // the inner flattens. The serializer derives the length from the body.
    it("a nested directive round-trips with a longer outer fence", async () => {
        const doc = "::::note\nOuter.\n\n:::tip\nInner.\n:::\n\n::::\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("three levels of nesting keep each fence longer than the one it contains", async () => {
        const doc = ":::::a\nA.\n\n::::b\nB.\n\n:::c\nC.\n:::\n\n::::\n\n:::::\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("a nested directive parses as a directive (not flattened text)", async () => {
        const { editor, view } = await makeEditor("::::note\nOuter.\n\n:::tip\nInner.\n:::\n\n::::\n");
        const names: string[] = [];
        view.state.doc.descendants((node) => {
            if (node.type.name === "container_directive") names.push(node.attrs["name"] as string);
            return true;
        });
        expect(names).toEqual(["note", "tip"]);
        await editor.destroy();
    });
});

describe("footnotes inside a directive", () => {
    it("a footnote reference inside a directive, definition outside, round-trips and stays a directive", async () => {
        const doc = ":::note\nA note with a footnote reference[^dnote] inside it.\n:::\n\n[^dnote]: Definition for the footnote referenced inside a directive.\n";
        expect(await roundTrip(doc)).toBe(doc);
        const { editor, view } = await makeEditor(doc);
        expect(findDirectives(view).map((n) => n.attrs["name"])).toEqual(["note"]);
        await editor.destroy();
    });

    it("a footnote reference AND its definition both inside a directive, separated from the close fence by a blank line, round-trips and stays a directive", async () => {
        const doc = ":::note\nA note with a footnote reference[^dnote2] inside it.\n\n[^dnote2]: Definition also inside the directive.\n\n:::\n";
        expect(await roundTrip(doc)).toBe(doc);
        const { editor, view } = await makeEditor(doc);
        expect(findDirectives(view).map((n) => n.attrs["name"])).toEqual(["note"]);
        await editor.destroy();
    });

    const UNSPACED =
        ":::note\nA note with a footnote reference[^dnote3] inside it.\n\n[^dnote3]: Definition also inside the directive.\n:::\n";

    it("a footnote definition immediately followed by the close fence should still be a directive [MAR-362]", async () => {
        const { editor, view } = await makeEditor(UNSPACED);
        try {
            expect(findDirectives(view).map((n) => n.attrs["name"])).toEqual(["note"]);
        } finally {
            // The expect throws, so without this the jsdom container and a
            // live EditorView outlive the test.
            await editor.destroy();
        }
    });

    // A serializer-level assertion, not a disk-level one: the save path's
    // round-trip protection pins a zero-edit drift back to the saved bytes,
    // so a drift here does not on its own reach the file. Byte-identity is
    // the design contract anyway, and it is the layer protection sits on.
    it("a footnote definition before the close fence serializes the fence unindented [MAR-362]", async () => {
        expect(await roundTrip(UNSPACED)).toBe(UNSPACED);
    });
});

// MAR-362: a close fence written flush left with no blank line above it never
// reaches this transform as a fence paragraph. CommonMark lazy continuation
// folds the line into whatever paragraph is still open inside the block above,
// so the `:::` arrives as that paragraph's last soft line and the directive
// never closes. It is one class of bug, not one construct: footnote
// definitions, list items and blockquotes all swallow it identically.
describe("a close fence swallowed by a lazy continuation [MAR-362]", () => {
    async function expectOneNote(doc: string): Promise<void> {
        const { editor, view } = await makeEditor(doc);
        try {
            expect(findDirectives(view).map((n) => n.attrs["name"])).toEqual(["note"]);
        } finally {
            await editor.destroy();
        }
    }

    const SWALLOWED: Array<[string, string]> = [
        [
            "a footnote definition",
            ":::note\nRef[^dl1] here.\n\n[^dl1]: Definition inside the directive.\n:::\n",
        ],
        ["a list item", ":::note\n- a\n- b\n:::\n"],
        ["a nested list item", ":::note\n- a\n  - b\n:::\n"],
        ["a paragraph inside a list item", ":::note\n- a\n\n  second para\n:::\n"],
        ["a blockquote", ":::note\n> quoted\n:::\n"],
        ["a nested blockquote", ":::note\n> > deep\n:::\n"],
        [
            "a list item, in a directive nested inside a blockquote",
            "> :::note\n> - a\n> :::\n",
        ],
    ];

    for (const [what, doc] of SWALLOWED) {
        it(`${what} before the close fence should still close the directive`, async () => {
            await expectOneNote(doc);
        });

        it(`${what} before the close fence should round-trip byte-identically`, async () => {
            expect(await roundTrip(doc)).toBe(doc);
        });
    }

    // The repair takes the LAST paragraph of the block, so the fence has to be
    // split off the second definition rather than the first. Parse only: this
    // document also drifts a blank line BETWEEN the two definitions, which the
    // footnote serializer does with no directive anywhere in sight
    // (`Refs[^a][^b].\n\n[^a]: First.\n[^b]: Second.\n` round-trips the same
    // way), so asserting bytes here would pin somebody else's bug.
    it("the last of two footnote definitions is where the close fence is found", async () => {
        await expectOneNote(":::note\nRefs[^dl2][^dl3].\n\n[^dl2]: First.\n[^dl3]: Second.\n:::\n");
    });

    const CALLOUT = ":::note\n> [!NOTE]\n> Callout body.\n:::\n";

    it("a callout before the close fence should still close the directive", async () => {
        await expectOneNote(CALLOUT);
    });

    // The swallow was never why this drifted: `callouts.ts` built its callout
    // node without a `position`, so `linesAdjacent` could not see that the
    // callout starts on the line after the open fence and `openAttached` came
    // back false. It now carries the blockquote's span, which is why this
    // passes. The no-swallow control below shares that cause and holds it.
    it("a callout before the close fence should round-trip byte-identically", async () => {
        expect(await roundTrip(CALLOUT)).toBe(CALLOUT);
    });

    // The same drift with nothing swallowed at all: a blank line before the
    // close fence. It pins the `position` fix rather than the fence repair, so
    // a regression in either is attributable to one of them.
    it("a callout in a directive round-trips when nothing is swallowed", async () => {
        const doc = ":::note\n> [!NOTE]\n> Body.\n\n:::\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    // The reason the repair reads raw source. mdast strips a container's
    // indentation, so `    :::` inside a footnote definition and a swallowed
    // `:::` decode to the same paragraph text — and the first is content the
    // author wrote, not a fence. Delete the raw-line check in
    // `splitSwallowedClose` and every case here starts inventing a directive.
    const CONTENT: Array<[string, string]> = [
        [
            "an indented fence inside a footnote definition",
            ":::note\nRef[^dl4] here.\n\n[^dl4]: Definition.\n    :::\n",
        ],
        ["an indented fence inside a list item", ":::note\n- a\n  :::\n"],
        ["a quoted fence inside a blockquote", ":::note\n> q\n> :::\n"],
    ];

    for (const [what, doc] of CONTENT) {
        it(`${what} is content, so nothing becomes a directive`, async () => {
            const { editor, view } = await makeEditor(doc);
            try {
                expect(findDirectives(view)).toHaveLength(0);
                expect(view.state.doc.textContent).toContain(":::");
            } finally {
                await editor.destroy();
            }
        });
    }

    // Two flush-left fences absorbed by one block. The FIRST closes the
    // directive, but by parse time it is buried mid-paragraph and lifting it
    // back out to a block of its own would take a reparse. So the repair
    // declines: closing at the second instead would render an admonition with
    // the real fences as literal text inside it, which is worse than leaving
    // the run as the plain paragraphs it is today.
    it("two absorbed fences in one block decline the repair", async () => {
        const doc = ":::note\n- a\n:::\n:::tip\n- b\n:::\n";
        const { editor, view } = await makeEditor(doc);
        try {
            expect(findDirectives(view)).toHaveLength(0);
        } finally {
            await editor.destroy();
        }
    });

    // `notionCallouts.ts` builds an aside's lead blocks by sub-parsing a
    // SUBSTRING, so their positions are offsets into that substring and point
    // at unrelated bytes of the file. The byte offsets below are tuned so the
    // aside's `  :::` lands on the outer directive's close fence line: without
    // the transform declining to read source inside an aside, the repair reads
    // that line, believes the indented one is a fence, and deletes its indent.
    it("an aside's sub-parsed offsets never reach the source-reading repair", async () => {
        const doc = ":::xy\n- p\n\n:::\n\n<aside>\n💡 :::n\n- a\n  :::\n\n</aside>\n";
        const { editor, view } = await makeEditor(doc);
        try {
            expect(findDirectives(view).map((n) => n.attrs["name"])).toEqual(["xy"]);
            expect(editor.action(getMarkdown())).toContain("\n  :::\n");
        } finally {
            await editor.destroy();
        }
    });

    // Known gap, same class, different repair: GFM absorbs the line as a table
    // ROW rather than into a paragraph, so the paragraph-splitting repair
    // cannot reach it. An HTML block is the same shape. Flipping to green
    // means the case was fixed.
    it.fails("a table before the close fence is still swallowed", async () => {
        const doc = ":::note\n\n| a |\n| - |\n| b |\n:::\n";
        const { editor, view } = await makeEditor(doc);
        try {
            expect(findDirectives(view)).toHaveLength(1);
        } finally {
            await editor.destroy();
        }
    });
});
