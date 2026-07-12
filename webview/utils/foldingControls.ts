/**
 * Webview-side fold-affordance visibility: the `<body>` classes ARE the
 * state (baked into the HTML by the provider from `editor.showFoldingControls`
 * / `editor.folding`, kept current by the setFoldingControls echo), so the
 * applier and the readers both go through them — no second copy to drift.
 */
import {
    FOLDING_CONTROLS_BODY_CLASSES,
    FOLDING_DISABLED_BODY_CLASS,
    foldingBodyClasses,
    type FoldingControlsMode,
} from "../../shared/foldingControls";

/** Apply a controls mode + enabled pair as body classes (default = none). */
export function applyFoldingControls(controls: FoldingControlsMode, enabled: boolean): void {
    const active = new Set(foldingBodyClasses(controls, enabled));
    const all = [
        ...Object.values(FOLDING_CONTROLS_BODY_CLASSES).filter((c): c is string => c !== null),
        FOLDING_DISABLED_BODY_CLASS,
    ];
    for (const cls of all) {
        document.body.classList.toggle(cls, active.has(cls));
    }
}

/** Whether the fold layer is enabled, read back from the body class. */
export function foldingEnabled(): boolean {
    return !document.body.classList.contains(FOLDING_DISABLED_BODY_CLASS);
}
