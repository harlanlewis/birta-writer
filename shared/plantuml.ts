/**
 * PlantUML diagram theme mode — shared between the extension host (which reads
 * the `birta.plantuml.theme` setting) and the webview (which renders diagrams).
 *
 * Deliberately the same three modes, same order, and same `light` default as
 * `shared/mermaid.ts`: the two settings sit next to each other in the Settings
 * UI and a user who has learned one should not have to learn the other. The
 * default reasoning carries over too — a diagram on a light canvas reads like
 * an embedded image and stays legible under every editor theme.
 *
 * They are separate settings rather than one shared one because the engines
 * theme by different means (Mermaid has first-class dark palettes; PlantUML is
 * re-skinned per element, see `plantUmlTheme.ts`), so a user may reasonably
 * want dark Mermaid and light PlantUML.
 */
export type PlantUmlThemeMode = "light" | "dark" | "auto";

/** The valid modes, in Settings-UI order. Kept in sync with the package.json enum. */
export const PLANTUML_THEME_MODES = ["light", "dark", "auto"] as const;

export const DEFAULT_PLANTUML_THEME_MODE: PlantUmlThemeMode = "light";

/** Coerce an arbitrary setting value to a known mode, defaulting to `light`. */
export function normalizePlantUmlThemeMode(value: string | undefined): PlantUmlThemeMode {
    return value === "dark" || value === "auto" ? value : DEFAULT_PLANTUML_THEME_MODE;
}
