/**
 * Type-creep insurance and unit coverage for the placement probe
 * (webview/blockPlacement.ts, MAR-115).
 *
 * The classification is `Record<EditorCommandId, BlockReach>`, so a new
 * command is a compile error until it is classified — but a Record proves
 * nothing about the list it was typed from, so the partition's size is
 * asserted against shared/editorCommands.ts here, the way readOnly.test.ts
 * does for the read-only gate.
 *
 * The walk itself is exercised against the REAL schema: the point of the
 * module is that it reads node specs rather than a hand-kept list, so a
 * hand-built schema would test the wrong thing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { Selection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { EDITOR_COMMANDS } from "../../shared/editorCommands";
import { COMMAND_BLOCK_REACH, canPlaceCommandBlock } from "../blockPlacement";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<Editor> {
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
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

function caretInText(editor: Editor, text: string): void {
    const v = view(editor);
    let pos = -1;
    v.state.doc.descendants((node, at) => {
        if (pos < 0 && node.isText && node.text?.includes(text)) { pos = at; }
    });
    if (pos < 0) { throw new Error(`fixture text not found: ${text}`); }
    v.dispatch(v.state.tr.setSelection(Selection.near(v.state.doc.resolve(pos + 1))));
}

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("command reach coverage", () => {
    it("every shared editor command should carry a reach classification", () => {
        const ids = EDITOR_COMMANDS.map((command) => command.id);
        const unclassified = ids.filter((id) => !(id in COMMAND_BLOCK_REACH));
        expect(unclassified).toEqual([]);
        // Size, not just membership: a Record can be satisfied by keys the
        // shared list no longer has.
        expect(Object.keys(COMMAND_BLOCK_REACH).sort()).toEqual([...ids].sort());
        expect(ids.length).toBeGreaterThanOrEqual(100);
    });

    it("the block-placing commands should be exactly the ones a schema can refuse", () => {
        const placing = Object.entries(COMMAND_BLOCK_REACH)
            .filter(([, reach]) => reach.effect !== "none")
            .map(([id]) => id)
            .sort();
        expect(placing).toEqual([
            "insertCallout",
            "insertCodeBlock",
            "insertHorizontalRule",
            "insertTable",
            "setHeading1", "setHeading2", "setHeading3",
            "setHeading4", "setHeading5", "setHeading6",
            "setParagraph",
            "toggleBlockquote",
            "toggleBulletList",
            "toggleCallout",
            "toggleOrderedList",
            "toggleTaskList",
        ]);
    });
});

describe("canPlaceCommandBlock", () => {
    const FIXTURE = [
        "plain text",
        "",
        "- list line",
        "",
        "```js",
        "fence line",
        "```",
        "",
        "| cell line | b |",
        "| --- | --- |",
        "| c | d |",
        "",
    ].join("\n");

    async function at(caret: string): Promise<(id: Parameters<typeof canPlaceCommandBlock>[1]) => boolean> {
        const editor = await makeEditor(FIXTURE);
        caretInText(editor, caret);
        const { $from } = view(editor).state.selection;
        return (id) => canPlaceCommandBlock($from, id);
    }

    it("a top-level paragraph should accept every block", async () => {
        const can = await at("plain text");
        expect(can("setHeading1")).toBe(true);
        expect(can("toggleBulletList")).toBe(true);
        expect(can("insertCodeBlock")).toBe(true);
        expect(can("toggleBlockquote")).toBe(true);
        expect(can("insertHorizontalRule")).toBe(true);
        expect(can("insertTable")).toBe(true);
    });

    it("a list line should accept a retype, because the mechanism lifts out of the list", async () => {
        const can = await at("list line");
        // A heading and a fence are both illegal as a list item's first child;
        // both commands promote the line out of the list, so both are offered.
        expect(can("setHeading1")).toBe(true);
        expect(can("insertCodeBlock")).toBe(true);
        expect(can("toggleOrderedList")).toBe(true);
    });

    it("a fence should refuse every retype and accept a wrap", async () => {
        const can = await at("fence line");
        expect(can("setHeading1")).toBe(false);
        expect(can("setParagraph")).toBe(false);
        expect(can("toggleBulletList")).toBe(false);
        // A fence goes inside a quote whole.
        expect(can("toggleBlockquote")).toBe(true);
    });

    it("a table cell should refuse a retype and an insert, and accept a wrap", async () => {
        const can = await at("cell line");
        expect(can("setHeading1")).toBe(false);
        expect(can("toggleBulletList")).toBe(false);
        expect(can("insertCodeBlock")).toBe(false);
        expect(can("insertHorizontalRule")).toBe(false);
        expect(can("insertTable")).toBe(false);
        // A cell's content IS a paragraph, so the identity row stands.
        expect(can("setParagraph")).toBe(true);
        // Quoting from inside a cell quotes the whole table (quoteAnyBlock).
        expect(can("toggleBlockquote")).toBe(true);
        expect(can("insertCallout")).toBe(true);
    });

    it("a command that places no block should always be offered", async () => {
        const can = await at("cell line");
        expect(can("toggleBold")).toBe(true);
        expect(can("insertLink")).toBe(true);
        expect(can("openFind")).toBe(true);
    });
});
