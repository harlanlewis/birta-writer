/**
 * The fold plugin's key, state shape, and transaction-meta vocabulary
 * (MAR-110), split out of plugins/headingFold so NodeViews (the callout)
 * can dispatch fold metas without importing the full plugin module —
 * headingFold pulls in the block-menu/slash-menu component graph, and the
 * callout component is itself part of that graph (CALLOUT_ICONS feeds the
 * slash registry), so a direct import would be a load-order cycle.
 */
import type { DecorationSet } from "../pm";
import { PluginKey } from "../pm";

export type FoldMeta =
    | { type: "toggle"; pos: number }
    /** Idempotent fold/unfold at one position (block-menu checkbox, ellipsis). */
    | { type: "set"; pos: number; folded: boolean }
    /** Idempotent fold/unfold at several positions (reveal paths, ←/→). */
    | { type: "setMany"; positions: number[]; folded: boolean }
    | { type: "foldAll" }
    | { type: "unfoldAll" }
    /** `editor.folding` flipped: disabling expands every UI-only fold. */
    | { type: "setEnabled"; enabled: boolean }
    /**
     * A block move (menu Move rows / drag-drop): content in [from, to) was
     * deleted and re-inserted with its start at `insertAt` (a FINAL-doc
     * position). Position mapping alone can't follow relocated content —
     * without this meta a collapsed heading's fold entry would land on
     * whatever block filled the old gap, collapsing the wrong section.
     */
    | { type: "move"; from: number; to: number; insertAt: number }
    /**
     * A block deletion (menu Delete): fold entries inside [from, to) die with
     * their heading instead of being position-mapped onto whatever heading
     * fills the gap. (Mapping flags can't express this: a deletion STARTING
     * at the heading maps its entry cleanly onto the next block.)
     */
    | { type: "delete"; from: number; to: number };

/** Back-compat alias from when only headings folded. */
export type HeadingFoldMeta = FoldMeta;

/**
 * Plugin state: the folded block positions (headings AND callouts — one
 * fold grammar) PLUS the cached decoration set and the structural
 * fingerprint it was built for (see plugins/headingFold for the caching
 * contract). `enabled` mirrors `editor.folding`: when false the set is
 * empty and the decoration pass emits zero fold chrome.
 */
export interface FoldPluginState {
    readonly folded: ReadonlySet<number>;
    readonly enabled: boolean;
    readonly decorations: DecorationSet;
    readonly fingerprint: string;
}

/** Back-compat alias from when only headings folded. */
export type HeadingFoldState = FoldPluginState;

export const foldPluginKey = new PluginKey<FoldPluginState>("heading-fold");
/** Back-compat alias from when only headings folded. */
export const headingFoldPluginKey = foldPluginKey;
