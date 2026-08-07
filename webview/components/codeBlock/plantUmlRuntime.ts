/**
 * components/codeBlock/plantUmlRuntime.ts
 *
 * The PROCESS-WIDE half of PlantUML support: the effective theme, the render
 * entry point, and the registry of live diagrams to repaint when the theme
 * moves. The per-diagram half (pan/zoom, the visible pane, the render memo)
 * belongs to `diagramPane.ts`, exactly as it does for Mermaid.
 *
 * The engine arrives through the cached dynamic `import()` in
 * `utils/plantUmlLoader.ts`, so a document with no ```plantuml fence never
 * pulls ~4 MB of WebAssembly onto the launch path.
 *
 * Unlike Mermaid this module holds no engine singleton to re-initialize:
 * `convert()` is a pure function of (source, skinparams), so a theme change
 * needs no re-init, only a re-render. That is why there is no
 * `plantUmlInitialized` flag mirroring `mermaidInitialized`.
 */
import { loadPlantUml } from "@/utils/plantUmlLoader";
import { isDiagramDark } from "./diagramTheme";
import {
    applyPlantUmlTheme,
    unshiftPlantUmlErrorLines,
    type PlantUmlPalette,
} from "./plantUmlTheme";
import { normalizePlantUmlThemeMode, type PlantUmlThemeMode } from "../../../shared/plantuml";

/** A live diagram that can be asked to repaint (the pane publishes this). */
type PlantUmlInstance = { invalidate: () => void };

const plantUmlInstances = new Set<PlantUmlInstance>();

// The active `birta.plantuml.theme` mode, seeded from the injected config and
// kept current by setPlantUmlThemeMode() when the setting changes live.
let plantUmlThemeMode: PlantUmlThemeMode = normalizePlantUmlThemeMode(window.__i18n?.plantumlTheme);

/** Register a diagram for theme-change repaints; returns its unregister fn. */
export function registerPlantUmlInstance(instance: PlantUmlInstance): () => void {
    plantUmlInstances.add(instance);
    return () => plantUmlInstances.delete(instance);
}

function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Effective dark/light for the current mode. Reads the editor background (a
 * forced `getComputedStyle` reflow) only in `auto` mode — `light`/`dark` are
 * fixed, so on the mount path and on theme events those modes cost nothing.
 */
export function isPlantUmlDark(): boolean {
    return isDiagramDark(
        plantUmlThemeMode,
        plantUmlThemeMode === "auto" ? cssVar("--vscode-editor-background") : "",
    );
}

/**
 * The render memo key. The memo is (code, theme), so a theme change invalidates
 * every diagram naturally — the same contract `mermaidThemeKey()` provides.
 */
export function plantUmlThemeKey(): "dark" | "light" {
    return isPlantUmlDark() ? "dark" : "light";
}

/**
 * The dark palette, read from the live VS Code theme so a diagram tracks the
 * editor instead of a hardcoded set. Null in light mode, where the engine's own
 * palette already suits a light canvas and the source is left untouched.
 */
function currentPalette(): PlantUmlPalette | null {
    if (!isPlantUmlDark()) return null;
    return {
        foreground: cssVar("--vscode-editor-foreground"),
        elementBackground: cssVar("--vscode-textCodeBlock-background"),
        border: cssVar("--vscode-panel-border"),
    };
}

/**
 * Render PlantUML source to SVG markup for the current theme.
 *
 * Rejects with the engine's message, with any "line N" reference shifted back
 * onto the user's own numbering (the dark preamble adds lines the user did not
 * write). A document that reaches for a remote `!theme` or `!include` fails
 * here with the engine's "remote fetch disabled" — deliberately, and the pane
 * surfaces it as the error text.
 */
export async function renderPlantUmlToSvg(code: string): Promise<string> {
    const engine = await loadPlantUml();
    const { source, addedLines } = applyPlantUmlTheme(code, currentPalette());
    try {
        return engine.convert(source);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(unshiftPlantUmlErrorLines(message, addedLines));
    }
}

/**
 * Live-apply a `birta.plantuml.theme` change: update the mode and re-render
 * open diagrams. Their render memos are keyed on the theme, so the repaint
 * is not a no-op.
 */
export function setPlantUmlThemeMode(mode: PlantUmlThemeMode): void {
    if (mode === plantUmlThemeMode) return;
    plantUmlThemeMode = mode;
    for (const instance of plantUmlInstances) instance.invalidate();
}

/**
 * Re-render every PlantUML diagram after a VS Code THEME change. Only `auto`
 * mode can have changed its mind, so the other two modes short-circuit rather
 * than re-running every diagram in the document for nothing.
 */
export function refreshPlantUmlForEditorTheme(): void {
    if (plantUmlThemeMode !== "auto") return;
    for (const instance of plantUmlInstances) instance.invalidate();
}
