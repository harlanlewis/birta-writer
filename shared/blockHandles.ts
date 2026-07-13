/**
 * Resting block-handle visibility shared by the extension (which bakes the
 * initial body class into the webview HTML and broadcasts live changes) and
 * the webview (which applies the class at runtime). Driven by one setting:
 *
 * - `birta.blockHandles`: which block handles stay visible while
 *   the pointer is elsewhere — `"headings"` (default; the heading level
 *   badges), `"always"`, or `"hover"`. Hovering a block always reveals its
 *   handle regardless of the mode; this only sets the at-rest display.
 */

export const BLOCK_HANDLES_MODES = ["headings", "always", "hover"] as const;
export type BlockHandlesMode = (typeof BLOCK_HANDLES_MODES)[number];

export const DEFAULT_BLOCK_HANDLES_MODE: BlockHandlesMode = "headings";

/**
 * Presentation order for pickers (radio rows, QuickPick): most to least
 * visible, so the options read as a progression. BLOCK_HANDLES_MODES stays
 * default-first — it's the settings-enum order.
 */
export const BLOCK_HANDLES_DISPLAY_ORDER: readonly BlockHandlesMode[] = ["always", "headings", "hover"];

/** Coerce an arbitrary settings value to a known mode (default when unknown). */
export function normalizeBlockHandlesMode(value: unknown): BlockHandlesMode {
    return (BLOCK_HANDLES_MODES as readonly string[]).includes(value as string)
        ? (value as BlockHandlesMode)
        : DEFAULT_BLOCK_HANDLES_MODE;
}

/**
 * The `<body>` class each mode maps to. The default ("headings") is the
 * unclassed state — the stylesheet's baseline — so only the two overriding
 * modes carry a class (see the "Resting block handles" rules in style.css).
 */
export const BLOCK_HANDLES_BODY_CLASSES: Readonly<Record<BlockHandlesMode, string | null>> = {
    headings: null,
    hover: "handles-rest-hover",
    always: "handles-rest-always",
};

export function blockHandlesBodyClass(mode: BlockHandlesMode): string | null {
    return BLOCK_HANDLES_BODY_CLASSES[normalizeBlockHandlesMode(mode)];
}
