/**
 * ProseMirror funnel (MAR-100).
 *
 * This module is the single point through which the webview consumes raw
 * ProseMirror (Milkdown's `@milkdown/prose/*` re-export packages). It exists
 * for two reasons:
 *
 * 1. **Inventory** — the full raw-PM surface the webview depends on is visible
 *    and greppable in one file, per subpath. That inventory is the evidence
 *    base for MAR-101 (evaluate removing Milkdown): everything below is what a
 *    Milkdown-free editor would import from `prosemirror-*` directly.
 * 2. **Containment** — new PM usage must be added here first, keeping the
 *    surface deliberate instead of accreting ad hoc.
 *
 * Rules:
 * - Webview code imports PM names from this module, never from
 *   `@milkdown/prose/*` directly (pinned by `webview/__tests__/pmFunnel.test.ts`,
 *   which now allows no exception but the funnel itself).
 * - Re-export ONLY what is actually consumed — no wholesale `export *`, which
 *   would hide exactly the surface this file exists to reveal.
 * - Names only ever used in type positions are `export type`, so they cost
 *   nothing at runtime; flip one to a value export only when code genuinely
 *   starts constructing/referencing it.
 * - True-Milkdown imports (`@milkdown/core`, `@milkdown/utils`,
 *   `@milkdown/preset-*`, `@milkdown/transformer`) stay OUT of this funnel —
 *   they are deliberately left visible at their call sites as the surface
 *   MAR-101 would replace.
 */

// ─── @milkdown/prose (root): Milkdown's own input-rule helpers, not PM proper ───
export { markRule, nodeRule } from "@milkdown/prose";

// ─── prose/model: documents, nodes, marks, schema, positions ───
// `NodeRange` names a run of sibling nodes by the depth of their shared
// parent — the unit both halves of a block wrap speak in (editing/wrapBlocks
// constructs one per candidate depth rather than taking only the innermost
// range `blockRange` returns).
export { DOMSerializer, Fragment, NodeRange, Schema, Slice } from "@milkdown/prose/model";
export type { Attrs, Mark, MarkType, Node, NodeType, ResolvedPos } from "@milkdown/prose/model";

// ─── prose/state: editor state, selections, plugins, transactions ───
export {
    EditorState,
    NodeSelection,
    Plugin,
    PluginKey,
    Selection,
    TextSelection,
} from "@milkdown/prose/state";
export type { Command, Transaction } from "@milkdown/prose/state";

// ─── prose/view: the DOM view, decorations, node views ───
export { Decoration, DecorationSet } from "@milkdown/prose/view";
// (`parseFromClipboard` is exported at the bottom of this file — it needs a
// cast, so it lives with the other cast-bearing helpers.)
export type {
    DecorationSource,
    EditorView,
    NodeView,
    NodeViewConstructor,
} from "@milkdown/prose/view";

// ─── prose/transform: steps and position mapping ───
// `Mapping` accumulates the position maps of one or more transactions and can
// be inverted — anchorSync uses it to pair a heading's OLD position with its
// NEW one (and to reject moved/deleted headings via an inverse round-trip).
// `canJoin` asks whether the nodes either side of a position can merge into
// one — the legality probe behind every list-merge surface (editing/listMerge).
// `findWrapping` answers "may this range be wrapped in that node type here?",
// and `liftTarget` the inverse "may this range come back out?" — the schema
// itself deciding, which is what lets editing/wrapBlocks climb to the depth
// where a quote is legal instead of hard-coding where lists and tables sit.
export {
    canJoin,
    findWrapping,
    liftTarget,
    Mapping,
    ReplaceAroundStep,
    ReplaceStep,
} from "@milkdown/prose/transform";
export type { Mappable } from "@milkdown/prose/transform";

// ─── prose/commands: generic editing commands ───
// (No `wrapIn`: every wrap in the webview goes through editing/wrapBlocks,
// which asks the schema at each ancestor depth instead of giving up at the
// innermost one — see its header for what that fixes.)
export { deleteSelection, joinTextblockBackward, lift, splitBlock, toggleMark } from "@milkdown/prose/commands";

// ─── prose/gapcursor: a selection where no text position exists ───
// The only valid caret at the positions between/around block leaves — before a
// leading table, between two adjacent tables, after a trailing code block.
// Without it those positions are unreachable and an arrow key lands the caret
// inside the adjacent leaf (MAR-252). Importing this module has a side effect:
// it registers the "gapcursor" selection JSON id on `Selection`. `GapCursor` is
// a value export because plugins/gapCursor.ts and index.ts construct one.
export { gapCursor, GapCursor } from "@milkdown/prose/gapcursor";

