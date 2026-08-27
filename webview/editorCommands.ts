/**
 * webview/editorCommands.ts
 *
 * The action registry behind every editor command (MAR-9). Each entry maps an
 * `EditorCommandId` to a function that performs the action against the live
 * Milkdown editor. The SAME registry is invoked from three places, so every
 * surface behaves identically:
 *   - the top toolbar buttons (webview/components/toolbar);
 *   - the VS Code command palette / right-click menu (via the `editorCommand`
 *     message dispatched in webview/messageHandlers.ts);
 *   - keyboard shortcuts that reuse these entries.
 *
 * Commands that need surrounding UI (the link prompt, image panel, find bar,
 * TOC panel, frontmatter panel) delegate to a host wired up by webview/index.ts
 * through `setEditorCommandHost`. Everything else is a pure editor mutation.
 */
import { commandsCtx, serializerCtx } from "@milkdown/core";
import {
    createCodeBlockCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    toggleStrongCommand,
    turnIntoTextCommand,
    wrapInBulletListCommand,
    wrapInHeadingCommand,
    wrapInOrderedListCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand, toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import {
    deleteSelectedBlocks,
    duplicateSelectedBlocks,
    moveSelectedBlocks,
    expandSelection,
    foldAllCommand,
    foldAtCaret,
    foldToLevel,
    insertCalloutCommand,
    insertFootnoteCommand,
    insertHorizontalRuleCommand,
    insertParagraphAfter,
    insertParagraphBefore,
    joinLinesCommand,
    shrinkSelection,
    toggleHighlightCommand,
    transformToLowercase,
    transformToTitleCase,
    transformToUppercase,
    unfoldAllCommand,
    unfoldAtCaret,
    beginAgentRun,
} from "@/plugins";
import { attrsFromMarker, calloutKind, markerWithKind } from "@/plugins/callouts";
import { armBlockStartHeadingComplete } from "@/plugins/headingLinkComplete";
import { indentSelection, openBlockMenuAtCaret, outdentSelection } from "@/components/blockMenu";
import { openLinkAtCaret } from "@/components/linkPopup";
import { openBlockSource } from "@/plugins/blockSource";
import { uncheckAllTasks } from "@/editing/checklistSink";
import {
    convertListTreeAt,
    innermostListAt,
    listKindOf,
    type ListKind,
} from "@/editing/listConvert";
import { liftBlocksOutOf, wrapBlocksIn } from "@/editing/wrapBlocks";
import { insertInlineMathCommand } from "@/plugins/math";
import { getView, lift } from "@/pm";
import { liftListItem } from "@/pm";
import { TextSelection, type Command } from "@/pm";
import { DOMSerializer, Fragment } from "@/pm";
import {
    addColumnAfter,
    addColumnBefore,
    addRowAfter,
    addRowBefore,
    cellAround,
    deleteColumn,
    deleteRow,
    deleteTable,
    CellSelection,
    TableMap,
} from "@/pm";
import type { Editor } from "@milkdown/core";
import type { EditorView } from "@/pm";
import type { EditorCommandId } from "../shared/editorCommands";
import type { FontPreset, ProofreadOptionKey } from "../shared/messages";
import { notifyAskAgent, notifyClipboardWrite, notifyOpenUrl, notifyOpenHostPreferences } from "@/messaging";
import { commandMutates, isReadOnly, setReadOnly } from "@/readOnly";
import { canRetypeSelectionInPlace } from "@/blockPlacement";
import { RELEASES_URL } from "../shared/product";
import { STYLE_CATEGORIES } from "@/utils/styleCategories";
import { hostHasCommand } from "../shared/hostProfile";
import { exportHtmlLazy } from "@/export/loader";
import { insertDateAtCaret, openDateChooser } from "@/dateInsert";
import { type RelativeDay, relativeCalendarDate, toCalendarDate } from "@/utils/dateFormat";

export type GetEditor = () => Editor | null;

/**
 * UI-bound actions the registry delegates to. webview/index.ts populates this
 * after building the toolbar/find/TOC/frontmatter components; a missing hook is
 * simply a no-op (e.g. before wiring, or in a unit test that only cares about
 * the pure editor commands).
 */
export interface EditorCommandHost {
    openLinkPrompt(): void;
    openImagePanel(): void;
    /** The `/ai` composer, optionally prefilled with the text typed after the row. */
    openAgentPanel(initial: string | undefined): void;
    openFind(): void;
    openFindReplace(): void;
    findNext(): void;
    findPrevious(): void;
    findSelection(): void;
    selectAllOccurrences(): void;
    toggleToc(): void;
    editFrontmatter(): void;
    editRawMarkdown(): void;
    hideToolbar(): void;
    showToolbar(): void;
    customizeToolbar(): void;
    openExtensionSettings(): void;
    openKeyboardShortcuts(): void;
    // View controls owned by the toolbar controller / TOC panel. Wired the same
    // way as the toolbar's own hooks, so the palette reaches the exact code
    // paths the toolbar and slash menu use — and they work with the bar hidden.
    chooseFontPreset(preset: FontPreset): void;
    chooseContentWidth(mode: import("../shared/contentWidth").ContentWidthMode): void;
    stepFontSize(delta: 1 | -1): void;
    /** Return the content font size to its default (the View menu's Actual Size). */
    resetFontSize(): void;
    toggleProofread(key: ProofreadOptionKey): void;
    /** The in-text editor-note highlight (birta.notes.highlightMarkers) — not a
     *  proofread option, so it has its own hook rather than a key. */
    toggleNoteHighlights(): void;
    toggleToolbar(): void;
    swapTocSide(): void;
    /** Move keyboard focus into the review sidebar, opening it when hidden —
     *  the inbound half of the sidebar's keyboard model (MAR-294; Escape is
     *  the outbound half, wired per region in toc/keyboardNav). */
    focusReviewSidebar(): void;
    // The shortcuts-help overlay (read-only cheatsheet — distinct from
    // openKeyboardShortcuts, VS Code's native customize/rebind UI). Wired by
    // webview/index.ts to webview/components/shortcutsHelp.
    openShortcutsHelp(): void;
}

let host: Partial<EditorCommandHost> = {};

/** Wires the UI-bound command hooks (called once from webview/index.ts). */
export function setEditorCommandHost(next: Partial<EditorCommandHost>): void {
    host = { ...host, ...next };
}

/** Calls a Milkdown command by its CmdKey through the commands manager. */
function callCmd<T>(getEditor: GetEditor, command: { key: unknown }, payload?: T): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const mgr = ctx.get(commandsCtx);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mgr.call(command.key as any, payload as any);
    });
}

