/**
 * `<details>` disclosures: an opener html block, the blank-line-separated
 * Markdown body, and a `</details>` html block parse to ONE `details` node
 * and serialize back to the source bytes. Real Milkdown editor with the
 * production serialization config and the production NodeView. Byte
 * round-trips cannot tell a converted details from three inert siblings, so
 * every shape also pins the parse.
 */
import { describe, it, expect } from "vitest";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
    nodeViewCtx,
    commandsCtx,
} from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import type { Node as PMNode } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    escapeSummary,
    insertDetailsCommand,
    openerWithSummary,
    parseOpener,
} from "../plugins/details";
import { createDetailsView } from "../components/details";
import { seedSyntaxFolds } from "../plugins/headingFold/foldAnchors";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

async function makeEditor(markdown: string): Promise<{ editor: Editor; view: EditorView }> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
            ctx.set(nodeViewCtx, [["details", createDetailsView]]);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(insertDetailsCommand)
        .create();
    return { editor, view: editor.action((ctx) => ctx.get(editorViewCtx)) };
}

async function roundTrip(markdown: string): Promise<string> {
    const { editor } = await makeEditor(markdown);
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

function findDetails(view: EditorView): { node: PMNode; pos: number }[] {
    const found: { node: PMNode; pos: number }[] = [];
    view.state.doc.descendants((node, pos) => {
        if (node.type.name === "details") found.push({ node, pos });
        return true;
    });
    return found;
}

const GITHUB = "<details>\n<summary>Timestamps</summary>\n\n- one\n- two\n\n</details>\n";

describe("parseOpener", () => {
    it("the three summary placements and none should all be read", () => {
        expect(parseOpener("<details>\n<summary>A</summary>")).toEqual({ open: false, summary: "A" });
        expect(parseOpener("<details><summary>A</summary>")).toEqual({ open: false, summary: "A" });
        expect(parseOpener("<details>\n\n<summary>A</summary>")).toEqual({ open: false, summary: "A" });
        expect(parseOpener("<details>")).toEqual({ open: false, summary: null });
    });

    it("an open attribute in any spelling should read as open", () => {
        for (const tag of ["<details open>", "<details  open>", '<details open="">', "<DETAILS OPEN>"]) {
            expect(parseOpener(tag)?.open, tag).toBe(true);
        }
    });

    it("a summary holding markup or a foreign attribute should be outside the grammar", () => {
        expect(parseOpener("<details>\n<summary><b>A</b></summary>")).toBeNull();
        expect(parseOpener('<details class="x">')).toBeNull();
        expect(parseOpener("<details>\ntext")).toBeNull();
    });

    it("entities in the summary should decode for display", () => {
        expect(parseOpener("<details><summary>Q&amp;A &lt;3 &#x1F600;</summary>")?.summary).toBe("Q&A <3 😀");
    });
});

describe("openerWithSummary", () => {
    it("a changed summary should keep the tag and the placement", () => {
        expect(openerWithSummary("<details open>\n<summary>A</summary>", "B")).toBe("<details open>\n<summary>B</summary>");
        expect(openerWithSummary("<details><summary>A</summary>", "B")).toBe("<details><summary>B</summary>");
        expect(openerWithSummary("<details>\n\n<summary>A</summary>", "B")).toBe("<details>\n\n<summary>B</summary>");
    });

    it("a summary added to a bare opener should go on the next line", () => {
        expect(openerWithSummary("<details>", "New")).toBe("<details>\n<summary>New</summary>");
    });

    it("an emptied summary should remove the element", () => {
        expect(openerWithSummary("<details open>\n<summary>A</summary>", "  ")).toBe("<details open>");
        expect(openerWithSummary("<details>\n\n<summary>A</summary>", "")).toBe("<details>");
    });

    it("typed markup should be escaped so it reads back as text", () => {
        const opener = openerWithSummary("<details>", "a </summary> & b");
        expect(opener).toBe(`<details>\n<summary>${escapeSummary("a </summary> & b")}</summary>`);
        expect(parseOpener(opener)?.summary).toBe("a </summary> & b");
    });
});

describe("details parse and round-trip", () => {
    const shapes: [string, string][] = [
        ["GitHub's shape", GITHUB],
        ["summary on the opener's line", "<details><summary>T</summary>\n\nBody **bold**.\n\n</details>\n"],
        ["summary as its own block", "<details>\n\n<summary>T</summary>\n\nBody.\n\n</details>\n"],
        ["no summary", "<details>\n\nBody.\n\n</details>\n"],
        ["open", "<details open>\n<summary>T</summary>\n\nBody.\n\n</details>\n"],
        ["empty body", "<details>\n<summary>T</summary>\n\n</details>\n"],
        ["between paragraphs", "Before.\n\n<details>\n<summary>T</summary>\n\nBody.\n\n</details>\n\nAfter.\n"],
    ];
    for (const [name, source] of shapes) {
        it(`${name} should parse to one details node and round-trip byte-identically`, async () => {
            const { editor, view } = await makeEditor(source);
            expect(findDetails(view)).toHaveLength(1);
            let html = 0;
            view.state.doc.descendants((node) => {
                if (node.type.name === "html") html++;
                return true;
            });
            expect(html, "no tag should be left behind as an inert html block").toBe(0);
            expect(editor.action(getMarkdown())).toBe(source);
            await editor.destroy();
        });
    }

    it("GitHub's shape should carry its summary and its body as Markdown", async () => {
        const { editor, view } = await makeEditor(GITHUB);
        const [{ node }] = findDetails(view) as [{ node: PMNode }];
        expect(node.attrs["summary"]).toBe("Timestamps");
        expect(node.attrs["open"]).toBe(false);
        expect(node.firstChild?.type.name).toBe("bullet_list");
        await editor.destroy();
    });

    it("a details nested in a details should pair inside-out", async () => {
        const source =
            "<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nDeep.\n\n</details>\n\nTail.\n\n</details>\n";
        const { editor, view } = await makeEditor(source);
        const found = findDetails(view);
        expect(found.map((d) => d.node.attrs["summary"])).toEqual(["Outer", "Inner"]);
        expect(found[0]!.node.lastChild?.textContent).toBe("Tail.");
        expect(editor.action(getMarkdown())).toBe(source);
        await editor.destroy();
    });

    it("a details inside a list item should parse and round-trip", async () => {
        const source = "- item\n\n  <details>\n  <summary>T</summary>\n\n  Body.\n\n  </details>\n";
        const { editor, view } = await makeEditor(source);
        expect(findDetails(view)).toHaveLength(1);
        expect(editor.action(getMarkdown())).toBe(source);
        await editor.destroy();
    });

    it("an indented summary should stay the code block CommonMark makes it", async () => {
        // The shape a generator writes when it indents the inside of the
        // tags: four spaces after a blank line is code in every renderer.
        const source = "<details>\n\n    <summary>Timestamps</summary>\n\n    - `00:04` Testing.\n\n</details>\n";
        const { editor, view } = await makeEditor(source);
        const [{ node }] = findDetails(view) as [{ node: PMNode }];
        expect(node.attrs["hasSummary"]).toBe(false);
        expect(node.firstChild?.type.name).toBe("code_block");
        // The serializer spells the code block fenced; a zero-edit save keeps
        // the indented source, which is the promise that matters here.
        const serialized = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(source, serialized);
        expect(applyMinimalChanges(source, serialized, protection)).toBe(source);
        await editor.destroy();
    });

    const inert: [string, string][] = [
        ["unclosed", "<details>\n<summary>T</summary>\n\nBody.\n"],
        ["one html block", "<details>\n<summary>T</summary>\nBody.\n</details>\n"],
        ["a summary with markup", "<details>\n<summary><b>T</b></summary>\n\nBody.\n\n</details>\n"],
    ];
    for (const [name, source] of inert) {
        it(`${name} should stay inert html and round-trip byte-identically`, async () => {
            const { editor, view } = await makeEditor(source);
            expect(findDetails(view)).toHaveLength(0);
            expect(editor.action(getMarkdown())).toBe(source);
            await editor.destroy();
        });
    }
});

describe("details folds", () => {
    it("a closed details should seed folded and an open one should not", async () => {
        const source =
            "<details>\n<summary>Closed</summary>\n\nA.\n\n</details>\n\n<details open>\n<summary>Open</summary>\n\nB.\n\n</details>\n";
        const { editor, view } = await makeEditor(source);
        const [closed, open] = findDetails(view) as [{ pos: number }, { pos: number }];
        const seeded = seedSyntaxFolds(view.state.doc);
        expect(seeded.has(closed.pos)).toBe(true);
        expect(seeded.has(open.pos)).toBe(false);
        await editor.destroy();
    });
});

describe("summary editing", () => {
    it("a typed summary should rewrite only the summary bytes", async () => {
        const { editor, view } = await makeEditor(GITHUB);
        const summary = view.dom.querySelector(".details-summary-text") as HTMLElement;
        summary.focus();
        summary.textContent = "Times & places";
        summary.dispatchEvent(new FocusEvent("blur"));
        expect(editor.action(getMarkdown())).toBe(
            "<details>\n<summary>Times &amp; places</summary>\n\n- one\n- two\n\n</details>\n",
        );
        await editor.destroy();
    });
});

describe("insertDetails", () => {
    it("the command should wrap the caret's paragraph and serialize GitHub's shape", async () => {
        const { editor, view } = await makeEditor("Hello.\n");
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
        const ok = editor.action((ctx) => ctx.get(commandsCtx).call(insertDetailsCommand.key as never));
        expect(ok).toBe(true);
        expect(findDetails(view)).toHaveLength(1);
        expect(editor.action(getMarkdown())).toBe("<details>\n\nHello.\n\n</details>\n");
        await editor.destroy();
    });
});
