/**
 * The MAR-111 invariant, enumerated (MAR-115).
 *
 * MAR-111's shape was a conversion surface whose private gate disagreed with
 * what the editor could actually do: the row was offered, the pick consumed
 * the gesture, and the document did not move. This suite sweeps the whole
 * caret-context × slash-row space against the REAL Milkdown editor and the
 * REAL command registry, and holds two invariants over every cell:
 *
 *   offered ⇒ effective   a visible row must change the document
 *   hidden  ⇒ inert       a row hidden by the placement probe must be one
 *                         that would have done nothing
 *
 * The second half is what keeps the first half honest: hiding every row would
 * satisfy "offered ⇒ effective" and destroy the menu.
 *
 * Both sweeps assert their own size and list what they could not reach, so a
 * sweep that enumerates nothing fails instead of going green.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { Selection } from "../pm";
import type { EditorView } from "../pm";
import type { ResolvedPos } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    listLiftPlugin,
    listEnterPlugin,
    listSpreadNormalizePlugin,
    insertCalloutCommand,
    insertHorizontalRuleCommand,
} from "../plugins";
import { runEditorCommand } from "../editorCommands";
import { contextHiddenItemIds, visibleSlashItems } from "../plugins/slashMenu";
import { SLASH_MENU_ITEMS } from "../components/slashMenu/registry";
import { COMMAND_BLOCK_REACH } from "../blockPlacement";

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
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(listSpreadNormalizePlugin)
        .use(insertCalloutCommand)
        .use(insertHorizontalRuleCommand)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

/** Put the caret just inside the first text node containing `text`. */
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

/**
 * One caret context per container shape a block conversion can be picked
 * from. Each string is unique text inside the innermost block, so a caret
 * lands there by search rather than by a position that drifts.
 */
const FIXTURE = [
    "plain text",
    "",
    "## Title",
    "",
    "- bullet item",
    "",
    "1. ordered item",
    "",
    "- [ ] task item",
    "",
    "- outer item",
    "  1. nested item",
    "",
    "> quoted line",
    "",
    "> [!NOTE]",
    "> callout line",
    "",
    "| headerCell | b |",
    "| --- | --- |",
    "| bodyCell | d |",
    "",
    ":::note",
    "directive line",
    ":::",
    "",
    "prose with a footnote[^1]",
    "",
    "[^1]: footnote line",
    "",
].join("\n");

/** Caret context → the innermost container the surfaces reason about. */
const CONTEXTS: ReadonlyArray<{ caret: string; container: string }> = [
    { caret: "plain text", container: "doc" },
    { caret: "Title", container: "heading" },
    { caret: "bullet item", container: "bullet_list" },
    { caret: "ordered item", container: "ordered_list" },
    { caret: "task item", container: "task list" },
    { caret: "nested item", container: "nested ordered_list" },
    { caret: "quoted line", container: "blockquote" },
    { caret: "callout line", container: "callout" },
    { caret: "headerCell", container: "table_header" },
    { caret: "bodyCell", container: "table_cell" },
    { caret: "directive line", container: "container_directive" },
    { caret: "footnote line", container: "footnote_definition" },
];

/**
 * Rows that legitimately change nothing when picked: the row names the block
 * the caret is already in. Every other offered row must move the document.
 *
 * "Paragraph" covers a list line too — a list item's content is `paragraph
 * block*`, so its first child is a paragraph already, and list membership
 * stays the Lists control's business (see setHeading in
 * webview/editorCommands.ts).
 */
function isIdentityPick(itemId: string, $from: ResolvedPos): boolean {
    const block = $from.parent;
    if (itemId === "paragraph") {
        return block.type.name === "paragraph";
    }
    const level = /^heading([1-6])$/.exec(itemId)?.[1];
    return level !== undefined
        && block.type.name === "heading"
        && block.attrs["level"] === Number(level);
}

/** Rows whose command places a block node — the ones the probe governs. */
const BLOCK_ROWS = SLASH_MENU_ITEMS.filter(
    (item) => COMMAND_BLOCK_REACH[item.commandId].effect !== "none",
);

/** Runs a row from `caret` and reports whether the document moved. */
async function pickChangesDoc(caret: string, itemId: string): Promise<boolean> {
    const item = SLASH_MENU_ITEMS.find((entry) => entry.id === itemId)!;
    const editor = await makeEditor(FIXTURE);
    caretInText(editor, caret);
    const before = view(editor).state.doc;
    runEditorCommand(item.commandId, () => editor, item.args);
    return !view(editor).state.doc.eq(before);
}

