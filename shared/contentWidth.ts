/**
 * Content-width resolution shared by the extension (which injects the initial
 * CSS + broadcasts live changes) and the webview toolbar (the Full Width /
 * Fixed segmented control). Driven by two settings:
 *
 * - `birta.contentWidth`: `"full"` (default; content fills the pane)
 *   or `"fixed"` (capped and centered).
 * - `birta.maxContentWidth`: the fixed measure in `ch` (character
 *   widths), so it tracks a target line length and scales with the content
 *   font size.
 */

export const CONTENT_WIDTH_MODES = ["full", "fixed"] as const;
export type ContentWidthMode = (typeof CONTENT_WIDTH_MODES)[number];

export const DEFAULT_CONTENT_WIDTH_MODE: ContentWidthMode = "full";
export const DEFAULT_MAX_WIDTH_CH = 100;
export const MIN_MAX_WIDTH_CH = 20;

/** Coerce an arbitrary settings value to a known mode (default when unknown). */
export function normalizeContentWidthMode(value: unknown): ContentWidthMode {
    return (CONTENT_WIDTH_MODES as readonly string[]).includes(value as string)
        ? (value as ContentWidthMode)
        : DEFAULT_CONTENT_WIDTH_MODE;
}

/** Clamp the fixed width (ch) to a sane floor, rounding to a whole character. */
export function clampMaxWidthCh(value: number | undefined): number {
    const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_MAX_WIDTH_CH;
    return Math.max(MIN_MAX_WIDTH_CH, Math.round(n));
}

export interface ContentWidthResolution {
    /** CSS value for `--editor-max-width` (`none` or `<ch>ch`). */
    cssValue: string;
    /** Whether the `editor-width-auto` body class (full-width layout) applies. */
    isAuto: boolean;
    /** The resolved mode, for the segmented control's active state. */
    mode: ContentWidthMode;
}

export function resolveContentWidth(mode: ContentWidthMode, maxWidthCh: number): ContentWidthResolution {
    if (mode === "fixed") {
        return { cssValue: `${clampMaxWidthCh(maxWidthCh)}ch`, isAuto: false, mode: "fixed" };
    }
    return { cssValue: "none", isAuto: true, mode: "full" };
}
