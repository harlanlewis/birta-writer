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
    | { type: "delete"; from: number; to: number }
    /**
     * MAR-189: build the per-heading affordance decorations the plugin `init`
     * deferred off the mount path. Dispatched once, after first paint, when the
     * document opened with nothing folded (so init's decorations were pure
     * affordance — no content hidden — and safe to defer).
     */
    | { type: "buildAffordance" }
    /**
     * MAR-215: the scroll window moved (plugins/visibleRange.ts). Carries the
     * document range whose gutter chrome is materialized, or null for "the
     * whole document" — the answer with no layout engine, and the pre-windowing
     * behavior. Rebuilds the decorations for the new window.
     */
    | { type: "window"; window: { from: number; to: number } | null };

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
    /**
     * MAR-215: the scroll window the decorations were built for, position-
     * mapped across edits, or null for "the whole document" (no layout engine,
     * or before the first measurement). See plugins/visibleRange.ts.
     */
    readonly window: { from: number; to: number } | null;
    /**
     * The caret's own top-level block, when it sits OUTSIDE `window` — the
     * keyboard block-menu opens against a rendered marker at the caret
     * (components/blockMenu/openAtCaret.ts), so that block is materialized
     * even off screen. Null in the ordinary case (caret on screen), which is
     * what keeps caret movement free of decoration work.
     */
    readonly pinned: { from: number; to: number } | null;
}

/** Back-compat alias from when only headings folded. */
export type HeadingFoldState = FoldPluginState;

export const foldPluginKey = new PluginKey<FoldPluginState>("heading-fold");
/** Back-compat alias from when only headings folded. */
export const headingFoldPluginKey = foldPluginKey;