describe("slash-menu rows against what the editor can actually do", () => {
    it("the sweep should reach every context and every block-placing row", () => {
        expect(CONTEXTS.length).toBe(12);
        // Guards the sweep against enumerating nothing: the block rows are
        // the ones the placement probe governs, and a registry edit that
        // drops them all must not read as a clean run.
        expect(BLOCK_ROWS.length).toBeGreaterThanOrEqual(17);
        expect(BLOCK_ROWS.map((item) => item.id)).toContain("codeBlock");
        expect(BLOCK_ROWS.map((item) => item.id)).toContain("table");
    });

    it("every context should be reachable in the fixture", async () => {
        const unreachable: string[] = [];
        for (const { caret } of CONTEXTS) {
            const editor = await makeEditor(FIXTURE);
            try {
                caretInText(editor, caret);
            } catch {
                unreachable.push(caret);
            }
        }
        expect(unreachable).toEqual([]);
    });

    it("a row the menu offers should never be a silent no-op", async () => {
        const silent: string[] = [];
        let checked = 0;
        for (const { caret, container } of CONTEXTS) {
            const probe = await makeEditor(FIXTURE);
            caretInText(probe, caret);
            const $from = view(probe).state.selection.$from;
            const offered = new Set(visibleSlashItems($from).map((item) => item.id));
            for (const item of BLOCK_ROWS) {
                if (!offered.has(item.id) || isIdentityPick(item.id, $from)) { continue; }
                checked++;
                if (!(await pickChangesDoc(caret, item.id))) {
                    silent.push(`${container}: "${item.id}" offered, changes nothing`);
                }
            }
        }
        expect(checked).toBeGreaterThanOrEqual(100);
        expect(silent).toEqual([]);
    }, 120_000);

    it("a row the placement probe hides should be one that would do nothing", async () => {
        const wrongly: string[] = [];
        let checked = 0;
        for (const { caret, container } of CONTEXTS) {
            const probe = await makeEditor(FIXTURE);
            caretInText(probe, caret);
            const $from = view(probe).state.selection.$from;
            const offered = new Set(visibleSlashItems($from).map((item) => item.id));
            // Rows the TOGGLE rule hides (Bullet List inside a bullet list)
            // are deliberate and do change the document — they lift. Only the
            // probe's verdicts are under test here.
            const byToggle = contextHiddenItemIds($from);
            for (const item of BLOCK_ROWS) {
                if (offered.has(item.id) || byToggle.has(item.id)) { continue; }
                // An `insert` row hidden in a table cell is NOT inert: Table
                // and Horizontal Rule would land after the whole table. That
                // displacement is the judgement the row is hidden for, and it
                // is a different failure from the silent no-op this invariant
                // is about. The golden hidden-set table below is what guards
                // those rows.
                if (COMMAND_BLOCK_REACH[item.commandId].effect === "insert") { continue; }
                checked++;
                if (await pickChangesDoc(caret, item.id)) {
                    wrongly.push(`${container}: "${item.id}" hidden, but the pick works`);
                }
            }
        }
        expect(checked).toBeGreaterThanOrEqual(15);
        expect(wrongly).toEqual([]);
    }, 120_000);
});

describe("what the probe hides, per context", () => {
    it("the hidden set should match the golden table", async () => {
        const rows: Array<{ container: string; hidden: string[] }> = [];
        for (const { caret, container } of CONTEXTS) {
            const editor = await makeEditor(FIXTURE);
            caretInText(editor, caret);
            const $from = view(editor).state.selection.$from;
            const offered = new Set(visibleSlashItems($from).map((item) => item.id));
            rows.push({
                container,
                hidden: SLASH_MENU_ITEMS
                    .filter((item) => !offered.has(item.id))
                    .map((item) => item.id),
            });
        }
        // A table cell holds a paragraph and nothing else, and is isolating,
        // so nothing that retypes or inserts a block reaches it. Quote and
        // callout stay: they WRAP, and wrapping from inside a cell quotes the
        // whole table (webview/__tests__/quoteAnyBlock.test.ts pins that).
        const CELL_HIDDEN = [
            "heading1", "heading2", "heading3", "heading4", "heading5", "heading6",
            "bulletList", "orderedList", "taskList",
            "table", "codeBlock", "mermaid", "mathBlock", "calcBlock", "divider",
        ];
        expect(rows).toEqual([
            { container: "doc", hidden: [] },
            { container: "heading", hidden: [] },
            { container: "bullet_list", hidden: ["bulletList"] },
            { container: "ordered_list", hidden: ["orderedList"] },
            { container: "task list", hidden: ["taskList"] },
            { container: "nested ordered_list", hidden: ["orderedList"] },
            { container: "blockquote", hidden: ["blockquote"] },
            { container: "callout", hidden: [] },
            { container: "table_header", hidden: CELL_HIDDEN },
            { container: "table_cell", hidden: CELL_HIDDEN },
            { container: "container_directive", hidden: [] },
            { container: "footnote_definition", hidden: [] },
        ]);
    }, 60_000);
});
