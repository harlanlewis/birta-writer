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
 *   - container ↔ container: retype in place (same content shape; a title
 *     travels) — retypeContainer.
 *   - container → P/H: unwrap the wrapper, then make the first unwrapped
 *     block the picked kind, however many layers deep it was —
 *     unwrapContainerTo.
 *   - container → list: each direct paragraph child becomes an item
 *     (bails, no-op, when the content isn't all paragraphs) — containerToList.
 *   - anything → code block: the block's literal markdown source goes inside
 *     the fence (serializer-faithful, lossless in the markdown sense) —
 *     turnIntoCodeBlock.
 *   - code block → anything: NOT offered (needs a per-block re-parse; the
 *     source-peek work, MAR-20, is the natural home for that).
 *
 * "Container" here is any of the four `block+` wrappers: a blockquote, a GFM
 * callout, and the two other spellings of a callout (`:::name` directives and
 * Notion `<aside>` blocks). The last two are sources only — see
 * blockCapabilities — so they never appear as a `target`.
 */
import { serializerCtx } from "@milkdown/core";
import type { EditorView } from "../../pm";
import { Fragment } from "../../pm";
import type { Node as ProseNode } from "../../pm";
import { TextSelection } from "../../pm";
import { setHeadingLevelAt } from "../../editing/blockOps";
import { convertListTreeAt } from "../../editing/listConvert";
import { wrapBlocksIn } from "../../editing/wrapBlocks";
import { runEditorCommand, type GetEditor } from "../../editorCommands";
import type { ConversionKind } from "../../blockCapabilities";

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
 * P/H → list/quote/callout: retype a heading down to prose, then wrap.
 *
 * The list and callout targets run the toolbar's own selection-based command
 * so the menu can never drift from toolbar behavior. Blockquote does NOT:
 * `toggleBlockquote` is a toggle, and a heading already inside a quote would
 * make it lift the block OUT of the quote — the opposite of the picked row.
 * A conversion always wraps, so it calls the wrap half directly (the same
 * mechanism the toggle's wrap half calls).
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
    if (target === "blockquote") {
        const quote = view.state.schema.nodes["blockquote"];
        return quote !== undefined && wrapBlocksIn(quote)(view.state, view.dispatch, view);
    }
    const wrapCommands: Partial<Record<ConversionKind, string>> = {
        bulletList: "toggleBulletList",
        orderedList: "toggleOrderedList",
        taskList: "toggleTaskList",
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

/** list ↔ list: retype the list at `pos`, its items, and every nested list of
 * the SAME KIND, via the shared converter (editing/listConvert), so a bullet
 * outline converts through and through rather than just its top layer — while
 * an ordered sub-list inside it, deliberately made different, stays ordered.
 * That exemption and its cost live in the converter's header. Task flavor
 * rides as a per-item `checked` sweep in the same transaction. */
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

/**
 * quote/callout → prose: unwrap, then make the FIRST unwrapped block the
 * picked kind — retyping it when it is prose, applying the list rule when it
 * is a list, unwrapping again when it is another container.
 *
 * The one-layer version stopped at whatever the unwrap happened to expose:
 * "Paragraph" on a quoted list handed back a bullet list, and every heading
 * row handed back the same list, so the row that lit up afterwards was not
 * the row that was clicked. Each iteration strictly reduces nesting, and
 * anything with no prose form (a table, a fence) ends the loop where it is.
 */
export function unwrapContainerTo(view: EditorView, pos: number, level: number): boolean {
    let changed = false;
    // Every iteration that does not return replaces a container with its own
    // children, so the nesting at `pos` strictly shrinks and the loop ends on
    // its own. The bound is the fail-safe: a spin here would hang the webview,
    // and no real document nests quotes this deep.
    for (let guard = 0; guard < 10; guard++) {
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.childCount === 0) {
            break;
        }
        const name = node.type.name;
        if (name === "paragraph" || name === "heading") {
            return setHeadingLevelAt(view, pos, level) || changed;
        }
        if (name === "bullet_list" || name === "ordered_list") {
            return unwrapListTo(view, pos, level) || changed;
        }
        if (!isBlockContainer(name)) {
            break; // a table, a fence: nothing prose-shaped to retype
        }
        const content = withContainerTitle(view, node, node.content);
        view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, content));
        changed = true;
    }
    return changed;
}

/**
 * The `block+` wrappers a conversion can unwrap or retype in place: a GFM
 * callout, a plain quote, and the two other spellings of a callout
 * (`:::name …:::`, `<aside>…</aside>`). They share every mechanism here
 * because they share a content shape; what tells them apart is the marker
 * each carries, which is what the conversion's declared drop names.
 */
function isBlockContainer(name: string): boolean {
    return name === "blockquote" || name === "callout"
        || name === "container_directive" || name === "notion_callout";
}

/**
 * A titled container's title is user-typed prose — no conversion may drop it.
 * Returns `content` with the title prepended as a leading paragraph when the
 * node carries one. A directive's title is the text after its open fence
 * (`:::note Heads up`); a Notion callout has none.
 */
function withContainerTitle(view: EditorView, node: ProseNode, content: Fragment): Fragment {
    const name = node.type.name;
    const title = name === "callout" || name === "container_directive"
        ? String(node.attrs["title"] ?? "").trim()
        : "";
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
    withContainerTitle(view, node, node.content).forEach((child) => {
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

/**
 * container ↔ container (quote ↔ callout, and the directive / Notion
 * spellings on the way out): retype in place — same content shape, and every
 * callout attr has a default.
 *
 * A title is user-typed prose, so it never evaporates: it leads the new
 * container as its own paragraph. That holds for a callout target too, even
 * though a callout has a `title` attr — the attr is not the source of truth,
 * the marker line is, and re-spelling a marker means carrying its type, case,
 * fold flag and raw bytes across a syntax that has none of them. Prose in the
 * body is the answer that cannot be subtly wrong.
 */
export function retypeContainer(view: EditorView, pos: number, target: ConversionKind): boolean {
    const node = view.state.doc.nodeAt(pos);
    const nodeType = view.state.schema.nodes[target === "callout" ? "callout" : "blockquote"];
    if (!node || !nodeType) {
        return false;
    }
    const content = withContainerTitle(view, node, node.content);
    if (content !== node.content) {
        view.dispatch(view.state.tr.replaceWith(
            pos,
            pos + node.nodeSize,
            nodeType.createChecked(null, content),
        ));
        return true;
    }
    view.dispatch(view.state.tr.setNodeMarkup(pos, nodeType, null));
    return true;
}