/** Runs a ProseMirror command (state, dispatch) against the live view, then refocuses. */
function runProse(
    getEditor: GetEditor,
    fn: (view: EditorView) => void,
): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = getView(ctx);
        fn(view);
    });
}

/** Runs a plain ProseMirror keymap command against the live view, refocusing
 * the editor when it applied (palette invocations move focus out of it). */
function runCommand(getEditor: GetEditor, cmd: Command): void {
    runProse(getEditor, (view) => {
        if (cmd(view.state, view.dispatch, view)) {
            view.focus();
        }
    });
}

/** True when the cursor sits inside a node of the given type. */
function isInNode(view: EditorView, typeName: string): boolean {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth >= 0; depth--) {
        if ($from.node(depth).type.name === typeName) { return true; }
    }
    return false;
}

/** Inline code toggle: with a selection, toggle the mark; without one, drop a
 * zero-width placeholder carrying the mark and place the caret inside it. */
function toggleInlineCode(getEditor: GetEditor): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = getView(ctx);
        const { state } = view;
        if (!state.selection.empty) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx.get(commandsCtx).call(toggleInlineCodeCommand.key as any);
            return;
        }
        const codeMark = state.schema.marks["inlineCode"];
        if (!codeMark) { return; }
        const { from } = state.selection;
        const textNode = state.schema.text("​", [codeMark.create()]);
        const tr = state.tr.insert(from, textNode);
        tr.setSelection(TextSelection.create(tr.doc, from + 1));
        view.dispatch(tr);
        view.focus();
    });
}

/** Removes every mark from the current (non-empty) selection. */
function clearFormatting(getEditor: GetEditor): void {
    runProse(getEditor, (view) => {
        const { state } = view;
        const { from, to, empty } = state.selection;
        if (empty) { return; }
        // A link is structure (a target), not inline formatting, so clearing
        // formatting strips the styling marks but leaves links intact — matching
        // Word/Docs, where Clear Formatting keeps the hyperlink.
        const linkType = state.schema.marks["link"];
        let tr = state.tr;
        Object.values(state.schema.marks).forEach((markType) => {
            if (markType === linkType) { return; }
            tr = tr.removeMark(from, to, markType);
        });
        view.dispatch(tr);
        view.focus();
    });
}

/**
 * Promote the caret's line out of the lists wrapping it, splitting those
 * lists around it, until the retype to `typeName` can happen where the line
 * stands. A `list_item`'s content is `paragraph block*`, so its required
 * first child must be a paragraph: any command that RETYPES that line (a
 * heading, a code fence) silently no-ops on a list line without this.
 * Mirrors Notion/Obsidian, where picking a block type on a list line turns
 * that line into the block and drops it from the list.
 *
 * The lift is CONDITIONAL on the schema refusing the retype in place for any
 * block the selection covers (`canRetypeSelectionInPlace`, the same walk the
 * conversion surfaces use to decide whether to offer the row). An item's second paragraph, or a paragraph
 * quoted inside the item, can become a fence right there; lifting those too
 * would pull the whole item out of the list, and promote its following
 * siblings, for a change the schema was happy to make in place.
 *
 * Not used by the list rows themselves (they convert between flavors) nor by
 * Paragraph, whose target a list item's first child already is.
 */
function liftOutOfLists(view: EditorView, typeName: string): void {
    const liType = view.state.schema.nodes["list_item"];
    if (!liType) { return; }
    // liftListItem climbs one list level per call, so nested lists need
    // repeats. Bound the loop by the caret's initial depth (+slack) so it
    // can never spin — and stop early if a lift makes no progress.
    let guard = view.state.selection.$from.depth + 1;
    while (
        guard-- > 0
        && isInNode(view, "list_item")
        && !canRetypeSelectionInPlace(view.state.selection, typeName)
    ) {
        if (!liftListItem(liType)(view.state, view.dispatch)) { break; }
    }
}

/**
 * The heading level the cursor sits in, 0 for anything that is not a heading.
 *
 * Deliberately the same innermost-ancestor walk `computeToolbarActiveState`
 * does to fill the Format picker's row, so the row a user sees lit and the
 * level `setHeading` toggles against are one number rather than two walks that
 * happen to agree.
 */
function headingLevelAtCursor(view: EditorView): number {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth >= 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name === "heading") {
            return typeof node.attrs["level"] === "number" ? node.attrs["level"] : 1;
        }
    }
    return 0;
}

/**
 * Heading toggle: retype to the level, or demote back to a paragraph when the
 * cursor's own block is already at it, lifting a list line out first.
 *
 * A toggle rather than a set because every other block-type family in the
 * toolbar is one — `toggleBlockquote` below, and the three list kinds — and
 * headings were the exception. The Format picker fills the row for the current
 * level, so a lit row that did nothing when clicked was the visible half of it.
 *
 * DECIDED from the cursor's block, APPLIED to the selection. The read is the
 * one the lit row comes from, so no surface can disagree about what a second
 * press does; the demotion then covers every heading the selection spans, which
 * is the range `wrapInHeadingCommand` retypes on the way in. A selection whose
 * start is an H1 and whose end is an H2 demotes both, rather than leaving the
 * H2 as the one block the gesture silently missed.
 *
 * `setParagraph` is untouched and stays the unconditional way to say paragraph.
 */
function setHeading(getEditor: GetEditor, level: number): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = getView(ctx);
        if (headingLevelAtCursor(view) === level) {
            demoteHeadingsInSelection(view);
            view.focus();
            return;
        }
        liftOutOfLists(view, "heading");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.get(commandsCtx).call(wrapInHeadingCommand.key as any, level);
        view.focus();
    });
}

