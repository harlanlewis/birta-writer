/**
 * components/blockMenu/turnInto.ts
 *
 * The concrete block converters behind the gutter menu's Turn-into section —
 * pure position-targeted transforms (no DOM), unit-tested directly.
 *
 * WHICH conversions are offered, and which converter runs for a pair, is
 * decided in webview/blockCapabilities.ts (`canConvert` / `convertAt`) —
 * legality is derived from per-type shape declarations there, and this
 * module only supplies the mechanisms:
 *   - P/H ↔ P/H: retype in place (attr-preserving) — setHeadingLevelAt.
 *   - P/H → list/quote/callout: retype a heading down to prose, then run the
 *     exact selection-based command the toolbar runs — wrapProseIn.
 *   - list ↔ list: retype the node (bullet/ordered), with the task flavor as
 *     a per-item `checked` attr sweep — retypeList.
 *   - list → P/H: unwrap — each item's children become top-level blocks; with
 *     a heading target, each item's leading paragraph becomes a heading —
 *     unwrapListTo.
 *   - list → quote/callout: wrap the whole list — wrapListIn.
 *   - quote ↔ callout: retype in place (same content shape; callout attrs
 *     all default) — retypeContainer.
 *   - quote/callout → P/H: unwrap the wrapper; with a heading target the
 *     first unwrapped paragraph becomes the heading — unwrapContainerTo.
 *   - quote/callout → list: each direct paragraph child becomes an item
 *     (bails, no-op, when the content isn't all paragraphs) — containerToList.
 *   - anything → code block: the block's literal markdown source goes inside
 *     the fence (serializer-faithful, lossless in the markdown sense) —
 *     turnIntoCodeBlock.
 *   - code block → anything: NOT offered (needs a per-block re-parse; the
 *     source-peek work, MAR-20, is the natural home for that).
 */
import { serializerCtx } from "@milkdown/core";
import type { EditorView } from "../../pm";
import { Fragment } from "../../pm";
import type { Node as ProseNode } from "../../pm";
import { TextSelection } from "../../pm";
import { setHeadingLevelAt } from "../../editing/blockOps";
import { convertListTreeAt } from "../../editing/listConvert";
import { runEditorCommand, type GetEditor } from "../../editorCommands";
import { conversionKindAt, type ConversionKind } from "../../blockCapabilities";

/**
 * Places the caret just inside the block at `pos`. Two jobs: the selection-
 * based editor commands (the same ones the toolbar runs) target that block —
 * and prosemirror-history snapshots the selection BEFORE a mutating
 * transaction, so pre-placing the caret here makes undo/redo restore it (and
 * scroll) to the block that was acted on, not wherever the caret last was
 * (often the top of the document). Exported for the menu and drag handle.
 */
export function selectInto(view: EditorView, pos: number): void {
    const inside = Math.min(pos + 1, view.state.doc.content.size);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(inside))));
}

/** Serializes the single node at `pos` to its markdown source. A bare list
 * item can't serialize standalone, so it's wrapped in its parent list type
 * ("- text" / "1. text"). */
export function blockMarkdownAt(
    view: EditorView,
    pos: number,
    getEditor: GetEditor,
): string | null {
    const editor = getEditor();
    let node = view.state.doc.nodeAt(pos);
    if (!editor || !node) {
        return null;
    }
    if (node.type.name === "list_item") {
        const $pos = view.state.doc.resolve(pos);
        const parent = $pos.parent;
        // An ordered item copies with its ACTUAL ordinal ("4. text"), not
        // the parent list's start number.
        const attrs = parent.type.name === "ordered_list"
            ? { ...parent.attrs, order: Number(parent.attrs["order"] ?? 1) + $pos.index() }
            : parent.attrs;
        node = parent.type.createChecked(attrs, Fragment.from(node));
    }
    let markdown: string | null = null;
    editor.action((ctx) => {
        const serializer = ctx.get(serializerCtx);
        const doc = view.state.schema.topNodeType.create(null, Fragment.from(node));
        markdown = serializer(doc).replace(/\n+$/, "");
    });
    return markdown;
}

