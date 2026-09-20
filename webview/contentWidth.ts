/**
 * The document's own width state, put on the page once at boot.
 *
 * Two halves that must not disagree: `--editor-max-width` (the cap, or `none`)
 * and the `editor-width-auto` class (the full-width layout). style.css reads
 * the class to pick which set of margin rules applies and the variable inside
 * those rules, and the fixed set reads it with NO fallback, so a page carrying
 * the class-off half without the variable loses the margin that clears a
 * docked side panel: the whole declaration is invalid at computed-value time,
 * `margin-left` falls back to 0 and the document is drawn under the file list.
 * Writing both here is what keeps the pair from being two things to get right.
 *
 * The DOCUMENT's state and not a menu's, which is why it is applied here
 * rather than by the toolbar that offers the control: a host with no
 * `.editor-topbar` builds no toolbar at all, and one that does builds it after
 * the document has a layout. A host whose boot page already carries both
 * halves (VS Code writes them into the served HTML) re-applies identical
 * values, resolved from the same `shared/contentWidth.ts` that wrote them.
 */
import {
    DEFAULT_CONTENT_WIDTH_MODE,
    DEFAULT_MAX_WIDTH_CH,
    clampMaxWidthCh,
    normalizeContentWidthMode,
    resolveContentWidth,
    type ContentWidthMode,
} from "../shared/contentWidth";
import { hostHas } from "../shared/hostProfile";

/**
 * The mode this surface is in, declared or implied.
 *
 * Without a measure to choose, the answer is always full: the host's own
 * window is the measure, and a stored "fixed" from a host that had the control
 * would otherwise cap the text at a width nothing on this surface can change.
 */
export function bootContentWidthMode(): ContentWidthMode {
    return hostHas("contentMeasure")
        ? normalizeContentWidthMode(window.__i18n?.contentWidth ?? DEFAULT_CONTENT_WIDTH_MODE)
        : "full";
}

/** Put both halves of the declared width state on the document. */
export function applyBootContentWidth(): void {
    const { cssValue, isAuto } = resolveContentWidth(
        bootContentWidthMode(),
        clampMaxWidthCh(window.__i18n?.maxContentWidth ?? DEFAULT_MAX_WIDTH_CH),
    );
    document.documentElement.style.setProperty("--editor-max-width", cssValue);
    document.body.classList.toggle("editor-width-auto", isAuto);
}