/**
 * Blockquote toggle: quote the blocks the selection covers, or lift them back
 * out when they are already quoted. Both halves come from editing/wrapBlocks,
 * so ANY content can be quoted — a list, a table, several blocks at once —
 * and the second press is the exact inverse of the first.
 */
function toggleBlockquote(getEditor: GetEditor): void {
    runProse(getEditor, (view) => {
        const type = view.state.schema.nodes["blockquote"];
        if (!type) { return; }
        const command = isInNode(view, "blockquote")
            ? liftBlocksOutOf("blockquote")
            : wrapBlocksIn(type);
        // No view.focus(): a slash-menu pick must not yank focus back from a
        // host panel that just took it (slashMenuPlugin.test.ts pins this).
        command(view.state, view.dispatch, view);
    });
}

/**
 * Retypes every heading the selection covers to a paragraph, in one
 * transaction. A `list_item`'s content is `paragraph block*`, so a heading
 * cannot be its first child: wrapping a heading line in a list is a schema
 * no-op, and "Bullet List" on a heading did nothing at all. Demoting first
 * makes the pick mean what it says — the line becomes a list item and stops
 * being a heading, the inverse of setHeading's "a heading leaves the list"
 * (and what the block menu's Turn-into already does by another route).
 *
 * The demotion cannot strand a heading as a bare paragraph: `heading` and
 * `bullet_list` are both group `block`, so anywhere a heading is legal a list
 * is too. The one position that admits a paragraph but not a list — a list
 * item's first child — admits no heading either, and a caret in a list never
 * reaches this branch.
 */
function demoteHeadingsInSelection(view: EditorView): void {
    const paragraph = view.state.schema.nodes["paragraph"];
    if (!paragraph) { return; }
    const { from, to } = view.state.selection;
    let tr = view.state.tr;
    let changed = false;
    // Retyping preserves node size, so positions from the pre-edit doc stay
    // valid for every markup in the same transaction.
    view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === "heading") {
            tr = tr.setNodeMarkup(pos, paragraph, null);
            changed = true;
        }
    });
    if (changed) { view.dispatch(tr); }
}

/**
 * List toggle, one grammar for all three flavors (toolbar Lists menu, slash
 * menu, palette commands):
 *   - caret in a list of ANOTHER flavor → CONVERT the caret's own list in place
 *     — it, its items, and every nested list of the same kind
 *     (editing/listConvert; the same converter the block menu's Turn-into
 *     runs), never a nested re-wrap;
 *   - caret in a list of the SAME flavor → toggle off (lift out — the
 *     historical behavior);
 *   - caret not in a list → demote any heading the selection covers, then
 *     wrap it (the stock commands).
 */
/**
 * Tick or untick the task the caret is in.
 *
 * The checkbox has always been clickable and typeable (`[x] ` as an input
 * rule), and neither reaches a keyboard user with their hands on the text.
 * This walks OUT from the caret to the nearest ancestor list item that carries
 * a `checked` attr, which is what makes a task item a task item, so a caret
 * anywhere in the item's text works and a nested task ticks the item it is in
 * rather than the outer one.
 *
 * A caret in a plain list item does nothing. Turning one INTO a task is
 * `toggleTaskList`, a different question with its own command; silently
 * converting here would make one key mean two things depending on where it
 * landed.
 */
function toggleTaskChecked(getEditor: GetEditor): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = getView(ctx);
        const $from = view.state.selection.$from;
        for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            const checked = node.attrs["checked"];
            if (checked === undefined || checked === null) { continue; }
            const tr = view.state.tr.setNodeMarkup($from.before(depth), undefined, {
                ...node.attrs,
                checked: !checked,
            });
            view.dispatch(tr);
            return;
        }
    });
}

function toggleList(getEditor: GetEditor, kind: ListKind): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = getView(ctx);
        const $from = view.state.selection.$from;
        const inner = innermostListAt($from);
        if (inner) {
            // BOTH the flavor test and the conversion target are the list the
            // caret is IN — the one the toolbar's active state highlights, and
            // the only list a caret can be said to have selected.
            //
            // The conversion used to apply from the OUTERMOST list instead,
            // which stopped being coherent when convertListTreeAt began exempting
            // nested lists of a different kind: the caret's own list is exempt by
            // definition whenever it differs from the outermost, so "caret in a
            // bullet sublist + Numbered List" converted nothing at all. Judging
            // one list and converting another was always the odd part; this
            // makes the two agree, and matches the block menu, where a handle
            // can only ever point at one list.
            if (listKindOf(inner.node) !== kind) {
                convertListTreeAt(view, inner.pos, kind);
            } else {
                lift(view.state, view.dispatch);
            }
            return;
        }
        demoteHeadingsInSelection(view);
        const mgr = ctx.get(commandsCtx);
        mgr.call(
            (kind === "orderedList"
                ? wrapInOrderedListCommand.key
                : wrapInBulletListCommand.key) as never,
        );
        if (kind !== "taskList") { return; }
        // Task flavor rides on bullet_list as a per-item `checked` attr.
        const { state: newState, dispatch } = view;
        const { from, to } = newState.selection;
        let tr = newState.tr;
        let changed = false;
        newState.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === "list_item" && node.attrs["checked"] == null) {
                tr = tr.setNodeMarkup(pos, null, { ...node.attrs, checked: false });
                changed = true;
            }
        });
        if (changed) { dispatch(tr); }
    });
}

/** Writes the date a relative command names, read from the clock right now. */
function insertRelativeDate(getEditor: GetEditor, which: RelativeDay): void {
    runProse(getEditor, (view) =>
        insertDateAtCaret(view, relativeCalendarDate(which, new Date())));
}

/** Inserts a footnote reference/definition pair and refocuses the editor. */
function insertFootnote(getEditor: GetEditor): void {
    callCmd(getEditor, insertFootnoteCommand);
    getEditor()?.action((ctx) => getView(ctx).focus());
}