/** any → code block: the literal markdown source goes inside the fence. */
export function turnIntoCodeBlock(view: EditorView, pos: number, getEditor: GetEditor): boolean {
    const node = view.state.doc.nodeAt(pos);
    const source = blockMarkdownAt(view, pos, getEditor);
    const codeType = view.state.schema.nodes["code_block"];
    if (!node || source === null || !codeType) {
        return false;
    }
    const code = codeType.createChecked(
        null,
        source ? view.state.schema.text(source) : undefined,
    );
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, code));
    return true;
}

/**
 * P/H → list/quote/callout: retype a heading down to prose, then run the
 * toolbar's own selection-based wrap command so the menu can never drift
 * from toolbar behavior.
 */
export function wrapProseIn(
    view: EditorView,
    pos: number,
    source: ConversionKind,
    target: ConversionKind,
    getEditor: GetEditor,
): boolean {
    if (source !== "paragraph") {
        setHeadingLevelAt(view, pos, 0);
    }
    selectInto(view, pos);
    const wrapCommands: Partial<Record<ConversionKind, string>> = {
        bulletList: "toggleBulletList",
        orderedList: "toggleOrderedList",
        taskList: "toggleTaskList",
        blockquote: "toggleBlockquote",
        callout: "insertCallout",
    };
    const commandId = wrapCommands[target];
    if (!commandId) {
        return false;
    }
    runEditorCommand(commandId, getEditor);
    return true;
}

/** list → prose: items' children become top-level blocks; a heading target
 * turns each item's leading paragraph into a heading. */
export function unwrapListTo(view: EditorView, pos: number, level: number): boolean {
    const list = view.state.doc.nodeAt(pos);
    const headingType = view.state.schema.nodes["heading"];
    if (!list) {
        return false;
    }
    const blocks: ProseNode[] = [];
    list.forEach((item) => {
        item.forEach((child, _offset, index) => {
            if (index === 0 && child.type.name === "paragraph" && level > 0 && headingType) {
                blocks.push(headingType.create({ level }, child.content, child.marks));
            } else {
                blocks.push(child);
            }
        });
    });
    if (blocks.length === 0) {
        return false;
    }
    view.dispatch(view.state.tr.replaceWith(pos, pos + list.nodeSize, Fragment.from(blocks)));
    return true;
}

/** list ↔ list: retype the WHOLE TREE — the list, its items, and every
 * nested list — via the shared converter (editing/listConvert), so a bullet
 * list with ordered sub-steps converts through and through, never just its
 * top layer. Task flavor rides as a per-item `checked` sweep in the same
 * transaction. */
export function retypeList(view: EditorView, pos: number, target: ConversionKind): boolean {
    if (target !== "bulletList" && target !== "orderedList" && target !== "taskList") {
        return false;
    }
    return convertListTreeAt(view, pos, target);
}

/** list → quote/callout: wrap the whole list — "- a / - b" becomes
 * "> - a / > - b" (items travel intact, task state included). */
export function wrapListIn(view: EditorView, pos: number, target: ConversionKind): boolean {
    const node = view.state.doc.nodeAt(pos);
    const wrapType = view.state.schema.nodes[target === "callout" ? "callout" : "blockquote"];
    if (!node || !wrapType) {
        return false;
    }
    const wrapped = wrapType.createChecked(null, node);
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, wrapped));
    return true;
}

/** quote/callout → prose: unwrap; a heading target retypes the first
 * unwrapped paragraph. */
