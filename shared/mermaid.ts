/**
 * Mermaid diagram theme mode — shared between the extension host (which reads
 * the `birta.mermaid.theme` setting) and the webview (which renders diagrams).
 *
 * - `light`  — always render on a white canvas with Mermaid's light palette,
 *              regardless of the VS Code theme. The default: a diagram reads
 *              like an embedded image/paper and stays legible everywhere
 *              (matches how GitHub/Notion present diagrams in dark mode).
 * - `dark`   — always render dark (Mermaid's dark palette on a dark surface).
 * - `auto`   — follow the editor: dark palette on dark themes, light on light.
 */
export type MermaidThemeMode = "light" | "dark" | "auto";

/** The valid modes, in Settings-UI order. Kept in sync with the package.json enum. */
export const MERMAID_THEME_MODES = ["light", "dark", "auto"] as const;

export const DEFAULT_MERMAID_THEME_MODE: MermaidThemeMode = "light";

/** Coerce an arbitrary setting value to a known mode, defaulting to `light`. */
export function normalizeMermaidThemeMode(value: string | undefined): MermaidThemeMode {
    return value === "dark" || value === "auto" ? value : DEFAULT_MERMAID_THEME_MODE;
}