/** Wraps the selection in a callout of the given kind. Always a wrap —
 * callouts nest at any depth (block+), so inserting one inside a callout
 * NESTS rather than lifting out (the old toggle made "/tip" inside a note
 * silently destroy the outer callout). Unwrapping lives in the block
 * menu's turn-into and the toolbar's toggleCallout, where it reads as an
 * explicit conversion. */
function insertCallout(getEditor: GetEditor, args?: unknown): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        ctx.get(commandsCtx).call(
            insertCalloutCommand.key as never,
            typeof args === "string" ? args : undefined,
        );
        getView(ctx).focus();
    });
}

/** The toolbar Quote dropdown's callout rows are menuitemcheckbox: the
 * checked row must UNCHECK (lift out), a different kind must move the
 * check (retype the innermost callout in place, title/fold preserved via
 * markerWithKind), and outside any callout it wraps. insertCallout itself
 * stays a plain nest-anywhere insert for the slash/block menus. */
function toggleCallout(getEditor: GetEditor, args?: unknown): void {
    const editor = getEditor();
    if (!editor) { return; }
    const kind = calloutKind(typeof args === "string" ? args : "note");
    editor.action((ctx) => {
        const view = getView(ctx);
        const { $from } = view.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name !== "callout") {
                continue;
            }
            if (calloutKind((node.attrs["kind"] as string) ?? "note") === kind) {
                // Out of the CALLOUT, not out of whatever the caret's own
                // block happens to sit in: plain `lift` in a callout holding a
                // list lifts the paragraph out of its list item, editing the
                // list instead of unchecking the row the user clicked.
                liftBlocksOutOf("callout")(view.state, view.dispatch, view);
            } else {
                const marker = markerWithKind((node.attrs["marker"] as string) ?? "[!NOTE]", kind);
                view.dispatch(view.state.tr.setNodeMarkup(
                    $from.before(depth),
                    null,
                    attrsFromMarker(marker, node.attrs["attached"] as boolean),
                ));
            }
            view.focus();
            return;
        }
        ctx.get(commandsCtx).call(insertCalloutCommand.key as never, kind);
        view.focus();
    });
}

/**
 * Runs a ProseMirror table command against the live view. When `args` carries a
 * `cellPos` (the document position of a right-clicked cell, passed through the
 * context menu), the selection is first moved to that cell so the command
 * targets exactly the cell the user clicked — the ProseMirror selection does not
 * survive VS Code's native context-menu round-trip, so relying on it would make
 * the command a no-op. Without a target it operates on the current selection
 * (command palette / keybinding).
 *
 * If a target WAS supplied but no longer resolves to a cell — e.g. an inbound
 * external-sync diff changed the document between the right-click and the
 * command arriving — bail rather than falling through to the ambient selection,
 * which is exactly the unreliable selection this targeting exists to avoid
 * (acting on it could mutate the wrong row/column). This guards the
 * no-longer-a-cell case; a doc shift that leaves cellPos resolving to a
 * DIFFERENT valid cell can't be detected from position alone and is accepted.
 */
function tableCmd(
    getEditor: GetEditor,
    fn: (state: EditorView["state"], dispatch: EditorView["dispatch"]) => boolean,
    args?: unknown,
): void {
    runProse(getEditor, (view) => {
        const cellPos = (args as { cellPos?: number } | undefined)?.cellPos;
        if (typeof cellPos === "number") {
            if (cellPos < 0 || cellPos > view.state.doc.content.size) {
                return;
            }
            const $cell = cellAround(view.state.doc.resolve(cellPos));
            if (!$cell) {
                return;
            }
            // Right-click inside an existing cell selection acts on THAT
            // selection (align/delete the grip-selected columns), the native
            // convention; a click outside it re-targets the clicked cell.
            // Membership is per-cell (`ranges`), not the flat from/to span —
            // a CellSelection's from/to cover only the anchor/head corners.
            const sel = view.state.selection;
            const clickedInsideSelection =
                sel instanceof CellSelection &&
                sel.ranges.some((r) => cellPos >= r.$from.pos && cellPos <= r.$to.pos);
            if (!clickedInsideSelection) {
                view.dispatch(view.state.tr.setSelection(new CellSelection($cell)));
            }
        }
        fn(view.state, view.dispatch);
        view.focus();
    });
}

/**
 * GFM column alignment (MAR-75): set the `alignment` attr on EVERY cell of the
 * column(s) the selection touches. The header row's attrs drive the serialized
 * `:---:` / `---:` / `:---` markers (serialization.ts reads `node.align` built
 * from the first row), and each body cell's attr drives its rendered
 * `text-align` — so both must move together. Re-picking a column's current
 * alignment TOGGLES it off (attr null → the unmarked `---` separator), which
 * is the only path back to the default in a menu with no state display.
 */
function columnAlignCommand(align: "left" | "center" | "right") {
    return (state: EditorView["state"], dispatch: EditorView["dispatch"]): boolean => {
        const sel = state.selection;
        let $anchorCell;
        let $headCell;
        if (sel instanceof CellSelection) {
            $anchorCell = sel.$anchorCell;
            $headCell = sel.$headCell;
        } else {
            const $cell = cellAround(sel.$from);
            if (!$cell) {
                return false;
            }
            $anchorCell = $cell;
            $headCell = $cell;
        }
        const table = $anchorCell.node(-1);
        const tableStart = $anchorCell.start(-1);
        const map = TableMap.get(table);
        const rect = map.rectBetween($anchorCell.pos - tableStart, $headCell.pos - tableStart);

        // Every cell of every spanned column, header included (deduped —
        // row/col-spanning cells appear at several map slots).
        const cellPositions = new Set<number>();
        for (let col = rect.left; col < rect.right; col++) {
            for (let row = 0; row < map.height; row++) {
                cellPositions.add(map.map[row * map.width + col]!);
            }
        }

        const allAlready = [...cellPositions].every(
            (pos) => table.nodeAt(pos)?.attrs["alignment"] === align,
        );
        const target = allAlready ? null : align;

        const tr = state.tr;
        for (const pos of cellPositions) {
            const cell = table.nodeAt(pos);
            if (!cell || cell.attrs["alignment"] === target) {
                continue;
            }
            tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, alignment: target });
        }
        if (!tr.docChanged) {
            return false;
        }
        dispatch(tr);
        return true;
    };
}

