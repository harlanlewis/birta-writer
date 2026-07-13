/**
 * Webview-side resting block-handle mode: the `<body>` class IS the state
 * (baked into the HTML by the provider, kept current by the setBlockHandles
 * echo), so both the appliers and the readers here go through it — no second
 * copy of the mode to drift. Shared by the message handler and the toolbar's
 * typography-menu radio rows.
 */
import {
    BLOCK_HANDLES_MODES,
    BLOCK_HANDLES_BODY_CLASSES,
    DEFAULT_BLOCK_HANDLES_MODE,
    blockHandlesBodyClass,
    type BlockHandlesMode,
} from "../../shared/blockHandles";

/**
 * Apply a mode as the body class. The default ("headings") is the
 * stylesheet baseline, so applying it means removing both override classes
 * (see "Resting block handles" in style.css).
 */
export function applyBlockHandles(mode: BlockHandlesMode): void {
    const active = blockHandlesBodyClass(mode);
    for (const cls of Object.values(BLOCK_HANDLES_BODY_CLASSES)) {
        if (cls) document.body.classList.toggle(cls, cls === active);
    }
}

/** The mode currently in effect, read back from the body class. */
export function currentBlockHandlesMode(): BlockHandlesMode {
    for (const mode of BLOCK_HANDLES_MODES) {
        const cls = BLOCK_HANDLES_BODY_CLASSES[mode];
        if (cls && document.body.classList.contains(cls)) {
            return mode;
        }
    }
    return DEFAULT_BLOCK_HANDLES_MODE;
}
