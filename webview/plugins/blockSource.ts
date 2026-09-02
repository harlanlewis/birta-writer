/**
 * plugins/blockSource — the source-peek plugin (MAR-20).
 *
 * Holds the open panel in plugin state, hides the blocks it stands in for
 * with a node decoration, and mounts the panel itself as a widget. The panel
 * DOM is built ONCE at open and handed back by `toDOM` on every redraw, so a
 * keystroke in the textarea never rebuilds the element under the caret.
 *
 * Ownership: the panel is a plain DOM surface inside the editor, so it must
 * claim the events ProseMirror would otherwise read as document editing.
 * `stopEvent` on the widget spec is what keeps typing in the textarea from
 * reaching the document.
 */
import { $prose } from "@milkdown/utils";
import { parserCtx, serializerCtx } from "@milkdown/core";
import { Decoration, DecorationSet, Plugin, PluginKey, TextSelection } from "../pm";
import { countWork } from "../perf";
import type { EditorState, EditorView, Node as ProseNode, Schema, Transaction } from "../pm";
import { blocksFromSource, sourceOfBlocks, type BlockSourcePipeline } from "../editing/blockSource";
import { createBlockSourcePanel, type BlockSourcePanel } from "../components/blockSource";
import { BlockRangeSelection } from "./blockRange";
import { t } from "../i18n";

export const blockSourceKey = new PluginKey<BlockSourceState>("block-source");

interface OpenPanel {
    /** Document position of the first block the panel stands in for. */
    from: number;
    /** End of the last block the panel stands in for. */
    to: number;
    /** The source as it was opened, so an untouched commit can do nothing. */
    opened: string;
    panel: BlockSourcePanel;
}

type BlockSourceState = OpenPanel | null;

interface OpenMeta {
    open: OpenPanel;
}

/**
 * The top-level blocks the selection touches, as a document range.
 *
 * Top level only: a lone `list_item` has no standalone Markdown spelling, so
 * editing one would return a node of a different type than the one opened.
 */
function blockRangeAt(state: EditorState): { from: number; to: number } | null {
    // BlockRangeSelection.tryCreate IS "snap two positions outward to whole
    // top-level blocks, null when the snapped range holds none", so this
    // reads the same selection grammar the marquee, the block menu and the
    // Escape ladder all speak. Deriving the range from $from.depth instead
    // silently excluded every one of them, because a BlockRangeSelection and
    // a top-level NodeSelection both sit at depth-0 boundaries and have no
    // caret inside a block to walk up from.
    const { from, to } = state.selection;
    const range = BlockRangeSelection.tryCreate(state.doc, from, to);
    return range ? { from: range.from, to: range.to } : null;
}

/** The blocks in `[from, to)`, which are always direct children of the doc. */
function blocksIn(doc: ProseNode, from: number, to: number): ProseNode[] {
    const nodes: ProseNode[] = [];
    doc.forEach((node, offset) => {
        if (offset >= from && offset + node.nodeSize <= to) nodes.push(node);
    });
    return nodes;
}

/**
 * The opener each editor registered, keyed by its (per-instance) Schema, so
 * the contributed command can reach it with only an EditorView in hand. Lazy
 * for the same reason plugins/reparseHazard's registry is: the ctx entries
 * are populated after editor creation.
 */
const openers = new WeakMap<Schema, (view: EditorView) => boolean>();

/**
 * Open the caret's block as Markdown. The entry point for the contributed
 * `birta.editor.editBlockSource` command, which owns the shortcut: the chord
 * lives in package.json so a user can rebind it, and nothing here reads a
 * modifier key.
 */
export function openBlockSource(view: EditorView): boolean {
    return openers.get(view.state.schema)?.(view) ?? false;
}

