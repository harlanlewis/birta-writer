/**
 * components/codeBlock/mermaidPane.ts
 *
 * Mermaid's adapter onto the shared diagram pane. Everything that moves the
 * diagram — pan, zoom, fit, adaptive height, the single-flight (code, theme)
 * render memo — lives in `diagramPane.ts` and is shared with PlantUML (MAR-30).
 * What is genuinely Mermaid-specific stays here: the off-screen render and
 * measure, and the theme key the memo is keyed on.
 *
 * Process-wide Mermaid concerns (theme, init, off-screen render) live in
 * `mermaidRuntime.ts`; the NodeView owns whether this pane is visible at all
 * and supplies that as `isActive`.
 */
import { createDiagramPane, type DiagramPane } from "./diagramPane";
import {
    lastInitializedThemeKey,
    mermaidCanvasIsDark,
    mermaidThemeKey,
    registerMermaidInstance,
    renderMermaidToSvg,
} from "./mermaidRuntime";

export type MermaidPane = DiagramPane;

export function createMermaidPane(opts: {
    /** True while this block is a mermaid block AND is showing its preview. */
    isActive: () => boolean;
}): MermaidPane {
    return createDiagramPane({
        isActive: opts.isActive,
        renderer: {
            classPrefix: "mermaid",
            async render(code, width) {
                const { svg, width: w, height: h } = await renderMermaidToSvg(code, width);
                // `lastInitializedThemeKey()` — NOT the live key — is what this
                // render was actually initialized with; the mode may have moved
                // on mid-flight and the memo must record what was painted.
                return { svg, width: w, height: h, themeKey: lastInitializedThemeKey() };
            },
            themeKey: mermaidThemeKey,
            register: registerMermaidInstance,
            isDark: mermaidCanvasIsDark,
        },
    });
}
