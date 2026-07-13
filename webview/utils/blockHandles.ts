/**
 * Webview-side resting gutter-marker mode: the `<body>` class IS the state
 * (baked into the HTML by the provider, kept current by the setGutterMarkers
 * echo), so both the appliers and the readers here go through it — no second
 * copy of the mode to drift. Shared by the message handler, the toolbar's
 * typography-menu segments, and the block menu's radio section.
 */
import {
    GUTTER_MARKERS_MODES,
    GUTTER_MARKERS_BODY_CLASSES,
    DEFAULT_GUTTER_MARKERS_MODE,
    gutterMarkersBodyClass,
    type GutterMarkersMode,
} from "../../shared/gutterMarkers";

/**
 * Apply a mode as the body class. The default ("headings") is the
 * stylesheet baseline, so applying it means removing both override classes
 * (see "Resting gutter markers" in style.css).
 */
export function applyGutterMarkers(mode: GutterMarkersMode): void {
    const active = gutterMarkersBodyClass(mode);
    for (const cls of Object.values(GUTTER_MARKERS_BODY_CLASSES)) {
        if (cls) document.body.classList.toggle(cls, cls === active);
    }
}

/** The mode currently in effect, read back from the body class. */
export function currentGutterMarkersMode(): GutterMarkersMode {
    for (const mode of GUTTER_MARKERS_MODES) {
        const cls = GUTTER_MARKERS_BODY_CLASSES[mode];
        if (cls && document.body.classList.contains(cls)) {
            return mode;
        }
    }
    return DEFAULT_GUTTER_MARKERS_MODE;
}