export const blockSourcePlugin = $prose((ctx) => {
    const pipeline: BlockSourcePipeline = {
        serialize: (doc) => ctx.get(serializerCtx)(doc),
        parse: (markdown) => {
            const out = ctx.get(parserCtx)(markdown);
            return typeof out === "string" || !out ? null : (out as ProseNode);
        },
    };

    const close = (view: EditorView, takeFocus = true) => {
        if (!blockSourceKey.getState(view.state)) return;
        view.dispatch(view.state.tr.setMeta(blockSourceKey, { open: null }));
        if (takeFocus) view.focus();
    };

    const commit = (view: EditorView, text: string, takeFocus = true) => {
        const open = blockSourceKey.getState(view.state);
        if (!open) return;

        // Untouched source closes without a transaction: looking at a block
        // must not dirty the document.
        if (text === open.opened) {
            close(view, takeFocus);
            return;
        }

        const blocks = blocksFromSource(pipeline, view.state.doc, text);
        if (!blocks) {
            open.panel.showError(t("That Markdown could not be parsed."));
            return;
        }

        const tr = view.state.tr;
        tr.setMeta(blockSourceKey, { open: null });
        if (blocks.length === 0) {
            tr.delete(open.from, open.to);
        } else {
            tr.replaceWith(open.from, open.to, blocks);
        }
        const landing = Math.min(tr.mapping.map(open.from) + 1, tr.doc.content.size);
        tr.setSelection(TextSelection.near(tr.doc.resolve(landing)));
        view.dispatch(tr);
        // A save flush banks the panel without the user leaving it, so taking
        // focus there would drop their next keystrokes into the document.
        if (takeFocus) view.focus();
    };

    const open = (view: EditorView): boolean => {
        if (blockSourceKey.getState(view.state)) return false;
        const range = blockRangeAt(view.state);
        if (!range) return false;
        const nodes = blocksIn(view.state.doc, range.from, range.to);
        if (nodes.length === 0) return false;

        const source = sourceOfBlocks(pipeline, view.state.schema, nodes);
        const panel = createBlockSourcePanel(source, {
            commit: (text, takeFocus = true) => commit(view, text, takeFocus),
            cancel: () => close(view),
        });
        const meta: OpenMeta = {
            open: { from: range.from, to: range.to, opened: source, panel },
        };
        view.dispatch(view.state.tr.setMeta(blockSourceKey, meta));
        // The dispatch redraws synchronously, so the widget is already in the
        // document. The frame after is a second attempt for the case where a
        // concurrent redraw re-parents it: the panel reads Escape and
        // Mod+Enter off the textarea, so a panel that never took focus is one
        // the user cannot close.
        panel.focus();
        requestAnimationFrame(() => {
            if (blockSourceKey.getState(view.state)?.panel === panel) panel.focus();
        });
        return true;
    };

    return new Plugin<BlockSourceState>({
        key: blockSourceKey,
        state: {
            init(_config, state: EditorState) {
                openers.set(state.schema, open);
                return null;
            },
            apply(tr: Transaction, value: BlockSourceState): BlockSourceState {
                const meta = tr.getMeta(blockSourceKey) as OpenMeta | { open: null } | undefined;
                if (meta) return meta.open;
                if (!value) return null;
                // A concurrent change (an external edit, a peer's sync) moves
                // the block out from under the panel; follow it rather than
                // committing to a stale range.
                // Non-greedy on both ends: an insertion landing exactly on a
                // boundary belongs OUTSIDE the panel's range. The greedy
                // associativities swallow it, the hide decoration then makes
                // it invisible, and the commit's replaceWith deletes a block
                // the user never saw arrive.
                const from = tr.mapping.map(value.from, 1);
                const to = tr.mapping.map(value.to, -1);
                return from < to ? { ...value, from, to } : null;
            },
        },
        props: {
            decorations(state) {
                const value = blockSourceKey.getState(state);
                if (!value) return DecorationSet.empty;
                const decorations = [
                    Decoration.widget(value.from, () => value.panel.dom, {
                        key: "block-source-panel",
                        side: -1,
                        stopEvent: () => true,
                        ignoreSelection: true,
                    }),
                ];
                // Only the blocks the panel stands in for, walked from the
                // panel's own start: this prop is read on every update while
                // the panel is open, and the document may be large (MAR-431).
                const doc = state.doc;
                let { index, offset } = doc.childAfter(Math.min(value.from, doc.content.size));
                let blocks = 0;
                for (; index < doc.childCount && offset < value.to; index++) {
                    const node = doc.child(index);
                    blocks++;
                    if (offset >= value.from && offset + node.nodeSize <= value.to) {
                        decorations.push(
                            Decoration.node(offset, offset + node.nodeSize, {
                                class: "block-source-hidden",
                            }),
                        );
                    }
                    offset += node.nodeSize;
                }
                countWork("block-source", { blocks });
                return DecorationSet.create(state.doc, decorations);
            },
        },
    });
});
