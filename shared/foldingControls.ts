/**
 * Fold-affordance visibility derived from the user's own VS Code editor
 * configuration — no extension setting of its own (MAR-110). Shared by the
 * extension (which bakes the initial body classes into the webview HTML and
 * re-broadcasts live changes per document) and the webview (which applies
 * the classes at runtime). Two native settings drive it, both read scoped to
 * the document URI because `editor.*` is resource- and language-scoped:
 *
 * - `editor.showFoldingControls`: chevron residency — `"mouseover"`
 *   (default; chevrons reveal on hover, a collapsed block's chevron stays
 *   visible), `"always"` (chevrons resident), `"never"` (no chevrons; folds
 *   and fold commands still work — VS Code semantics).
 * - `editor.folding`: the whole layer. `false` = no chevrons, no collapsed
 *   ellipsis, fold commands no-op, existing UI-only folds expand, and the
 *   decoration pass emits zero fold chrome.
 */

export const FOLDING_CONTROLS_MODES = ["mouseover", "always", "never"] as const;
export type FoldingControlsMode = (typeof FOLDING_CONTROLS_MODES)[number];

export const DEFAULT_FOLDING_CONTROLS_MODE: FoldingControlsMode = "mouseover";

/** Coerce an arbitrary settings value to a known mode (default when unknown). */
export function normalizeFoldingControlsMode(value: unknown): FoldingControlsMode {
    return (FOLDING_CONTROLS_MODES as readonly string[]).includes(value as string)
        ? (value as FoldingControlsMode)
        : DEFAULT_FOLDING_CONTROLS_MODE;
}

/**
 * The `<body>` class each mode maps to. The default ("mouseover") is the
 * unclassed state — the stylesheet's baseline hover-reveal — so only the two
 * overriding modes carry a class (the blockHandles body-class shape).
 */
export const FOLDING_CONTROLS_BODY_CLASSES: Readonly<Record<FoldingControlsMode, string | null>> = {
    mouseover: null,
    always: "fold-controls-always",
    never: "fold-controls-never",
};

/** Body class marking `editor.folding: false` (the layer disabled wholesale). */
export const FOLDING_DISABLED_BODY_CLASS = "folding-disabled";

/**
 * The body classes for a controls mode + enabled pair. Disabled wins: the
 * fold layer is off, so the controls mode is irrelevant (and deliberately
 * not emitted — a disabled feature costs nothing, including CSS matching).
 */
export function foldingBodyClasses(controls: FoldingControlsMode, enabled: boolean): string[] {
    if (!enabled) {
        return [FOLDING_DISABLED_BODY_CLASS];
    }
    const cls = FOLDING_CONTROLS_BODY_CLASSES[normalizeFoldingControlsMode(controls)];
    return cls ? [cls] : [];
}