/**
 * The top-level block containing `blockPos` (right-click menus stamp the
 * position under the pointer), or undefined when it doesn't resolve. A caret
 * is the normal state when right-clicking, so "copy the block you clicked"
 * — a paragraph, list, or whole table — is the useful fallback.
 */
function blockContentAt(view: EditorView, blockPos: number): Fragment | undefined {
    if (blockPos < 0 || blockPos > view.state.doc.content.size) { return undefined; }
    const $pos = view.state.doc.resolve(blockPos);
    const node = $pos.depth >= 1 ? $pos.node(1) : ($pos.nodeAfter ?? $pos.nodeBefore);
    return node ? Fragment.from(node) : undefined;
}

/** The selection's content rendered to an HTML string via the schema's toDOM. */
function htmlOfFragment(view: EditorView, content: Fragment): string {
    const domSerializer = DOMSerializer.fromSchema(view.state.schema);
    const fragment = domSerializer.serializeFragment(content);
    const div = document.createElement("div");
    div.appendChild(fragment);
    return div.innerHTML;
}

/**
 * Writes a rich (text/html) clipboard entry with a plain-text fallback flavor.
 * Must run webview-side: vscode.env.clipboard is text-only. The synchronous
 * execCommand path (a one-shot copy listener supplies both flavors) works
 * without focus/permission negotiation; the async clipboard API is the
 * fallback for environments that dropped execCommand.
 */
function writeRichClipboard(html: string, text: string): void {
    const onCopy = (e: ClipboardEvent): void => {
        e.preventDefault();
        // Stop here: ProseMirror's own copy handler (on the editor DOM,
        // reached later in the capture→target path) does not check
        // defaultPrevented and would clear and rewrite both flavors from the
        // live selection — replacing this command's plain rendition with the
        // clipboardTextSerializer's markdown.
        e.stopPropagation();
        e.clipboardData?.setData("text/html", html);
        e.clipboardData?.setData("text/plain", text);
    };
    document.addEventListener("copy", onCopy, true);
    let copied = false;
    try {
        copied = document.execCommand?.("copy") ?? false;
    } catch {
        copied = false;
    } finally {
        document.removeEventListener("copy", onCopy, true);
    }
    if (copied || typeof ClipboardItem === "undefined") { return; }
    navigator.clipboard?.write?.([
        new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
        }),
    ]).catch((err) => console.error("[birta] rich-text copy failed", err));
}

/**
 * Serializes the selection — or, when it's empty, the block under the
 * right-click target — and copies it. "markdown"/"html" hand text to the
 * extension's clipboard; "richText" writes a real HTML clipboard flavor from
 * the webview so rich-text apps paste formatting.
 */
function copySelection(getEditor: GetEditor, format: "html" | "markdown" | "richText", args?: unknown): void {
    const editor = getEditor();
    if (!editor) { return; }
    editor.action((ctx) => {
        const view = getView(ctx);
        const { from, to, empty } = view.state.selection;
        let content: Fragment | undefined;
        if (!empty) {
            content = view.state.doc.slice(from, to).content;
        } else {
            const blockPos = (args as { blockPos?: number } | undefined)?.blockPos;
            if (typeof blockPos !== "number") { return; }
            content = blockContentAt(view, blockPos);
        }
        if (!content) { return; }
        if (format === "markdown") {
            const serializer = ctx.get(serializerCtx);
            const doc = view.state.schema.topNodeType.create(null, content);
            notifyClipboardWrite("markdown", serializer(doc));
        } else if (format === "richText") {
            writeRichClipboard(
                htmlOfFragment(view, content),
                content.textBetween(0, content.size, "\n\n"),
            );
        } else {
            notifyClipboardWrite("html", htmlOfFragment(view, content));
        }
    });
}

/**
 * Paste as Plain Text (Shift+Cmd+V): insert the clipboard's text with no
 * Markdown parsing, so `# Title` stays six literal characters.
 *
 * The text arrives from the extension because a webview cannot read the system
 * clipboard itself — `navigator.clipboard.readText()` needs a permission it is
 * not granted — so `vscode.env.clipboard` reads it and it travels as the
 * command's args.
 *
 * `view.pasteText` is ProseMirror's own paste with `preferPlain` set, which is
 * exactly the flag pasteMarkdown declines on: this command and a browser-native
 * shift-paste therefore land on one code path, not two that can drift. It also
 * keeps pasteLink out of the way — the synthetic event carries no
 * clipboardData, so the URL detector sees an empty string and passes.
 */
function pasteAsPlainText(getEditor: GetEditor, args?: unknown): void {
    const text = (args as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || text === "") { return; }
    runProse(getEditor, (view) => {
        view.focus();
        view.pasteText(text);
    });
}

export type EditorCommandFn = (getEditor: GetEditor, args?: unknown) => void;

/**
 * The action registry. Using `Record<EditorCommandId, …>` makes a missing or
 * misnamed entry a compile error, keeping the registry in lockstep with the
 * shared id list (and therefore with package.json via the drift-guard test).
 */