export function unwrapContainerTo(view: EditorView, pos: number, level: number): boolean {
    const node = view.state.doc.nodeAt(pos);
    if (!node || node.childCount === 0) {
        return false;
    }
    const content = withCalloutTitle(view, node, node.content);
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, content));
    if (level > 0 && view.state.doc.nodeAt(pos)?.type.name === "paragraph") {
        setHeadingLevelAt(view, pos, level);
    }
    return true;
}

/**
 * A titled callout's title is user-typed prose — no conversion may drop it.
 * Returns `content` with the title prepended as a leading paragraph when the
 * node is a callout carrying one.
 */
function withCalloutTitle(view: EditorView, node: ProseNode, content: Fragment): Fragment {
    const title = node.type.name === "callout" ? String(node.attrs["title"] ?? "").trim() : "";
    const paragraph = view.state.schema.nodes["paragraph"];
    if (!title || !paragraph) {
        return content;
    }
    return Fragment.from(paragraph.create(null, view.state.schema.text(title))).append(content);
}

/** quote/callout → list: each direct paragraph child becomes an item (a
 * callout's title leads as its own item). */
export function containerToList(view: EditorView, pos: number, target: ConversionKind): boolean {
    const node = view.state.doc.nodeAt(pos);
    const itemType = view.state.schema.nodes["list_item"];
    const listType = view.state.schema.nodes[target === "orderedList" ? "ordered_list" : "bullet_list"];
    if (!node || !itemType || !listType) {
        return false;
    }
    const items: ProseNode[] = [];
    let bail = false;
    withCalloutTitle(view, node, node.content).forEach((child) => {
        if (child.type.name !== "paragraph") {
            bail = true;
            return;
        }
        const attrs = target === "taskList" ? { checked: false } : null;
        items.push(itemType.createChecked(attrs, child));
    });
    if (bail || items.length === 0) {
        return false;
    }
    const list = listType.createChecked(null, Fragment.from(items));
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, list));
    return true;
}

/** container ↔ container (quote ↔ callout): retype in place — same content
 * shape, and every callout attr has a default. A titled callout's title is
 * prepended as prose on the way OUT (a blockquote can't carry it). */
export function retypeContainer(view: EditorView, pos: number, target: ConversionKind): boolean {
    const node = view.state.doc.nodeAt(pos);
    const nodeType = view.state.schema.nodes[target === "callout" ? "callout" : "blockquote"];
    if (!node || !nodeType) {
        return false;
    }
    if (target === "blockquote") {
        const content = withCalloutTitle(view, node, node.content);
        if (content !== node.content) {
            const quote = nodeType.createChecked(null, content);
            view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, quote));
            return true;
        }
    }
    view.dispatch(view.state.tr.setNodeMarkup(pos, nodeType, null));
    return true;
}

// ── Legacy predicate (fidelity-gate oracle) ─────────────────────────────────

const LIST_KINDS: readonly ConversionKind[] = ["bulletList", "orderedList", "taskList"];

/**
 * @deprecated The original hand-written pair matrix, superseded by
 * `canConvert` in webview/blockCapabilities.ts. Kept VERBATIM as the oracle
 * for the fidelity gate in webview/__tests__/blockCapabilities.test.ts,
 * which asserts the derived predicate agrees with it cell for cell. Delete
 * both together once the capability registry has bedded in.
 */
export function canTurnInto(view: EditorView, pos: number, target: ConversionKind): boolean {
    const source = conversionKindAt(view, pos);
    if (source === null) {
        return false;
    }
    if (source === target) {
        return true; // the filled current row (a no-op pick)
    }
    if (source === "codeBlock") {
        return false;
    }
    if (target === "codeBlock") {
        return true;
    }
    if ((source === "blockquote" || source === "callout") && LIST_KINDS.includes(target)) {
        const node = view.state.doc.nodeAt(pos)!;
        let allParagraphs = node.childCount > 0;
        node.forEach((child) => {
            if (child.type.name !== "paragraph") {
                allParagraphs = false;
            }
        });
        return allParagraphs;
    }
    return true;
}
