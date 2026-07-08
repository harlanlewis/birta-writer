/**
 * Notion aside callouts: `<aside>` html-block pairs from Notion's markdown
 * export parse to notion_callout nodes and serialize back to the exact
 * source bytes. Real Milkdown editor with the production serialization
 * config (the wikiLinks/callouts harness) plus the production NodeView.
 * Byte-identity is the design contract; the fixture census pins exact
 * parses because byte round-trips can't distinguish a converted aside from
 * an inert one.
 */
import { describe, it, expect } from "vitest";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
    nodeViewCtx,
} from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { configureSerialization, pureCommonmark } from "../serialization";
import { extractIcon, kindForIcon } from "../plugins/notionCallouts";
import { createNotionCalloutView } from "../components/callout";

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
            ctx.set(nodeViewCtx, [["notion_callout", createNotionCalloutView]]);
        })
        .use(pureCommonmark)
        .use(gfm)
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

function findAsides(view: EditorView): PMNode[] {
    const found: PMNode[] = [];
    view.state.doc.descendants((node) => {
        if (node.type.name === "notion_callout") found.push(node);
        return true;
    });
    return found;
}

describe("extractIcon / kindForIcon", () => {
    it("splits a leading emoji, including variation-selector forms", () => {
        expect(extractIcon("💡 Tip text")).toEqual({ icon: "💡", rest: "Tip text" });
        expect(extractIcon("⚠️ Watch out")).toEqual({ icon: "⚠️", rest: "Watch out" });
        expect(extractIcon("No emoji here")).toEqual({ icon: "", rest: "No emoji here" });
        // Emoji without a following space is content, not an icon…
        expect(extractIcon("💡Tight")).toEqual({ icon: "", rest: "💡Tight" });
        // …but an emoji ALONE is the icon of an emptied callout (regression:
        // without this, a saved empty callout demoted its icon to body text).
        expect(extractIcon("💡")).toEqual({ icon: "💡", rest: "" });
    });

    it("maps known icons to kinds and unknown/none to note", () => {
        expect(kindForIcon("💡")).toBe("tip");
        expect(kindForIcon("⚠️")).toBe("warning"); // selector stripped for lookup
        expect(kindForIcon("🐛")).toBe("bug");
        expect(kindForIcon("🦄")).toBe("note");
        expect(kindForIcon("")).toBe("note");
    });
});