// ─── prose/history: undo history ───
export { closeHistory, history, redo, undo } from "@milkdown/prose/history";

// ─── prose/inputrules: text-trigger rules ───
// `undoInputRule` reverts the most recent input rule, restoring the characters
// the user actually typed. It is the standard escape hatch for a rule that
// fired when the author meant literal text, and plugins/list.ts chains it ahead
// of its own Backspace handling so a list marker stays undoable there too.
// `wrappingInputRule` is the stock list/quote rule builder; plugins/
// listMarkerInput.ts constructs one and delegates to its handler for the prose
// half of its own rules, rather than vendoring the body (the emphasisInput
// precedent), so that half stays upstream's by construction.
export {
    InputRule,
    textblockTypeInputRule,
    undoInputRule,
    wrappingInputRule,
} from "@milkdown/prose/inputrules";

// ─── prose/keymap: key bindings ───
export { keydownHandler, keymap } from "@milkdown/prose/keymap";

// ─── prose/schema-list: list-item commands ───
export { liftListItem, sinkListItem } from "@milkdown/prose/schema-list";

// ─── prose/tables: table editing (prosemirror-tables) ───
export {
    addColumnAfter,
    addColumnBefore,
    addRow,
    addRowAfter,
    addRowBefore,
    cellAround,
    CellSelection,
    deleteColumn,
    deleteRow,
    deleteTable,
    goToNextCell,
    isInTable,
    selectedRect,
    setCellAttr,
    TableMap,
} from "@milkdown/prose/tables";

// ─── The live-view funnel: one place for the ctx → EditorView idiom ─────────
//
// `ctx.get(editorViewCtx)` was duplicated across every module that needed the
// live view inside an `editor.action(...)` / plugin callback. These helpers
// are the single spelling of it.

import { editorViewCtx, type Editor } from "@milkdown/core";
import { GapCursor } from "@milkdown/prose/gapcursor";
import type { ResolvedPos, Slice } from "@milkdown/prose/model";
import type { EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import * as pmView from "@milkdown/prose/view";

/**
 * "Is a gap cursor the correct selection at this position?" — false wherever an
 * ordinary text position is adjacent, so it doubles as the test for "was this
 * position unreachable before?".
 *
 * The static exists at runtime, but prosemirror-gapcursor marks it `@internal`
 * and strips it from the published typings, so the one cast the webview needs
 * for it lives here in the funnel rather than at each call site.
 */
export function isGapCursorPosition($pos: ResolvedPos): boolean {
    return (GapCursor as unknown as { valid($pos: ResolvedPos): boolean }).valid($pos);
}

/**
 * Turns clipboard flavors into the slice a paste would insert — the function
 * behind `clipboardTextParser` / `clipboardParser`, including the decisions
 * made AROUND those props: text-vs-HTML, the raw-text shortcut inside a code
 * block, and the closing `maxOpen`/`normalizeSiblings` fit to the context.
 *
 * Same shape as `isGapCursorPosition` above: prosemirror-view ships this at
 * runtime (upstream's own testing hook — hence the underscores) but leaves it
 * out of the published typings, so the one cast lives here rather than at the
 * call site. Used by the pasteMarkdown tests to drive a real paste without a
 * synthetic DOM ClipboardEvent, which jsdom cannot carry flavors on.
 */
export function parseFromClipboard(
    view: EditorView,
    text: string,
    html: string | null,
    plain: boolean,
    $context: ResolvedPos,
): Slice | null {
    return (pmView as unknown as {
        __parseFromClipboard(
            view: EditorView, text: string, html: string | null,
            plain: boolean, $context: ResolvedPos,
        ): Slice | null;
    }).__parseFromClipboard(view, text, html, plain, $context);
}

/** The `Ctx` handed to `Editor.config` / `Editor.action` callbacks. */
export type EditorCtx = Parameters<Parameters<Editor["config"]>[0]>[0];

/** The live EditorView owned by this editor context. */
export function getView(ctx: EditorCtx): EditorView {
    return ctx.get(editorViewCtx);
}

/** The live editor state (shorthand for `getView(ctx).state`). */
export function getState(ctx: EditorCtx): EditorState {
    return getView(ctx).state;
}
