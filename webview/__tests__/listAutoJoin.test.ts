/**
 * Auto-join of edit-created adjacent lists (listAutoJoinPlugin), driving the
 * REAL Milkdown editor. The policy under test: adjacency the user's own edit
 * created (deleting the separator between two lists, turning the separator
 * into a matching list) merges into ONE list — while a split the source
 * already carries (a `-`→`*` marker change parses as two sibling lists) is
 * the author's syntax and must never merge on its own. Undo/redo and
 * addToHistory:false rewrites (external sync) restore states verbatim, so
 * they are exempt too.
 *
 * The stakes are serialization: two adjacent sibling lists serialize with an
 * alternated bullet marker (`-` then `*`, mdast-util-to-markdown's
 * bulletOther), which turns a transient editing artifact into a permanent
 * source-level split on the next save.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { undo } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { listAutoJoinPlugin } from "../plugins/list";
import { historyPlugin } from "../plugins/history";

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
        .use(historyPlugin)
        .use(listAutoJoinPlugin)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown());
}

/** Top-level node type names, e.g. ["bullet_list", "paragraph"]. */
function topLevelTypes(v: EditorView): string[] {
    const types: string[] = [];
    v.state.doc.forEach((child: ProseNode) => types.push(child.type.name));
    return types;
}

/** Deletes the first top-level paragraph whose text is `text`, whole-node. */
function deleteParagraph(v: EditorView, text: string): void {
    let from = -1;
    let to = -1;
    v.state.doc.forEach((child: ProseNode, offset: number) => {
        if (from === -1 && child.type.name === "paragraph" && child.textContent === text) {
            from = offset;
            to = offset + child.nodeSize;
        }
    });
    expect(from).toBeGreaterThanOrEqual(0);
    v.dispatch(v.state.tr.delete(from, to));
}

beforeEach(() => {
    document.body.innerHTML = "";
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
});

describe("deleting the separator between two lists", () => {
    it("two bullet lists should join into one list", async () => {
        const editor = await makeEditor("- foo\n- bar\n\nseparator\n\n- bingo\n- wingo\n");
        const v = view(editor);
        deleteParagraph(v, "separator");

        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(markdown(editor)).toBe("- foo\n- bar\n- bingo\n- wingo\n");
    });

    it("two ordered lists should join into one list", async () => {
        const editor = await makeEditor("1. one\n2. two\n\nseparator\n\n1. three\n2. four\n");
        const v = view(editor);
        deleteParagraph(v, "separator");

        expect(topLevelTypes(v)).toEqual(["ordered_list"]);
        expect(markdown(editor)).toBe("1. one\n2. two\n3. three\n4. four\n");
    });

    it("a bullet list next to an ordered list should NOT join", async () => {
        const editor = await makeEditor("- foo\n- bar\n\nseparator\n\n1. one\n2. two\n");
        const v = view(editor);
        deleteParagraph(v, "separator");

        expect(topLevelTypes(v)).toEqual(["bullet_list", "ordered_list"]);
    });

    it("two nested sublists inside one item should join", async () => {
        const editor = await makeEditor(
            "- parent\n  - alpha\n\n  separator\n\n  - beta\n",
        );
        const v = view(editor);
        // The separator here is a paragraph nested inside the list item.
        let from = -1;
        let to = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (from === -1 && node.type.name === "paragraph" && node.textContent === "separator") {
                from = pos;
                to = pos + node.nodeSize;
            }
            return from === -1;
        });
        expect(from).toBeGreaterThanOrEqual(0);
        v.dispatch(v.state.tr.delete(from, to));

        // One outer list; its single item now carries ONE sublist.
        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        const item = v.state.doc.child(0).child(0);
        const childTypes: string[] = [];
        item.forEach((child: ProseNode) => childTypes.push(child.type.name));
        expect(childTypes).toEqual(["paragraph", "bullet_list"]);
        // The item keeps its (source-authored) loose spread, so the sublist
        // still sits after a blank line — but as ONE list, no `*` alternation.
        expect(markdown(editor)).toBe("- parent\n\n  - alpha\n  - beta\n");
    });

    it("deleting two separators in one transaction should join all three lists", async () => {
        const editor = await makeEditor(
            "- a\n\nsep one\n\n- b\n\nsep two\n\n- c\n",
        );
        const v = view(editor);
        // Collect both separator paragraphs, delete high-to-low in ONE tr.
        const ranges: Array<{ from: number; to: number }> = [];
        v.state.doc.forEach((child: ProseNode, offset: number) => {
            if (child.type.name === "paragraph") {
                ranges.push({ from: offset, to: offset + child.nodeSize });
            }
        });
        expect(ranges).toHaveLength(2);
        const tr = v.state.tr;
        for (const range of ranges.reverse()) {
            tr.delete(range.from, range.to);
        }
        v.dispatch(tr);

        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(markdown(editor)).toBe("- a\n- b\n- c\n");
    });
});

