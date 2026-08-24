/**
 * components/codeBlock/svgPane.ts
 *
 * A ```svg fence's adapter onto the shared diagram pane (MAR-402). Pan, zoom,
 * fit, adaptive height, the single-flight render memo and the error card all
 * come from `diagramPane.ts`, so an SVG gets the same chrome as Mermaid,
 * PlantUML and Graphviz without any of it being re-implemented here.
 *
 * This is the one diagram with no engine: the fence already holds the picture,
 * so `render` is a sanitize and a measure. It is also the one whose source is
 * the DOCUMENT AUTHOR'S markup rather than an engine's output, which is why
 * `sanitizeSvgMarkup` is not optional and why the natural size is read off the
 * SANITIZED string: what gets measured has to be what gets painted.
 *
 * No theme. The pane paints its own light sheet and the art reads as a sheet of
 * paper, following Graphviz (`graphvizRuntime.ts`'s header holds the argument):
 * recoloring an SVG means rewriting the author's own source for presentation.
 * So the theme key is a constant, and `register` has nothing to subscribe to.
 */
import { createDiagramPane, type DiagramPane } from "./diagramPane";
import { readSvgNaturalSize } from "./plantUmlPane";
import { sanitizeSvgMarkup } from "@/utils/sanitizeLoader";
import { t } from "@/i18n";

export type SvgPane = DiagramPane;

/**
 * Constant, because nothing about an SVG fence depends on the theme. The memo
 * in `diagramPane.ts` is keyed on (code, themeKey), so a fixed key makes it a
 * plain content memo.
 */
const SVG_THEME_KEY = "svg";

/**
 * Does the sanitized markup actually contain a picture?
 *
 * DOMPurify does not throw on input it cannot use: prose comes back as prose,
 * and a fragment whose only element was disallowed comes back empty. Either
 * would reach the pane as "rendered", paint nothing, and skip the natural-size
 * stamp, so the block would sit blank with no way to tell a broken fence from
 * an empty one. Asking for a root `<svg>` is what turns both into the shared
 * error card, which is the same answer every other engine gives for source it
 * cannot draw.
 *
 * Parsed rather than pattern-matched: `<svg` appears in ordinary text, and the
 * question is whether the browser will build an element, which only the parser
 * can answer. The document is inert (`DOMParser`, never attached), and the
 * markup being parsed has already been through the sanitizer.
 */
function containsSvgRoot(clean: string): boolean {
    return new DOMParser().parseFromString(clean, "text/html")
        .body.querySelector("svg") !== null;
}

export function createSvgPane(opts: {
    /** True while this block is an svg block AND is showing its preview. */
    isActive: () => boolean;
}): SvgPane {
    return createDiagramPane({
        isActive: opts.isActive,
        renderer: {
            classPrefix: "svg",
            async render(code) {
                const svg = await sanitizeSvgMarkup(code);
                if (!containsSvgRoot(svg)) {
                    throw new Error(t("No <svg> element to draw"));
                }
                return { svg, ...readSvgNaturalSize(svg), themeKey: SVG_THEME_KEY };
            },
            themeKey: () => SVG_THEME_KEY,
            register: () => () => {},
            isDark: () => false,
        },
    });
}