describe("aside parsing", () => {
    it("the canonical two-block shape becomes a callout with icon and kind", async () => {
        const { editor, view } = await makeEditor(
            "<aside>\n💡 Tip text with **bold**.\n\n</aside>\n",
        );
        const [node] = findAsides(view);
        expect(node).toBeDefined();
        expect(node!.attrs["icon"]).toBe("💡");
        expect(node!.attrs["kind"]).toBe("tip");
        expect(node!.attrs["closeGap"]).toBe(true);
        await editor.destroy();
    });

    it("the raw first segment's markdown is parsed (bold is a real mark)", async () => {
        const { editor, view } = await makeEditor(
            "<aside>\n💡 Text with **bold** inside.\n\n</aside>\n",
        );
        let bold = false;
        view.state.doc.descendants((node) => {
            if (node.isText && node.marks.some((m) => m.type.name === "strong")) bold = true;
            return true;
        });
        expect(bold).toBe(true);
        await editor.destroy();
    });

    it("a self-contained single block records closeGap=false", async () => {
        const { editor, view } = await makeEditor("<aside>\n🐛 One block.\n</aside>\n");
        const [node] = findAsides(view);
        expect(node!.attrs["closeGap"]).toBe(false);
        expect(node!.attrs["kind"]).toBe("bug");
        await editor.destroy();
    });

    it("between-blocks (paragraphs, lists) become the callout body", async () => {
        const { editor, view } = await makeEditor(
            "<aside>\n📝 Lead.\n\nSecond paragraph.\n\n- item one\n- item two\n\n</aside>\n",
        );
        const [node] = findAsides(view);
        expect(node!.childCount).toBe(3); // paragraph, paragraph, list
        await editor.destroy();
    });

    it("an emoji-less aside converts with neutral kind", async () => {
        const { editor, view } = await makeEditor("<aside>\nJust text.\n\n</aside>\n");
        const [node] = findAsides(view);
        expect(node!.attrs["icon"]).toBe("");
        expect(node!.attrs["kind"]).toBe("note");
        await editor.destroy();
    });

    it("the <img> icon variant stays inert html", async () => {
        const { editor, view } = await makeEditor(
            '<aside>\n<img src="https://www.notion.so/icons/token_blue.svg" alt="i" width="40px" />\n\n**Title**\n\n</aside>\n',
        );
        expect(findAsides(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("an unclosed aside stays inert html", async () => {
        const { editor, view } = await makeEditor("<aside>\n💡 Never closed.\n\nProse.\n");
        expect(findAsides(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("an opener followed immediately by a blank line stays inert html", async () => {
        const { editor, view } = await makeEditor("<aside>\n\n💡 Detached.\n\n</aside>\n");
        expect(findAsides(view)).toHaveLength(0);
        await editor.destroy();
    });
});

describe("aside round-trip byte-identity", () => {
    const FORMS = [
        "<aside>\n💡 Canonical shape with **bold**.\n\n</aside>\n",
        "<aside>\n⚠️ Variation-selector emoji.\n\n</aside>\n",
        "<aside>\n🐛 Self-contained, no blank before closer.\n</aside>\n",
        // Tight list inside an aside body stays tight (MAR-48): no blank lines
        // appear between the list items on a raw round trip.
        "<aside>\n💡 Lead.\n\n- item\n- item two\n\n</aside>\n",
        "<aside>\n📝 Lead.\n\nSecond paragraph with a [link](https://example.com).\n\n> and a quote\n\n</aside>\n",
        "<aside>\nNo emoji at all.\n\n</aside>\n",
        "<aside>\n💡 Two raw lines\nbefore any blank.\n\n</aside>\n",
        // Degradations must round-trip untouched too:
        '<aside>\n<img src="https://www.notion.so/icons/x.svg" alt="i" width="40px" />\n\n**Title**\n\n</aside>\n',
        "<aside>\n💡 Unclosed.\n\nProse after.\n",
        "<aside>\n\n💡 Detached opener.\n\n</aside>\n",
    ];

    for (const form of FORMS) {
        it(`round-trips ${JSON.stringify(form.split("\n")[1])} byte-identically`, async () => {
            expect(await roundTrip(form)).toBe(form);
        });
    }

    it("round-trips an aside between other blocks unchanged", async () => {
        const doc = "Before.\n\n<aside>\n💡 Boxed.\n\n</aside>\n\nAfter.\n";
        expect(await roundTrip(doc)).toBe(doc);
    });
});

describe("editing inside an aside", () => {
    it("an emptied body keeps the emoji as the ICON across a save/reload cycle", async () => {
        // Regression (critique round): the saved form of an emptied callout
        // is `<aside>\n💡\n\n</aside>`; without the end-of-segment
        // alternative in ICON_RE the reload demoted 💡 to body text and the
        // accent was lost — bytes identical, semantics silently changed.
        const first = await makeEditor("<aside>\n💡 Body.\n\n</aside>\n");
        let from = -1, to = -1;
        first.view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === "Body.") { from = pos; to = pos + node.nodeSize; }
            return true;
        });
        first.view.dispatch(first.view.state.tr.delete(from, to));
        const saved = first.editor.action(getMarkdown());
        expect(saved).toBe("<aside>\n💡\n\n</aside>\n");
        await first.editor.destroy();

        const second = await makeEditor(saved);
        const [node] = findAsides(second.view);
        expect(node!.attrs["icon"]).toBe("💡");
        expect(node!.attrs["kind"]).toBe("tip");
        expect(second.editor.action(getMarkdown())).toBe(saved); // stable
        await second.editor.destroy();
    });

    it("our dialect syntax works inside the sub-parsed first segment", async () => {
        // The sub-parse runs on the SAME processor, so highlight marks and
        // wikilinks parse inside asides and round-trip byte-identically.
        const doc = "<aside>\n💡 A ==mark== and a [[wiki]] link.\n\n</aside>\n";
        const { editor, view } = await makeEditor(doc);
        let highlights = 0, wikilinks = 0;
        view.state.doc.descendants((node) => {
            if (node.isText && node.marks.some((m) => m.type.name === "highlight")) highlights++;
            if (node.type.name === "wiki_link") wikilinks++;
            return true;
        });
        expect(highlights).toBe(1);
        expect(wikilinks).toBe(1);
        expect(editor.action(getMarkdown())).toBe(doc);
        await editor.destroy();
    });

    it("an aside indented inside a list item stays inert (documented degradation)", async () => {
        // The html-block values carry the list indentation context; pairing
        // them is out of the verified grammar. (The blank-line indentation
        // churn in a strict re-serialization is the pre-existing stock list
        // behavior, pinned by minimalDiff protection at runtime.)
        const { editor, view } = await makeEditor(
            "- Toggle title\n    \n    <aside>\n    💡 Nested.\n    \n    </aside>\n",
        );
        expect(findAsides(view)).toHaveLength(0);
        await editor.destroy();
    });

    it("body edits serialize inside the aside without touching its shape", async () => {
        const { editor, view } = await makeEditor("<aside>\n💡 Body.\n\n</aside>\n");
        let textEnd = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.isText && node.text === "Body.") textEnd = pos + node.nodeSize;
            return true;
        });
        expect(textEnd).toBeGreaterThan(-1);
        view.dispatch(view.state.tr.insertText(" More.", textEnd));
        expect(editor.action(getMarkdown())).toBe("<aside>\n💡 Body. More.\n\n</aside>\n");
        await editor.destroy();
    });
});

describe("NodeView chrome", () => {
    it("renders the emoji icon read-only beside an editable body", async () => {
        const { editor, container } = await makeEditor(
            "<aside>\n⚠️ Careful now.\n\n</aside>\n",
        );
        const el = container.querySelector('[data-type="notion-callout"]') as HTMLElement;
        expect(el).not.toBeNull();
        expect(el.dataset["kind"]).toBe("warning");
        const icon = el.querySelector(".callout-aside-icon") as HTMLElement;
        expect(icon.textContent).toBe("⚠️");
        expect(icon.contentEditable).toBe("false"); // jsdom lacks isContentEditable
        expect(el.querySelector(".callout-aside-body")).not.toBeNull();
        await editor.destroy();
    });

    it("hides the icon slot when there is no emoji", async () => {
        const { editor, container } = await makeEditor("<aside>\nPlain.\n\n</aside>\n");
        const icon = container.querySelector(".callout-aside-icon") as HTMLElement;
        expect(icon.style.display).toBe("none");
        await editor.destroy();
    });
});

describe("cross-feature nesting inside asides", () => {
    // The between-blocks are ordinary parsed mdast, so the other dialect
    // transforms (registered after this one) must see and convert them —
    // and everything must still round-trip byte-identically.
    it("a GitHub marker callout nests inside an aside", async () => {
        const doc =
            "<aside>\n💡 Lead.\n\n> [!WARNING] Nested marker callout\n> Body.\n\n</aside>\n";
        const { editor, view } = await makeEditor(doc);
        let callouts = 0;
        view.state.doc.descendants((n) => {
            if (n.type.name === "callout") callouts++;
            return true;
        });
        expect(findAsides(view)).toHaveLength(1);
        expect(callouts).toBe(1);
        expect(editor.action(getMarkdown())).toBe(doc);
        await editor.destroy();
    });

    it("a container directive nests inside an aside", async () => {
        const doc = "<aside>\n💡 Lead.\n\n:::note Inner\nDirective body.\n:::\n\n</aside>\n";
        const { editor, view } = await makeEditor(doc);
        let directives = 0;
        view.state.doc.descendants((n) => {
            if (n.type.name === "container_directive") directives++;
            return true;
        });
        expect(findAsides(view)).toHaveLength(1);
        expect(directives).toBe(1);
        expect(editor.action(getMarkdown())).toBe(doc);
        await editor.destroy();
    });

    it("a block-math $$ nests inside an aside (verified Notion shape)", async () => {
        const doc = "<aside>\n💡 With math.\n\n$$\nE = mc^2\n$$\n\n</aside>\n";
        expect(await roundTrip(doc)).toBe(doc);
    });

    it("adjacent asides pair with their own closers, never across", async () => {
        const doc =
            "<aside>\n💡 First box.\n\n</aside>\n\n<aside>\n🐛 Second box.\n\n</aside>\n";
        const { editor, view } = await makeEditor(doc);
        expect(findAsides(view).map((n) => n.attrs["icon"])).toEqual(["💡", "🐛"]);
        expect(editor.action(getMarkdown())).toBe(doc);
        await editor.destroy();
    });
});

describe("fixture parse census", () => {
    it("notion-asides.md parses to exactly the expected asides", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const content = readFileSync(join(__dirname, "fixtures", "notion-asides.md"), "utf8");
        const { editor, view } = await makeEditor(content);

        const icons = findAsides(view).map((n) => n.attrs["icon"]);
        expect(icons).toEqual(["💡", "⚠️", "🐛", "📝", "", "💡"]);
        // The img variant and the unclosed aside stay inert html.
        const htmlValues: string[] = [];
        view.state.doc.descendants((node) => {
            if (node.type.name === "html") htmlValues.push(node.attrs["value"] as string);
            return true;
        });
        expect(htmlValues.some((v) => v.includes("notion.so/icons"))).toBe(true);
        expect(htmlValues.some((v) => v.includes("Never") || v.includes("unclosed"))).toBe(true);
        await editor.destroy();
    });
});
