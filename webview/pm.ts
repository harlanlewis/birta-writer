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
 *   `@milkdown/prose/*` directly (pinned by `webview/__tests__/pmFunnel.test.ts`;
 *   the only exception is the vendored `plugins/fidelitySerializer.ts`, whose
 *   imports document its upstream provenance).
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
export { DOMSerializer, Fragment, Schema, Slice } from "@milkdown/prose/model";
export type { Mark, Node, NodeType, ResolvedPos } from "@milkdown/prose/model";

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
export type {
    DecorationSource,
    EditorView,
    NodeView,
    NodeViewConstructor,
} from "@milkdown/prose/view";

// ─── prose/transform: steps and position mapping ───
export { ReplaceAroundStep, ReplaceStep } from "@milkdown/prose/transform";
export type { Mappable } from "@milkdown/prose/transform";

// ─── prose/commands: generic editing commands ───
export { deleteSelection, lift, splitBlock, toggleMark, wrapIn } from "@milkdown/prose/commands";

// ─── prose/history: undo history ───
export { history, redo, undo } from "@milkdown/prose/history";

// ─── prose/inputrules: text-trigger rules ───
export { InputRule, textblockTypeInputRule } from "@milkdown/prose/inputrules";

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
import type { EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

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