describe("fidelity: source-authored splits are never auto-merged", () => {
    it("typing inside a marker-split list pair should keep the two lists", async () => {
        // `-` then `*` is markdown's explicit two-lists syntax; it parses as
        // two sibling bullet_list nodes.
        const editor = await makeEditor("- foo\n- bar\n\n* bingo\n* wingo\n");
        const v = view(editor);
        expect(topLevelTypes(v)).toEqual(["bullet_list", "bullet_list"]);

        // Type inside the first list (an edit that TOUCHES the boundary's
        // neighborhood without creating the adjacency).
        v.dispatch(v.state.tr.insertText("x", 5));

        expect(topLevelTypes(v)).toEqual(["bullet_list", "bullet_list"]);
        expect(markdown(editor)).toContain("* bingo");
    });

    it("an addToHistory:false rewrite should never trigger a join", async () => {
        // External sync applies file changes with addToHistory:false — the
        // resulting doc is the FILE's state, not a user edit to interpret.
        const editor = await makeEditor("- foo\n\nseparator\n\n- bar\n");
        const v = view(editor);
        let from = -1;
        let to = -1;
        v.state.doc.forEach((child: ProseNode, offset: number) => {
            if (from === -1 && child.type.name === "paragraph") {
                from = offset;
                to = offset + child.nodeSize;
            }
        });
        v.dispatch(v.state.tr.delete(from, to).setMeta("addToHistory", false));

        expect(topLevelTypes(v)).toEqual(["bullet_list", "bullet_list"]);
    });
});

describe("undo", () => {
    it("undoing a MANUAL merge should not be re-joined by the auto-join", async () => {
        // The `history$` skip is load-bearing here: undo restores two
        // adjacent lists, and that adjacency looks "new" to the old-doc
        // probe — without the skip the plugin would immediately re-join,
        // fighting the user's undo.
        const { mergeListsAt } = await import("../editing/listMerge");
        const editor = await makeEditor("- foo\n- bar\n\n* bingo\n* wingo\n");
        const v = view(editor);
        let boundary = -1;
        let i = 0;
        v.state.doc.forEach((_child: ProseNode, offset: number) => {
            if (i === 1) boundary = offset;
            i++;
        });
        expect(mergeListsAt(v, boundary)).toBe(true);
        expect(topLevelTypes(v)).toEqual(["bullet_list"]);

        undo(v.state, v.dispatch);

        expect(topLevelTypes(v)).toEqual(["bullet_list", "bullet_list"]);
        expect(markdown(editor)).toBe("- foo\n- bar\n\n* bingo\n* wingo\n");
    });

    it("one undo should restore both the separator and the split", async () => {
        const editor = await makeEditor("- foo\n\nseparator\n\n- bar\n");
        const v = view(editor);
        deleteParagraph(v, "separator");
        expect(topLevelTypes(v)).toEqual(["bullet_list"]);

        undo(v.state, v.dispatch);

        expect(topLevelTypes(v)).toEqual(["bullet_list", "paragraph", "bullet_list"]);
        expect(markdown(editor)).toBe("- foo\n\nseparator\n\n- bar\n");
    });
});
