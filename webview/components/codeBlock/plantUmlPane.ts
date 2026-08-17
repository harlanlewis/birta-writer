/**
 * components/codeBlock/plantUmlPane.ts
 *
 * PlantUML's adapter onto the shared diagram pane. Pan, zoom, fit, adaptive
 * height and the single-flight (code, theme) render memo all come from
 * `diagramPane.ts`, shared with Mermaid (MAR-30), so a PlantUML diagram gets
 * the same chrome and the same behaviour under resize, theme change and rapid
 * edits without any of it being re-implemented here.
 *
 * Two things are genuinely PlantUML-specific:
 *
 * - **Measuring.** Mermaid needs an off-screen host to measure, because its
 *   output can be width-relative. PlantUML always stamps absolute `width` and
 *   `height` on the root `<svg>`, so the natural size is read straight out of
 *   the markup — no second parse, and nothing untrusted is put in the document
 *   to be measured.
 * - **The canvas.** Mermaid picks a dark palette wholesale; PlantUML is
 *   re-skinned per element (see `plantUmlTheme.ts`) and paints its own page in
 *   the same colour this pane does, so the two agree edge to edge. The class is
 *   toggled per pane rather than on `<body>` because
 *   `birta.plantuml.theme` and `birta.mermaid.theme` are independent — one
 *   document can hold a light Mermaid diagram and a dark PlantUML one.
 */
import { createDiagramPane, type DiagramPane } from "./diagramPane";
import {
    isPlantUmlDark,
    plantUmlThemeKey,
    registerPlantUmlInstance,
    renderPlantUmlToSvg,
} from "./plantUmlRuntime";

export type PlantUmlPane = DiagramPane;

/** Fallback natural size when the markup carries no usable dimensions. */
const FALLBACK_SIZE = { width: 800, height: 600 };

/**
 * CSS absolute-length units to CSS pixels. Graphviz stamps its root `<svg>` in
 * points (`width="62pt"`), and a point is 96/72 of a pixel, so reading the
 * number alone paints every DOT graph at three quarters of its size and caps
 * "fit to view" at that. Unitless and `px` are pixels already.
 */
const UNIT_TO_PX: Record<string, number> = {
    px: 1,
    pt: 96 / 72,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
};

/**
 * The diagram's natural size in CSS pixels, from the root `<svg>`'s
 * `width`/`height`, falling back to its `viewBox` and finally to a fixed size.
 * Attribute-first because PlantUML and Graphviz always emit both and they are
 * the authoritative size; `viewBox` is the safety net for a diagram type that
 * omits them.
 */
export function readSvgNaturalSize(svg: string): { width: number; height: number } {
    const open = svg.match(/<svg\b[^>]*>/i)?.[0];
    if (!open) return FALLBACK_SIZE;

    const attr = (name: string): number => {
        const raw = open.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1]?.trim();
        if (!raw) return NaN;
        const m = raw.match(/^([0-9.]+)\s*([a-z]*)$/i);
        // A percentage (or any relative unit) is about the container, not a
        // natural size, so it falls through to the viewBox.
        if (!m) return NaN;
        const scale = m[2] ? UNIT_TO_PX[m[2].toLowerCase()] : 1;
        const n = parseFloat(m[1]) * (scale ?? NaN);
        return Number.isFinite(n) && n > 0 ? n : NaN;
    };

    const width = attr("width");
    const height = attr("height");
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };

    const viewBox = open.match(/\bviewBox\s*=\s*"([^"]*)"/i)?.[1]?.trim().split(/[\s,]+/);
    if (viewBox?.length === 4) {
        const vbW = parseFloat(viewBox[2]);
        const vbH = parseFloat(viewBox[3]);
        if (vbW > 0 && vbH > 0) return { width: vbW, height: vbH };
    }

    return FALLBACK_SIZE;
}

export function createPlantUmlPane(opts: {
    /** True while this block is a plantuml block AND is showing its preview. */
    isActive: () => boolean;
}): PlantUmlPane {
    // The pane element is needed inside render() to track the canvas class, but
    // only exists once createDiagramPane has returned — hence the holder.
    let el: HTMLElement | null = null;

    const pane = createDiagramPane({
        isActive: opts.isActive,
        renderer: {
            classPrefix: "puml",
            async render(code) {
                // Capture BOTH before rendering: an `auto`-mode theme change
                // mid-render must not be recorded as what this render painted,
                // and the canvas class has to match the palette that was
                // actually used, not the one live when the render settled.
                const themeKey = plantUmlThemeKey();
                const dark = isPlantUmlDark();
                const svg = await renderPlantUmlToSvg(code);
                el?.classList.toggle("puml-canvas-dark", dark);
                return { svg, ...readSvgNaturalSize(svg), themeKey };
            },
            themeKey: plantUmlThemeKey,
            register: registerPlantUmlInstance,
            isDark: isPlantUmlDark,
        },
    });

    el = pane.el;
    return pane;
}
