/**
 * Pure helpers deciding which Mermaid palette (dark vs light) to render a
 * diagram with, kept free of the DOM so they can be unit-tested directly.
 * mermaidRuntime.ts reads the live `--vscode-editor-background` at render time
 * and passes it here — the decision itself is pure.
 *
 * The colour parsing and the dark/light rule are NOT Mermaid-specific and now
 * live in `diagramTheme.ts`, shared with PlantUML; they are re-exported here so
 * this module's existing import sites and tests are unaffected. What stays is
 * the part that is genuinely about Mermaid: mapping the decision onto Mermaid's
 * own `theme` names.
 *
 * The `birta.mermaid.theme` setting picks the mode: `light`/`dark` force a fixed
 * palette, and only `auto` derives it from the injected background — a robust
 * parse of it is what keeps an auto-mode diagram's palette matching the editor
 * at first paint and across live theme switches, with no extension-host
 * round-trip.
 */

import type { MermaidThemeMode } from "../../../shared/mermaid";
import { isDarkBackground, isDiagramDark } from "./diagramTheme";

export { parseRgb, isDarkBackground } from "./diagramTheme";

/** The Mermaid `theme` value for a given editor background (the `auto` path). */
export function mermaidThemeForBackground(bg: string): "dark" | "default" {
    return isDarkBackground(bg) ? "dark" : "default";
}

/**
 * Whether the Mermaid canvas + palette should render dark, given the user's
 * chosen mode and the live editor background. `light`/`dark` are fixed; only
 * `auto` consults the background. This single boolean drives both the Mermaid
 * `theme` and the canvas background color, so the two never disagree.
 */
export function isMermaidDark(mode: MermaidThemeMode, bg: string): boolean {
    return isDiagramDark(mode, bg);
}
