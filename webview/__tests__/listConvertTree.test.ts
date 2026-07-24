/**
 * Whole-tree list conversion (editing/listConvert), against the REAL Milkdown
 * editor. The contract every conversion surface shares: converting a list
 * converts the ENTIRE tree — the targeted list, its items, and every nested
 * list — never just the top layer (the shipped bug: turn-into left a nested
 * bullet list inside a freshly ordered list). Covers the primitive, the block
 * menu's retypeList path, and the toolbar/slash `toggleList` grammar
 * (convert-in-place on a different flavor, lift on the same, wrap outside).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    convertListTreeAt,
    innermostListAt,
    listKindOf,
    outermostListAt,
} from "../editing/listConvert";
import { retypeList } from "../components/blockMenu";
import { runEditorCommand } from "../editorCommands";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

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
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown());
}

/** Every list node in the doc as "typeName@depth", document order. */
function listShapes(v: EditorView): string[] {
    const shapes: string[] = [];
    v.state.doc.descendants((node: ProseNode, pos: number) => {
        if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
            shapes.push(`${node.type.name}@${v.state.doc.resolve(pos).depth}`);
        }
        return true;
    });
    return shapes;
}

/** Caret into the text of the item whose content starts with `text`. */
function placeCaretAt(v: EditorView, text: string): void {
    let target = -1;
    v.state.doc.descendants((node: ProseNode, pos: number) => {
        if (target === -1 && node.isText && node.text?.startsWith(text)) {
            target = pos;
        }
        return target === -1;
    });
    expect(target).toBeGreaterThanOrEqual(0);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, target + 1)));
}

const NESTED_BULLET = "- top one\n- top two\n  - nested one\n  - nested two\n    - deep\n- top three\n";
const MIXED = "1. step one\n2. step two\n   - note a\n   - note b\n";

beforeEach(() => {
    document.body.innerHTML = "";
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    activeEditor = null;
});

describe("convertListTreeAt", () => {
    it("conversion should preserve the list's loose/tight spacing character", async () => {
        // The spacing ruling (2026-07-24): no edit rewrites tight/loose —
        // conversion carries every node's spread attr through the retype.
        const loose = await makeEditor("- a\n\n- b\n");
        expect(convertListTreeAt(view(loose), 0, "orderedList")).toBe(true);
        expect(markdown(loose)).toBe("1. a\n\n2. b\n");

        const tight = await makeEditor("- a\n- b\n");
        expect(convertListTreeAt(view(tight), 0, "orderedList")).toBe(true);
        expect(markdown(tight)).toBe("1. a\n2. b\n");
    });

    it("bullet → ordered should convert every nesting level", async () => {
        const editor = await makeEditor(NESTED_BULLET);
        const v = view(editor);

        expect(convertListTreeAt(v, 0, "orderedList")).toBe(true);

        expect(listShapes(v)).toEqual([
            "ordered_list@0", "ordered_list@2", "ordered_list@4",
        ]);
        expect(markdown(editor)).toBe(
            "1. top one\n2. top two\n   1. nested one\n   2. nested two\n      1. deep\n3. top three\n",
        );
    });

    it("ordered → bullet should convert the nested bullet's ordered parent too", async () => {
        const editor = await makeEditor(MIXED);
        const v = view(editor);

        expect(convertListTreeAt(v, 0, "bulletList")).toBe(true);

        expect(listShapes(v)).toEqual(["bullet_list@0", "bullet_list@2"]);
        expect(markdown(editor)).toBe("- step one\n- step two\n  - note a\n  - note b\n");
    });

    it("bullet → task should mark every item at every level checkable", async () => {
        const editor = await makeEditor(NESTED_BULLET);
        const v = view(editor);

        expect(convertListTreeAt(v, 0, "taskList")).toBe(true);

        let items = 0;
        let checkable = 0;
        v.state.doc.descendants((node: ProseNode) => {
            if (node.type.name === "list_item") {
                items++;
                if (node.attrs["checked"] === false) { checkable++; }
            }
            return true;
        });
        expect(items).toBe(6);
        expect(checkable).toBe(6);
        expect(markdown(editor)).toContain("- [ ] top one");
        expect(markdown(editor)).toContain("  - [ ] nested one");
    });

    it("converting INTO tasks should preserve an already-ticked nested box", async () => {
        const editor = await makeEditor("- plain\n  - [x] done\n  - [ ] todo\n");
        const v = view(editor);

        expect(convertListTreeAt(v, 0, "taskList")).toBe(true);

        const md = markdown(editor);
        expect(md).toContain("- [ ] plain");
        expect(md).toContain("  - [x] done");
        expect(md).toContain("  - [ ] todo");
    });

    it("task → bullet should clear every box, nested included", async () => {
        const editor = await makeEditor("- [x] top\n  - [ ] child\n");
        const v = view(editor);

        expect(convertListTreeAt(v, 0, "bulletList")).toBe(true);

        const md = markdown(editor);
        expect(md).not.toContain("[x]");
        expect(md).not.toContain("[ ]");
        expect(md).toContain("- top");
    });

    it("a same-flavor no-op should return false and change nothing", async () => {
        const editor = await makeEditor("- one\n- two\n");
        const v = view(editor);
        const before = v.state.doc;

        expect(convertListTreeAt(v, 0, "bulletList")).toBe(false);
        expect(v.state.doc.eq(before)).toBe(true);
    });

    it("a non-list position should refuse", async () => {
        const editor = await makeEditor("plain paragraph\n");
        const v = view(editor);
        expect(convertListTreeAt(v, 0, "orderedList")).toBe(false);
    });

    it("one undo should restore the whole tree", async () => {
        // Bespoke editor: this case needs the history plugin.
        const root = document.createElement("div");
        document.body.appendChild(root);
        const { historyPlugin } = await import("../plugins/history");
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, NESTED_BULLET);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .use(historyPlugin)
            .create();
        editors.push(editor);
        const v = view(editor);
        convertListTreeAt(v, 0, "orderedList");
        expect(markdown(editor)).toContain("1. top one");

        const { undo } = await import("../pm");
        undo(v.state, v.dispatch);

        expect(markdown(editor)).toBe(NESTED_BULLET);
    });
});