export const editorCommands: Record<EditorCommandId, EditorCommandFn> = {
    toggleBold: (getEditor) => callCmd(getEditor, toggleStrongCommand),
    toggleItalic: (getEditor) => callCmd(getEditor, toggleEmphasisCommand),
    toggleStrikethrough: (getEditor) => callCmd(getEditor, toggleStrikethroughCommand),
    toggleHighlight: (getEditor) => callCmd(getEditor, toggleHighlightCommand),
    toggleInlineCode: (getEditor) => toggleInlineCode(getEditor),
    clearFormatting: (getEditor) => clearFormatting(getEditor),
    setParagraph: (getEditor) => callCmd(getEditor, turnIntoTextCommand),
    setHeading1: (getEditor) => setHeading(getEditor, 1),
    setHeading2: (getEditor) => setHeading(getEditor, 2),
    setHeading3: (getEditor) => setHeading(getEditor, 3),
    setHeading4: (getEditor) => setHeading(getEditor, 4),
    setHeading5: (getEditor) => setHeading(getEditor, 5),
    setHeading6: (getEditor) => setHeading(getEditor, 6),
    toggleBulletList: (getEditor) => toggleList(getEditor, "bulletList"),
    toggleOrderedList: (getEditor) => toggleList(getEditor, "orderedList"),
    toggleTaskList: (getEditor) => toggleList(getEditor, "taskList"),
    toggleTaskChecked: (getEditor) => toggleTaskChecked(getEditor),
    toggleBlockquote: (getEditor) => toggleBlockquote(getEditor),
    // Optional string arg = fence language ("mermaid" from the slash menu).
    // Retypes the caret's line, so a list line lifts out of its list first —
    // the same reason setHeading does it, and the same result: the line
    // becomes the block and leaves the list.
    insertCodeBlock: (getEditor, args) => {
        const editor = getEditor();
        if (!editor) { return; }
        editor.action((ctx) => {
            liftOutOfLists(getView(ctx), "code_block");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx.get(commandsCtx).call(
                createCodeBlockCommand.key as any,
                typeof args === "string" ? args : undefined,
            );
        });
    },
    insertHorizontalRule: (getEditor) => callCmd(getEditor, insertHorizontalRuleCommand),
    insertTable: (getEditor) => callCmd(getEditor, insertTableCommand, { row: 3, col: 3 }),
    insertLink: () => host.openLinkPrompt?.(),
    // With a caret (no selection): insert the `#` trigger and let the heading
    // autocomplete take over — the picker and the typed-`#` path are ONE
    // mechanism, so the command gets slash-menu dynamics for free (inline
    // type-to-filter with the query chip, arrows/Enter pick, Escape leaves
    // the typed text). With a selection: open the heading picker, which
    // linkifies the selected text to the chosen heading (typing there would
    // overwrite the selection, so it keeps the fixed list).
    // The picker stays lazy (invocation-only UI, out of the launch bundle;
    // cached dynamic import, same pattern as katexLoader) and reads the
    // view's CURRENT state when it opens, so the microtask gap cannot dangle
    // a stale position.
    insertSectionLink: (getEditor) =>
        runProse(getEditor, (view) => {
            const { selection } = view.state;
            const { $from } = selection;
            if (selection.empty && $from.parent.isTextblock && !$from.parent.type.spec.code) {
                // Glued to a word ("foo|"), insert a separating space so the
                // strict whitespace-before-`#` trigger holds; at a block
                // start the armed one-shot allows the bare `#`.
                const prev = $from.parentOffset === 0
                    ? ""
                    : view.state.doc.textBetween(selection.from - 1, selection.from, undefined, "￼");
                const text = prev !== "" && !/\s/.test(prev) ? " #" : "#";
                armBlockStartHeadingComplete();
                view.dispatch(view.state.tr.insertText(text).scrollIntoView());
                view.focus();
                return;
            }
            import("@/components/sectionLink")
                .then((m) => m.openSectionLinkPicker(view))
                .catch((e) => console.error("[birta] section-link picker failed to load", e));
        }),
    // Open the caret's block as editable Markdown (MAR-20). A caret with no
    // block under it (a gap cursor between blocks) no-ops.
    editBlockSource: (getEditor) => runProse(getEditor, (view) => {
        openBlockSource(view);
    }),
    // Follow the link at the caret (MAR-118) — the popup/block-menu routing,
    // palette-invocable. A caret on no link no-ops; focus returns to the
    // editor either way (palette invocations drop it on Quick Open).
    openLink: (getEditor) => runProse(getEditor, (view) => {
        openLinkAtCaret(view);
        view.focus();
    }),
    // Ask Agent (MAR-371): the slash menu's `/ai` row passes `{ prompt }`;
    // the palette passes nothing and the extension asks. The webview only
    // relays: composing the caret's line reference and choosing the route
    // (terminal, Chat view, clipboard) is extension work, where the document
    // can be saved first so the reference names what is on disk.
    askAgent: (getEditor, args) => {
        const prompt = (args as { prompt?: unknown } | undefined)?.prompt;
        // Nothing typed is not an empty request: it is someone who reached
        // for `/ai` and has more to say than a line. That used to open a
        // native input box; it opens the composer now, which is the same
        // question with somewhere to put a file and a model.
        if (typeof prompt !== "string" || prompt.trim() === "") {
            host.openAgentPanel?.(undefined);
            return;
        }
        // Register the request at the caret first (a gutter marker while a
        // background run lives; nothing shows until the extension confirms
        // one), then hand off with its id.
        let requestId = "";
        runProse(getEditor, (view) => { requestId = beginAgentRun(view); });
        notifyAskAgent(prompt, requestId);
    },
    // Always the composer, prefilled with whatever was typed after the row.
    askAgentAdvanced: (_getEditor, args) => {
        const prompt = (args as { prompt?: unknown } | undefined)?.prompt;
        host.openAgentPanel?.(typeof prompt === "string" && prompt.trim() ? prompt : undefined);
    },
    insertImage: () => host.openImagePanel?.(),
    insertMath: (getEditor) => callCmd(getEditor, insertInlineMathCommand),
    insertFootnote: (getEditor) => insertFootnote(getEditor),
    // The clock is read HERE, once per invocation, and never cached. A panel
    // that stays open across midnight is the ordinary case for Birta Writer
    // for Mac, and a date computed when the module loaded would be yesterday's.
    insertDate: (getEditor) =>
        runProse(getEditor, (view) => openDateChooser(view, toCalendarDate(new Date()))),
    insertToday: (getEditor) => insertRelativeDate(getEditor, "today"),
    insertTomorrow: (getEditor) => insertRelativeDate(getEditor, "tomorrow"),
    insertYesterday: (getEditor) => insertRelativeDate(getEditor, "yesterday"),
    // Optional string arg = callout kind ("warning" from the slash menu / picker)
    insertCallout: (getEditor, args) => insertCallout(getEditor, args),
    toggleCallout: (getEditor, args) => toggleCallout(getEditor, args),
    openFind: () => host.openFind?.(),
    openFindReplace: () => host.openFindReplace?.(),
    findNext: () => host.findNext?.(),
    findPrevious: () => host.findPrevious?.(),
    findSelection: () => host.findSelection?.(),
    selectAllOccurrences: () => host.selectAllOccurrences?.(),
    toggleToc: () => host.toggleToc?.(),
    editFrontmatter: () => host.editFrontmatter?.(),
    tableInsertRowAbove: (getEditor, args) => tableCmd(getEditor, addRowBefore, args),
    tableInsertRowBelow: (getEditor, args) => tableCmd(getEditor, addRowAfter, args),
    tableInsertColumnLeft: (getEditor, args) => tableCmd(getEditor, addColumnBefore, args),
    tableInsertColumnRight: (getEditor, args) => tableCmd(getEditor, addColumnAfter, args),
    tableAlignColumnLeft: (getEditor, args) => tableCmd(getEditor, columnAlignCommand("left"), args),
    tableAlignColumnCenter: (getEditor, args) => tableCmd(getEditor, columnAlignCommand("center"), args),
    tableAlignColumnRight: (getEditor, args) => tableCmd(getEditor, columnAlignCommand("right"), args),
    tableDeleteRow: (getEditor, args) => tableCmd(getEditor, deleteRow, args),
    tableDeleteColumn: (getEditor, args) => tableCmd(getEditor, deleteColumn, args),
    tableDeleteTable: (getEditor, args) => tableCmd(getEditor, deleteTable, args),
    copyAsHtml: (getEditor, args) => copySelection(getEditor, "html", args),
    pasteAsPlainText: (getEditor, args) => pasteAsPlainText(getEditor, args),
    copyAsMarkdown: (getEditor, args) => copySelection(getEditor, "markdown", args),
    copyAsRichText: (getEditor, args) => copySelection(getEditor, "richText", args),
    editRawMarkdown: () => host.editRawMarkdown?.(),
    hideToolbar: () => host.hideToolbar?.(),
    showToolbar: () => host.showToolbar?.(),
    customizeToolbar: () => host.customizeToolbar?.(),
    openExtensionSettings: () => host.openExtensionSettings?.(),
    // No host hook: opening the release history needs no editor UI, only the
    // same host handoff the link popup uses. The extension scheme-checks the
    // URL and calls env.openExternal.
    openWhatsNew: () => notifyOpenUrl(RELEASES_URL),
    // No host hook either: the shell owns the window, and the webview's whole
    // part is asking for it.
    openHostPreferences: () => notifyOpenHostPreferences(),
    openKeyboardShortcuts: () => host.openKeyboardShortcuts?.(),
    contentWidthFull: () => host.chooseContentWidth?.("full"),
    contentWidthFixed: () => host.chooseContentWidth?.("fixed"),
    fontEditor: () => host.chooseFontPreset?.("editor"),
    fontSans: () => host.chooseFontPreset?.("sans"),
    fontSerif: () => host.chooseFontPreset?.("serif"),
    fontMono: () => host.chooseFontPreset?.("mono"),
    increaseFontSize: () => host.stepFontSize?.(1),
    decreaseFontSize: () => host.stepFontSize?.(-1),
    resetFontSize: () => host.resetFontSize?.(),
    // The master gate over spelling, grammar and style at once. It never
    // rewrites the three switches under it, so turning it back on restores
    // exactly what was enabled before; `checksMenu.ts` owns that contract and
    // this is the same hook its own gate row calls.
    toggleProofreading: () => host.toggleProofread?.("proofreading"),
    toggleSpellCheck: () => host.toggleProofread?.("spellCheck"),
    toggleGrammarCheck: () => host.toggleProofread?.("grammarCheck"),
    toggleStyleCheck: () => host.toggleProofread?.("styleCheck"),
    // One command for every style-check category, the category in `args`. A
    // command apiece would put fourteen near-identical rows in the palette and
    // fourteen entries in each of the tables an id has to join.
    //
    // The argument is checked against the canonical list rather than cast: this
    // is the one command whose payload comes from outside the page, so a host
    // sending a name that is not a category, or the master-folded `repeated`,
    // must reach nothing. `toggleProofread` takes a `ProofreadOptionKey` and
    // would write a config field of that name.
    toggleStyleOption: (_getEditor, args) => {
        if (typeof args !== "string") { return; }
        if (!STYLE_CATEGORIES.some((d) => d.category === args && d.section !== null)) { return; }
        host.toggleProofread?.(args as ProofreadOptionKey);
    },
    toggleNoteHighlights: () => host.toggleNoteHighlights?.(),
    toggleToolbar: () => host.toggleToolbar?.(),
    // Straight to the mode's owner, which announces to the toolbar button, the
    // body class and the `editable` predicate at once. No host hook: unlike
    // the toolbar and TOC toggles this owns no chrome of its own.
    toggleReadOnly: () => setReadOnly(!isReadOnly()),
    // Same shape as read-only: straight to the mode's owner, no host hook of
    // its own. Focus owns no chrome — it drives the toolbar, TOC and proofread
    // toggles that already exist, through the surfaces `index.ts` wires.
    swapTocSide: () => host.swapTocSide?.(),
    focusReviewSidebar: () => host.focusReviewSidebar?.(),
    // Keyboard canon: same commands the hardcoded ProseMirror keymaps run
    // (blockKeys / smartSelect / insertParagraph), so palette and keyboard
    // can never diverge.
    duplicateBlockUp: (getEditor) => runCommand(getEditor, duplicateSelectedBlocks(-1)),
    duplicateBlockDown: (getEditor) => runCommand(getEditor, duplicateSelectedBlocks(1)),
    moveBlockUp: (getEditor) => runCommand(getEditor, moveSelectedBlocks(-1)),
    moveBlockDown: (getEditor) => runCommand(getEditor, moveSelectedBlocks(1)),
    // Refile (MAR-118): the same by-position machinery the block menu's
    // Indent/Outdent rows drive, resolved from the selection.
    indentBlock: (getEditor) => runCommand(getEditor, (_state, dispatch, view) =>
        !!view && !!dispatch && indentSelection(view)),
    outdentBlock: (getEditor) => runCommand(getEditor, (_state, dispatch, view) =>
        !!view && !!dispatch && outdentSelection(view)),
    deleteBlock: (getEditor) => runCommand(getEditor, deleteSelectedBlocks),
    joinLines: (getEditor) => runCommand(getEditor, joinLinesCommand),
    transformToUppercase: (getEditor) => runCommand(getEditor, transformToUppercase),
    transformToLowercase: (getEditor) => runCommand(getEditor, transformToLowercase),
    transformToTitleCase: (getEditor) => runCommand(getEditor, transformToTitleCase),
    expandSelection: (getEditor) => runCommand(getEditor, expandSelection),
    shrinkSelection: (getEditor) => runCommand(getEditor, shrinkSelection),
    insertParagraphAfter: (getEditor) => runCommand(getEditor, insertParagraphAfter),
    insertParagraphBefore: (getEditor) => runCommand(getEditor, insertParagraphBefore),
    // Keyboard sequence 3 (webview/components/blockMenu/openAtCaret.ts and
    // the shortcuts-help overlay). openBlockMenu does NOT use runCommand:
    // the menu takes focus itself, so refocusing the editor on success would
    // fight it — but a bail (false: inside a table, or a marker-less block)
    // must refocus, or a palette invocation both does nothing AND leaves
    // focus wherever the palette dropped it.
    openBlockMenu: (getEditor) => runProse(getEditor, (view) => {
        if (!openBlockMenuAtCaret(view)) {
            view.focus();
        }
    }),
    openShortcutsHelp: () => host.openShortcutsHelp?.(),
    // No host hook: the flow is the page's, and what it needs from the host is
    // the prompt seam rather than a UI of the editor's. Lazy on purpose — the
    // questions, the composer and the URL builders must cost nothing at launch
    // (webview/feedbackFlow.ts says why it is the page that composes).
    // No host hook: the flow is the page's, and what it needs from the host is
    // the prompt seam rather than a UI of the editor's. Lazy on purpose — the
    // questions, the composer and the URL builders must cost nothing at launch
    // (webview/feedbackFlow.ts says why it is the page that composes).
    //
    // Giving the caret back is this call site's job, for `dateInsert.ts`'s
    // reason: every renderer of a prompt takes focus off the `contenteditable`
    // (a palette input box, an AppKit sheet), and a flow that ended, cancelled
    // or timed out, must not leave the document unable to take a keystroke.
    // `view.focus()` is the whole of it, because ProseMirror's selection lives
    // in the editor STATE rather than in the DOM, so focusing writes back the
    // selection it already holds.
    openHelp: (getEditor) => {
        void import("@/feedbackFlow")
            .then((m) => m.runFeedbackFlow())
            .catch((e) => console.error("[birta] feedback flow failed to load", e))
            .finally(() => runProse(getEditor, (view) => view.focus()));
    },
    // Fold grammar (MAR-110): the same ProseMirror commands the gutter
    // chevrons and block menu drive, so every surface shares one fold state.
    fold: (getEditor) => runCommand(getEditor, foldAtCaret),
    unfold: (getEditor) => runCommand(getEditor, unfoldAtCaret),
    foldAll: (getEditor) => runCommand(getEditor, foldAllCommand),
    unfoldAll: (getEditor) => runCommand(getEditor, unfoldAllCommand),
    // MAR-116: one entry per level, each a thin binding of the shared
    // foldToLevel factory. Seven ids rather than one command taking a
    // level argument, because the palette is the only surface these have
    // and a palette row cannot prompt for a number.
    foldLevel1: (getEditor) => runCommand(getEditor, foldToLevel(1)),
    foldLevel2: (getEditor) => runCommand(getEditor, foldToLevel(2)),
    foldLevel3: (getEditor) => runCommand(getEditor, foldToLevel(3)),
    foldLevel4: (getEditor) => runCommand(getEditor, foldToLevel(4)),
    foldLevel5: (getEditor) => runCommand(getEditor, foldToLevel(5)),
    foldLevel6: (getEditor) => runCommand(getEditor, foldToLevel(6)),
    foldLevel7: (getEditor) => runCommand(getEditor, foldToLevel(7)),
    // Clear every checked box in the caret's task list (one undo step), then
    // refocus — a palette invocation dropped focus on the Quick Open input.
    uncheckAllTasks: (getEditor) => runProse(getEditor, (view) => {
        uncheckAllTasks(view);
        view.focus();
    }),
    // Export as HTML (MAR-32): snapshots the live rendered document and hands
    // it to the host. The module loads on first use through its loader seam,
    // so it costs the launch bundle nothing.
    exportHtml: () => { void exportHtmlLazy(); },
};

/**
 * Dispatches an editor command by id; an unknown id is a safe no-op.
 *
 * In read-only mode a document-changing command is refused here rather than
 * left to no-op against the transaction filter (MAR-53). Two reasons the gate
 * earns a second layer: this is the one place that knows an id, so the refusal
 * can be total for commands that never reach a transaction at all — the ones
 * that open a writing surface (the frontmatter panel, the block-source panel,
 * the block menu) — and it is what lets the chrome dim a control instead of
 * offering a button that silently does nothing. `commandMutates` reads the
 * exhaustive classification in webview/readOnly.ts, so a new command is
 * refused-by-default only after its author has classified it.
 *
 * A command whose host capability this host does not declare is refused the
 * same way (shared/hostProfile.ts): every surface that offers commands
 * hides it, and this is the layer that makes a chord bound to it inert too,
 * so nothing ever posts to a host that cannot answer.
 */
export function runEditorCommand(id: string, getEditor: GetEditor, args?: unknown): void {
    if (!hostHasCommand(id)) { return; }
    if (isReadOnly() && commandMutates(id)) { return; }
    const fn = (editorCommands as Record<string, EditorCommandFn | undefined>)[id];
    fn?.(getEditor, args);
}
