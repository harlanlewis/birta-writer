/**
 * components/codeBlock/graphvizRuntime.ts
 *
 * The PROCESS-WIDE half of Graphviz support: the render entry point and the
 * registry of live diagrams. The per-diagram half (pan/zoom, the visible pane,
 * the render memo) belongs to `diagramPane.ts`, exactly as for Mermaid and
 * PlantUML.
 *
 * The engine arrives through the cached dynamic `import()` in
 * `utils/graphvizLoader.ts`, shared with the PlantUML path.
 *
 * THERE IS NO THEME HERE, AND THAT IS THE DESIGN, not an omission (MAR-330).
 * Mermaid picks a dark palette wholesale and PlantUML is re-skinned per element
 * by prepending `skinparam` lines, which is safe because `skinparam` is a
 * documented global preamble that does not touch the diagram body. DOT HAS NO
 * EQUIVALENT. Recolouring a graph means rewriting attributes inside the user's
 * own source, which needs a real DOT parser and changes what they wrote; a
 * document's source is not ours to rewrite for presentation.
 *
 * So a Graphviz diagram renders on its own palette and the pane paints a light
 * canvas under it, the way `@startjson` already behaves. The cost is honest and
 * small: the diagram does not follow a dark editor theme, and it says so by
 * looking like a sheet of paper rather than by half-following it. A
 * `birta.graphviz.theme` setting can be added later on evidence; adding one now
 * would be a launch guess, and the repo's convention is few settings with good
 * defaults.
 *
 * The consequence for the shared pane contract: `graphvizThemeKey()` is
 * constant, so the (code, theme) render memo degrades to (code), and
 * `isGraphvizDark()` is always false, so no `theme-changed` listener is needed.
 * Nothing here re-renders on a VS Code theme change because nothing here can
 * have changed its mind.
 */
import { loadGraphviz } from "@/utils/graphvizLoader";

/** A live diagram that can be asked to repaint (the pane publishes this). */
type GraphvizInstance = { invalidate: () => void };

const graphvizInstances = new Set<GraphvizInstance>();

/**
 * Register a diagram for repaints; returns its unregister fn.
 *
 * The set is never iterated today, because no theme can move under a Graphviz
 * diagram. It exists because `DiagramRenderer` requires it and because a future
 * `birta.graphviz.theme` would need exactly this, and it is cheap. Keeping the
 * unregister honest is what stops a destroyed NodeView leaking.
 */
export function registerGraphvizInstance(instance: GraphvizInstance): () => void {
    graphvizInstances.add(instance);
    return () => graphvizInstances.delete(instance);
}

/** Constant: the render memo is keyed on code alone. See the header. */
export function graphvizThemeKey(): string {
    return "graphviz";
}

/** Constant: the canvas is always light. See the header. */
export function isGraphvizDark(): boolean {
    return false;
}

/**
 * Render DOT source to SVG markup.
 *
 * Rejects with the engine's own message, which the pane surfaces as its error
 * text. `dot` is the layout engine rather than the language: Graphviz ships
 * several (`neato`, `fdp`, `circo`, …) and `dot` is the hierarchical one every
 * other tool defaults to, so a graph written for any other renderer lays out
 * the way its author expects.
 */
export async function renderGraphvizToSvg(code: string): Promise<string> {
    const graphviz = await loadGraphviz();
    return graphviz.layout(code, "svg", "dot");
}
