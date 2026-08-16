/**
 * components/codeBlock/graphvizPane.ts
 *
 * Graphviz's adapter onto the shared diagram pane. Pan, zoom, fit, adaptive
 * height and the single-flight render memo all come from `diagramPane.ts`,
 * shared with Mermaid and PlantUML (MAR-30), so a DOT graph gets the same
 * chrome and the same behaviour under resize and rapid edits without any of it
 * being re-implemented here.
 *
 * This is the thinnest of the three adapters, because Graphviz needs neither of
 * the things that made the other two interesting. It stamps absolute `width`
 * and `height` on the root `<svg>`, so the natural size is read straight out of
 * the markup with `readSvgNaturalSize` (PlantUML's, reused rather than
 * re-derived) instead of an off-screen measure host, and nothing untrusted is
 * put in the document to be measured. And it has no theme, so there is no
 * palette to capture before rendering; `graphvizRuntime.ts`'s header holds the
 * argument for why.
 */
import { createDiagramPane, type DiagramPane } from "./diagramPane";
import { readSvgNaturalSize } from "./plantUmlPane";
import {
    graphvizThemeKey,
    isGraphvizDark,
    registerGraphvizInstance,
    renderGraphvizToSvg,
} from "./graphvizRuntime";

export type GraphvizPane = DiagramPane;

export function createGraphvizPane(opts: {
    /** True while this block is a graphviz block AND is showing its preview. */
    isActive: () => boolean;
}): GraphvizPane {
    return createDiagramPane({
        isActive: opts.isActive,
        renderer: {
            classPrefix: "gv",
            async render(code) {
                const svg = await renderGraphvizToSvg(code);
                return { svg, ...readSvgNaturalSize(svg), themeKey: graphvizThemeKey() };
            },
            themeKey: graphvizThemeKey,
            register: registerGraphvizInstance,
            isDark: isGraphvizDark,
        },
    });
}
