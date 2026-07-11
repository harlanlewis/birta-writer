/**
 * components/blockMenu/turnInto.ts
 *
 * The block-conversion matrix behind the gutter menu's Turn-into section —
 * pure position-targeted transforms (no DOM), unit-tested directly.
 *
 * Sources and targets are the convertible top-level kinds (TurnIntoKind).
 * The rules, chosen so every conversion is a predictable markdown edit:
 *   - P/H ↔ P/H: retype in place (attr-preserving) — setHeadingLevelAt.
 *   - P/H → list/quote/callout: retype a heading down to prose, then run the
 *     exact selection-based command the toolbar runs (wrap semantics).
 *   - list ↔ list: retype the node (bullet/ordered), with the task flavor as
 *     a per-item `checked` attr sweep.
 *   - list → P/H: unwrap — each item's children become top-level blocks; with
 *     a heading target, each item's leading paragraph becomes a heading.
 *   - quote ↔ callout: retype in place (same content shape; callout attrs
 *     all default).
 *   - quote/callout → P/H: unwrap the wrapper; with a heading target the
 *     first unwrapped paragraph becomes the heading.
 *   - quote/callout → list: each direct paragraph child becomes an item
 *     (bails, no-op, when the content isn't all paragraphs).
 *   - anything → code block: the block's literal markdown source goes inside
 *     the fence (serializer-faithful, lossless in the markdown sense).
 *   - code block → anything: NOT offered (needs a per-block re-parse; the
 *     source-peek work, MAR-20, is the natural home for that).
 */
import { serializerCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { Fragment } from "@milkdown/prose/model";
import type { Node as ProseNode, NodeType } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { getHeadingLevel, setHeadingLevelAt } from "../../plugins/headingFold";
import { runEditorCommand, type GetEditor } from "../../editorCommands";

export type TurnIntoKind =
    | "paragraph"
    | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
    | "bulletList" | "orderedList" | "taskList"
    | "blockquote" | "callout" | "codeBlock";

const HEADING_KINDS: readonly TurnIntoKind[] = ["h1", "h2", "h3", "h4", "h5", "h6"];
const LIST_KINDS: readonly TurnIntoKind[] = ["bulletList", "orderedList", "taskList"];

function headingLevelOf(kind: TurnIntoKind): number {
    const idx = HEADING_KINDS.indexOf(kind);
    return idx === -1 ? 0 : idx + 1;
}

function isProseKind(kind: TurnIntoKind): boolean {
    return kind === "paragraph" || HEADING_KINDS.includes(kind);
}

/**
 * True when a paragraph carries actual text content — at least one inline
 * child that is neither an image nor an html atom, ignoring whitespace-only
 * text. Image-only and HTML-only paragraphs are visual blocks, not prose
 * (MAR-79), so they get an actions-only menu.
 */
export function isTextBearingParagraph(node: ProseNode): boolean {
    if (node.childCount === 0) {
        return true; // a blank line the user is about to type on
    }
    let sawAtom = false;
    let sawContent = false;
    node.forEach((child) => {
        const name = child.type.name;
        if (name === "image" || name === "html") {
            sawAtom = true;
            return;
        }
        if (child.isText && !child.text?.trim()) {
            return;
        }
        sawContent = true;
    });
    // Whitespace-only paragraphs (no atoms at all) are still prose — only a
    // paragraph whose real content is images/html is a visual block.
    return sawContent || !sawAtom;
}

/** A bullet list whose items carry `checked` renders (and serializes) as a
 * task list — the single probe shared by the menu and the gutter glyphs. */
export function isTaskListNode(node: ProseNode): boolean {
    const first = node.firstChild;
    return node.type.name === "bullet_list" && first !== null && first.attrs["checked"] != null;
}

/**
 * The Turn-into kind of the top-level node at `pos`, or null for blocks the
 * section can't name (tables, HR, image/html paragraphs, raw blocks…) —
 * those get an actions-only menu.
 */
export function turnIntoKindAt(view: EditorView, pos: number): TurnIntoKind | null {
    const node = view.state.doc.nodeAt(pos);
    if (!node) {
        return null;
    }
    switch (node.type.name) {
        case "paragraph":
            return isTextBearingParagraph(node) ? "paragraph" : null;
        case "heading":
            return `h${Math.min(Math.max(getHeadingLevel(node), 1), 6)}` as TurnIntoKind;
        case "blockquote":
            return "blockquote";
        case "callout":
            return "callout";
        case "code_block":
            return "codeBlock";
        case "bullet_list":
            return isTaskListNode(node) ? "taskList" : "bulletList";
        case "ordered_list":
            return "orderedList";
        default:
            return null;
    }
}

/**
 * Whether converting the block at `pos` to `target` is offered. Follows the
 * matrix in the module doc: code blocks convert only via their own fence
 * (source re-parse is MAR-20 territory), and quote/callout → list needs
 * all-paragraph content.
 */
export function canTurnInto(view: EditorView, pos: number, target: TurnIntoKind): boolean {
    const source = turnIntoKindAt(view, pos);
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

/** Serializes the single top-level node at `pos` to its markdown source. */
export function blockMarkdownAt(
    view: EditorView,
    pos: number,
    getEditor: GetEditor,
): string | null {
    const editor = getEditor();
    const node = view.state.doc.nodeAt(pos);
    if (!editor || !node) {
        return null;
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
function turnIntoCodeBlock(view: EditorView, pos: number, getEditor: GetEditor): boolean {
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

/** list → prose: items' children become top-level blocks; a heading target
 * turns each item's leading paragraph into a heading. */
function unwrapListTo(view: EditorView, pos: number, level: number): boolean {
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

/** list ↔ list: retype the node; the task flavor is a per-item `checked`
 * attr sweep (checked:false to become tasks, null to stop being tasks). */
function retypeList(view: EditorView, pos: number, target: TurnIntoKind): boolean {
    const list = view.state.doc.nodeAt(pos);
    const bullet = view.state.schema.nodes["bullet_list"];
    const ordered = view.state.schema.nodes["ordered_list"];
    if (!list || !bullet || !ordered) {
        return false;
    }
    const nodeType: NodeType = target === "orderedList" ? ordered : bullet;
    const checked: boolean | null = target === "taskList" ? false : null;
    let tr = view.state.tr;
    if (list.type !== nodeType) {
        tr = tr.setNodeMarkup(pos, nodeType, list.attrs);
    }
    list.forEach((item, offset) => {
        const itemPos = pos + 1 + offset;
        if ((item.attrs["checked"] ?? null) !== checked) {
            tr = tr.setNodeMarkup(itemPos, null, { ...item.attrs, checked });
        }
    });
    if (!tr.docChanged) {
        return false;
    }
    view.dispatch(tr);
    return true;
}

/** quote/callout → prose: unwrap; a heading target retypes the first
 * unwrapped paragraph. */
function unwrapContainerTo(view: EditorView, pos: number, level: number): boolean {
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
function containerToList(view: EditorView, pos: number, target: TurnIntoKind): boolean {
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
function retypeContainer(view: EditorView, pos: number, target: TurnIntoKind): boolean {
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

/**
 * Convert the block at `pos` to `target`, per the matrix above. Position-
 * targeted throughout; refocuses the editor. No-ops (returns false) when the
 * conversion isn't offered or nothing changes.
 */
export function turnBlockInto(
    view: EditorView,
    pos: number,
    target: TurnIntoKind,
    getEditor: GetEditor,
): boolean {
    if (!canTurnInto(view, pos, target)) {
        return false;
    }
    const source = turnIntoKindAt(view, pos);
    if (source === null || source === target) {
        return false;
    }
    let changed = false;
    if (target === "codeBlock") {
        changed = turnIntoCodeBlock(view, pos, getEditor);
    } else if (isProseKind(source) && isProseKind(target)) {
        changed = setHeadingLevelAt(view, pos, headingLevelOf(target));
    } else if (isProseKind(source)) {
        // P/H → list/quote/callout: retype a heading down to prose, then run
        // the toolbar's own selection-based wrap command so the menu can
        // never drift from toolbar behavior.
        if (source !== "paragraph") {
            setHeadingLevelAt(view, pos, 0);
        }
        selectInto(view, pos);
        const wrapCommands: Partial<Record<TurnIntoKind, string>> = {
            bulletList: "toggleBulletList",
            orderedList: "toggleOrderedList",
            taskList: "toggleTaskList",
            blockquote: "toggleBlockquote",
            callout: "insertCallout",
        };
        const commandId = wrapCommands[target];
        if (commandId) {
            runEditorCommand(commandId, getEditor);
            changed = true;
        }
    } else if (LIST_KINDS.includes(source)) {
        if (LIST_KINDS.includes(target)) {
            changed = retypeList(view, pos, target);
        } else if (isProseKind(target) || target === "paragraph") {
            changed = unwrapListTo(view, pos, headingLevelOf(target));
        } else if (target === "blockquote" || target === "callout") {
            // Wrap the whole list — "- a / - b" becomes "> - a / > - b".
            const node = view.state.doc.nodeAt(pos)!;
            const wrapType = view.state.schema.nodes[target === "callout" ? "callout" : "blockquote"];
            if (wrapType) {
                const wrapped = wrapType.createChecked(null, node);
                view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, wrapped));
                changed = true;
            }
        }
    } else if (source === "blockquote" || source === "callout") {
        if (isProseKind(target)) {
            changed = unwrapContainerTo(view, pos, headingLevelOf(target));
        } else if (LIST_KINDS.includes(target)) {
            changed = containerToList(view, pos, target);
        } else if (target === "blockquote" || target === "callout") {
            changed = retypeContainer(view, pos, target);
        }
    }
    if (changed) {
        view.focus();
    }
    return changed;
}
