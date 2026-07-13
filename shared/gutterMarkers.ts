/**
 * Resting gutter-marker visibility shared by the extension (which bakes the
 * initial body class into the webview HTML and broadcasts live changes) and
 * the webview (which applies the class at runtime). Driven by one setting:
 *
 * - `birta.gutterMarkers`: which block grabbers stay visible while
 *   the pointer is elsewhere — `"headings"` (default; the heading level
 *   badges), `"none"`, or `"all"`. Hovering a block always reveals its
 *   grabber regardless of the mode; this only sets the at-rest display.
 */

export const GUTTER_MARKERS_MODES = ["headings", "none", "all"] as const;
export type GutterMarkersMode = (typeof GUTTER_MARKERS_MODES)[number];

export const DEFAULT_GUTTER_MARKERS_MODE: GutterMarkersMode = "headings";

/**
 * Presentation order for pickers (segments, radio rows, QuickPick): fewest
 * to most markers, so the options read as a progression. GUTTER_MARKERS_MODES
 * stays default-first — it's the settings-enum order.
 */
export const GUTTER_MARKERS_DISPLAY_ORDER: readonly GutterMarkersMode[] = ["none", "headings", "all"];

/** Coerce an arbitrary settings value to a known mode (default when unknown). */
export function normalizeGutterMarkersMode(value: unknown): GutterMarkersMode {
    return (GUTTER_MARKERS_MODES as readonly string[]).includes(value as string)
        ? (value as GutterMarkersMode)
        : DEFAULT_GUTTER_MARKERS_MODE;
}

/**
 * The `<body>` class each mode maps to. The default ("headings") is the
 * unclassed state — the stylesheet's baseline — so only the two overriding
 * modes carry a class (see the "Resting gutter markers" rules in style.css).
 */
export const GUTTER_MARKERS_BODY_CLASSES: Readonly<Record<GutterMarkersMode, string | null>> = {
    headings: null,
    none: "gutter-rest-none",
    all: "gutter-rest-all",
};

export function gutterMarkersBodyClass(mode: GutterMarkersMode): string | null {
    return GUTTER_MARKERS_BODY_CLASSES[normalizeGutterMarkersMode(mode)];
}