describe("retypeList (the block menu's Turn-into path)", () => {
    it("should convert the nested layers, not just the top (the shipped bug)", async () => {
        const editor = await makeEditor(NESTED_BULLET);
        const v = view(editor);

        expect(retypeList(v, 0, "orderedList")).toBe(true);

        expect(listShapes(v)).toEqual([
            "ordered_list@0", "ordered_list@2", "ordered_list@4",
        ]);
    });

    it("should refuse non-list targets", async () => {
        const editor = await makeEditor("- one\n");
        const v = view(editor);
        expect(retypeList(v, 0, "paragraph")).toBe(false);
    });
});

describe("toggleList (toolbar Lists menu / slash menu commands)", () => {
    const getEditor = (): Editor | null => activeEditor;

    it("caret in a bullet list + Ordered List should convert the whole tree in place", async () => {
        const editor = await makeEditor(NESTED_BULLET);
        const v = view(editor);
        placeCaretAt(v, "top two");

        runEditorCommand("toggleOrderedList", getEditor);

        expect(listShapes(v)).toEqual([
            "ordered_list@0", "ordered_list@2", "ordered_list@4",
        ]);
    });

    it("caret in a NESTED sublist of another flavor should still convert from the outermost list", async () => {
        const editor = await makeEditor(MIXED);
        const v = view(editor);
        placeCaretAt(v, "note a"); // inside the nested BULLET sublist

        runEditorCommand("toggleOrderedList", getEditor);

        // The nested list is bullet (≠ ordered), so this is a conversion —
        // and it applies to the whole tree, making both levels ordered.
        expect(listShapes(v)).toEqual(["ordered_list@0", "ordered_list@2"]);
    });

    it("caret in a list of the SAME flavor should lift (toggle off), not convert", async () => {
        const editor = await makeEditor("- one\n- two\n");
        const v = view(editor);
        placeCaretAt(v, "one");

        runEditorCommand("toggleBulletList", getEditor);

        // The caret's item left the list (historical toggle-off behavior).
        expect(v.state.doc.child(0).type.name).toBe("paragraph");
    });

    it("caret in a TASK list + Bullet List should convert (clear boxes), not lift", async () => {
        const editor = await makeEditor("- [ ] a\n- [x] b\n");
        const v = view(editor);
        placeCaretAt(v, "a");

        runEditorCommand("toggleBulletList", getEditor);

        const md = markdown(editor);
        expect(md).toBe("- a\n- b\n");
    });

    it("caret in a bullet list + Task List should convert items to tasks", async () => {
        const editor = await makeEditor(NESTED_BULLET);
        const v = view(editor);
        placeCaretAt(v, "top one");

        runEditorCommand("toggleTaskList", getEditor);

        expect(markdown(editor)).toContain("- [ ] top one");
        expect(markdown(editor)).toContain("  - [ ] nested one");
    });

    it("caret in a paragraph should wrap it (unchanged behavior)", async () => {
        const editor = await makeEditor("plain text\n");
        const v = view(editor);
        placeCaretAt(v, "plain");

        runEditorCommand("toggleBulletList", getEditor);

        expect(markdown(editor)).toBe("- plain text\n");
    });
});

describe("list locator helpers", () => {
    it("innermost/outermost should disagree exactly inside a nested sublist", async () => {
        const editor = await makeEditor(MIXED);
        const v = view(editor);
        placeCaretAt(v, "note a");
        const caret = v.state.selection.from;

        const inner = innermostListAt(v.state.doc.resolve(caret))!;
        const outer = outermostListAt(v.state.doc.resolve(caret))!;
        expect(inner.node.type.name).toBe("bullet_list");
        expect(outer.node.type.name).toBe("ordered_list");
        expect(outer.pos).toBe(0);
        expect(listKindOf(inner.node)).toBe("bulletList");
        expect(listKindOf(outer.node)).toBe("orderedList");
    });

    it("both should be null outside any list", async () => {
        const editor = await makeEditor("plain\n");
        const v = view(editor);
        placeCaretAt(v, "plain");
        expect(innermostListAt(v.state.selection.$from)).toBeNull();
        expect(outermostListAt(v.state.selection.$from)).toBeNull();
    });
});
