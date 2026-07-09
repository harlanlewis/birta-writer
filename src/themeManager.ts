import * as path from "path";
import * as vscode from "vscode";

export interface ThemeInfo {
    id: string;
    label: string;
    uiTheme: string;
    path: string;
    extensionId: string;
}

export interface ThemeColors {
    [key: string]: string;
}

/** Custom theme interface */
export interface CustomTheme {
    name: string;
    colors: Record<string, string>;
}

/** Get user-defined custom themes */
export function getCustomThemes(): CustomTheme[] {
    const config = vscode.workspace.getConfiguration("markdownWysiwyg");
    return config.get<CustomTheme[]>("customThemes", []);
}

// Parse a color string into RGB values
function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
    if (!color) return null;
    color = color.trim();
    
    // Handle rgba(r, g, b, a) format
    const rgbaMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    if (rgbaMatch) {
        return {
            r: parseInt(rgbaMatch[1]),
            g: parseInt(rgbaMatch[2]),
            b: parseInt(rgbaMatch[3]),
            a: rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1,
        };
    }
    
    // Handle #RRGGBB format
    const hexMatch = color.match(/^#([0-9a-f]{6})$/i);
    if (hexMatch) {
        const hex = hexMatch[1];
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: 1,
        };
    }
    
    // Handle #RGB format
    const hexShortMatch = color.match(/^#([0-9a-f]{3})$/i);
    if (hexShortMatch) {
        const hex = hexShortMatch[1];
        return {
            r: parseInt(hex[0] + hex[0], 16),
            g: parseInt(hex[1] + hex[1], 16),
            b: parseInt(hex[2] + hex[2], 16),
            a: 1,
        };
    }
    
    return null;
}

// Detect whether two colors are similar (difference too small)
function colorsAreSimilar(color1: string, color2: string): boolean {
    const c1 = parseColor(color1);
    const c2 = parseColor(color2);
    
    if (!c1 || !c2) return false;
    
    // Compute the color difference (weighted Euclidean distance)
    const dr = c1.r - c2.r;
    const dg = c1.g - c2.g;
    const db = c1.b - c2.b;
    const distance = Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11);
    
    // If the difference is less than 30, consider the colors too close
    return distance < 30;
}

/**
 * Every `--vscode-*` COLOR variable the webview consumes (CSS + inline styles).
 *
 * This list exists only to serve the theme switcher's pinned/custom modes:
 * `getThemeColors` copies every color a pinned theme's JSON defines, then
 * backfills holes from this list via the `defaults` table below (entries
 * without a default fall through to the active theme's native variables).
 * In the default `auto` mode none of this runs — the webview uses VS Code's
 * natively injected variables directly.
 *
 * Invariant, enforced by src/__tests__/themeColorKeys.test.ts: this list is
 * exactly the set of color variables referenced anywhere under webview/ —
 * no dead keys, no unoverridable consumers. Update both together.
 */
export const THEME_COLOR_KEYS = [
    // Editor surface & selection
    "editor.background",
    "editor.foreground",
    "editor.lineHighlightBackground",
    "editor.selectionBackground",
    "editor.hoverHighlightBackground",
    "editorLineNumber.foreground",
    // Find
    "editor.findMatchBackground",
    "editor.findMatchBorder",
    "editor.findMatchHighlightBackground",
    "editor.findMatchHighlightBorder",
    // Base foregrounds & accents
    "foreground",
    "descriptionForeground",
    "errorForeground",
    "focusBorder",
    "contrastActiveBorder",
    "icon.foreground",
    "sash.hoverBorder",
    "symbolIcon.keywordForeground",
    // Diagnostics (proofreading underlines)
    "editorError.foreground",
    "editorWarning.foreground",
    "editorInfo.foreground",
    // Charts palette (callout/directive accents, highlight mark, mermaid button)
    "charts.red",
    "charts.blue",
    "charts.yellow",
    "charts.orange",
    "charts.green",
    "charts.purple",
    // Suggest widget (autocomplete dropdowns)
    "editorSuggestWidget.background",
    "editorSuggestWidget.border",
    "editorSuggestWidget.foreground",
    "editorSuggestWidget.selectedBackground",
    "editorSuggestWidget.selectedForeground",
    // Hover widget (image toolbar, tooltips, popups)
    "editorHoverWidget.background",
    "editorHoverWidget.border",
    "editorHoverWidget.foreground",
    // Generic widgets (find bar, link popup)
    "editorWidget.background",
    "editorWidget.foreground",
    "editorWidget.border",
    "widget.border",
    "widget.shadow",
    // Text content blocks
    "textBlockQuote.background",
    "textBlockQuote.border",
    "textCodeBlock.background",
    "textLink.foreground",
    "textLink.activeForeground",
    "textPreformat.foreground",
    // Panels & chrome
    "sideBar.background",
    "panel.border",
    "toolbar.hoverBackground",
    "toolbar.activeBackground",
    "toolbar.hoverOutline",
    "badge.background",
    // Lists (menus, autocomplete rows)
    "list.activeSelectionBackground",
    "list.activeSelectionForeground",
    "list.hoverBackground",
    "list.dropBackground",
    // Inputs & buttons
    "input.background",
    "input.foreground",
    "input.border",
    "input.placeholderForeground",
    "inputValidation.errorBackground",
    "inputValidation.errorBorder",
    "inputValidation.errorForeground",
    "dropdown.background",
    "dropdown.foreground",
    "dropdown.border",
    "button.background",
    "button.foreground",
    "button.hoverBackground",
    "button.secondaryBackground",
    "button.secondaryForeground",
    "button.secondaryHoverBackground",
    "checkbox.background",
    "checkbox.border",
    // Code block syntax accents (ANSI-derived)
    "terminal.ansiRed",
    "terminal.ansiGreen",
    "terminal.ansiYellow",
    "terminal.ansiBlue",
    "terminal.ansiMagenta",
    "terminal.ansiCyan",
];

export function getAllThemes(): ThemeInfo[] {
    const seen = new Set<string>();
    const themes: ThemeInfo[] = [];

    for (const ext of vscode.extensions.all) {
        const contributes = ext.packageJSON?.contributes;
        if (!contributes?.themes) continue;

        for (const theme of contributes.themes) {
            const key = `${theme.label}|${theme.uiTheme}`;
            if (seen.has(key)) continue;
            seen.add(key);

            themes.push({
                id: theme.id || theme.label,
                label: theme.label,
                uiTheme: theme.uiTheme || "vs-dark",
                path: path.join(ext.extensionPath, theme.path),
                extensionId: ext.id,
            });
        }
    }

    return themes.sort((a, b) => a.label.localeCompare(b.label));
}

export async function getThemeColors(themePath: string): Promise<ThemeColors> {
    try {
        const uri = vscode.Uri.file(themePath);
        const content = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(content);
        const themeJson = JSON.parse(text);

        const colors: ThemeColors = {};

        // First extract all colors defined in the theme file
        if (themeJson.colors) {
            for (const [key, value] of Object.entries(themeJson.colors)) {
                if (typeof value === "string") {
                    colors[`--vscode-${key.replace(/\./g, "-")}`] = value;
                }
            }
        }

        // Ensure all colors in THEME_COLOR_KEYS are included
        // If not defined in the theme file, use the default value
        const isLight = themeJson.type === "light" || themeJson.type === "vs";
        // Backfill for colors a pinned theme's JSON omits, so partial themes
        // don't leave visible holes. Values are VS Code's base-theme defaults.
        // Keys absent here (and colors of themes that define nothing) fall
        // through to the active theme's native --vscode-* variables.
        const defaults: Record<string, string> = {
            "editor.background": isLight ? "#ffffff" : "#1e1e1e",
            "editor.foreground": isLight ? "#333333" : "#d4d4d4",
            "editor.selectionBackground": isLight ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
            "editorLineNumber.foreground": isLight ? "#237893" : "#858585",
            "foreground": isLight ? "#616161" : "#cccccc",
            "descriptionForeground": isLight ? "#717171" : "#a9a9a9",
            "errorForeground": isLight ? "#a1260d" : "#f48771",
            "focusBorder": isLight ? "#0090f1" : "#007fd4",
            "icon.foreground": isLight ? "#424242" : "#c5c5c5",
            "editorError.foreground": isLight ? "#e51400" : "#f14c4c",
            "editorWarning.foreground": isLight ? "#bf8803" : "#cca700",
            "editorInfo.foreground": isLight ? "#1a85ff" : "#3794ff",
            "charts.red": isLight ? "#e51400" : "#f14c4c",
            "charts.blue": isLight ? "#1a85ff" : "#3794ff",
            "charts.yellow": isLight ? "#bf8803" : "#cca700",
            "charts.orange": "#d18616",
            "charts.green": isLight ? "#388a34" : "#89d185",
            "charts.purple": isLight ? "#652d90" : "#b180d7",
            "widget.shadow": isLight ? "rgba(0, 0, 0, 0.16)" : "rgba(0, 0, 0, 0.36)",
            "textBlockQuote.background": isLight ? "rgba(0, 0, 0, 0.05)" : "rgba(128, 128, 128, 0.1)",
            "textBlockQuote.border": "#007acc",
            "textCodeBlock.background": isLight ? "rgba(0, 0, 0, 0.05)" : "rgba(128, 128, 128, 0.1)",
            "textLink.foreground": isLight ? "#006ab1" : "#3794ff",
            "textLink.activeForeground": isLight ? "#006ab1" : "#3794ff",
            "sideBar.background": isLight ? "#f3f3f3" : "#252526",
            "panel.border": isLight ? "#e0e0e0" : "#3c3c3c",
            "toolbar.hoverBackground": isLight ? "rgba(0, 0, 0, 0.1)" : "rgba(128, 128, 128, 0.2)",
            "toolbar.activeBackground": isLight ? "rgba(0, 0, 0, 0.15)" : "rgba(128, 128, 128, 0.3)",
            "list.activeSelectionBackground": isLight ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.1)",
            "list.activeSelectionForeground": isLight ? "#333333" : "#ffffff",
            "list.hoverBackground": isLight ? "rgba(0, 0, 0, 0.05)" : "rgba(255, 255, 255, 0.05)",
            "input.background": isLight ? "#ffffff" : "#3c3c3c",
            "input.foreground": isLight ? "#333333" : "#cccccc",
            "input.border": isLight ? "#cecece" : "#3c3c3c",
            "input.placeholderForeground": isLight ? "#999999" : "#a9a9a9",
            "dropdown.background": isLight ? "#ffffff" : "#3c3c3c",
            "dropdown.foreground": isLight ? "#333333" : "#cccccc",
            "dropdown.border": isLight ? "#cecece" : "#3c3c3c",
            "button.background": isLight ? "#007acc" : "#0e639c",
            "button.foreground": "#ffffff",
            "button.hoverBackground": isLight ? "#0069b3" : "#1177bb",
            "checkbox.background": isLight ? "#ffffff" : "#3c3c3c",
            "checkbox.border": isLight ? "#919191" : "#3c3c3c",
            "terminal.ansiRed": isLight ? "#cd3131" : "#f44747",
            "terminal.ansiGreen": isLight ? "#00bc00" : "#6a9955",
            "terminal.ansiYellow": isLight ? "#949800" : "#d7ba7d",
            "terminal.ansiBlue": isLight ? "#0451a5" : "#569cd6",
            "terminal.ansiMagenta": isLight ? "#bc05bc" : "#d16d9e",
            "terminal.ansiCyan": isLight ? "#0598bc" : "#56b6c2",
        };

        for (const key of THEME_COLOR_KEYS) {
            const cssVar = `--vscode-${key.replace(/\./g, "-")}`;
            if (!colors[cssVar]) {
                const defaultVal = defaults[key];
                if (defaultVal) {
                    colors[cssVar] = defaultVal;
                }
            }
        }

        // Detect whether the selection background color is too close to the background color; if so, use a fallback color
        const bgVar = "--vscode-editor-background";
        const selVar = "--vscode-editor-selectionBackground";

        if (colors[bgVar] && colors[selVar]) {
            if (colorsAreSimilar(colors[bgVar], colors[selVar])) {
                // Use a distinct blue as the fallback selection color
                colors[selVar] = isLight ? "rgba(0, 120, 215, 0.3)" : "rgba(38, 79, 120, 0.6)";
            }
        }

        return colors;
    } catch (e) {
        console.error("[ThemeManager] Failed to read theme:", e);
        return {};
    }
}

/**
 * Resolve the `--vscode-*` color overrides to push to a webview for a given
 * editor theme id (the `markdownWysiwyg.colorTheme` setting value).
 *
 * - `"auto"`: return `{}`. VS Code injects the full `--vscode-*` palette into
 *   every webview and updates it live whenever the active color theme changes,
 *   so in auto mode the webview should use those native variables directly.
 *   Sending inline overrides would shadow the native values (inline styles win
 *   over VS Code's injected `:root {}` block) and freeze the colors until the
 *   webview reloads — the root cause of the "theme doesn't update" bug.
 * - `"custom:<name>"`: map a user-defined custom theme's colors. These aren't
 *   known to VS Code, so they must be pushed explicitly.
 * - a specific built-in theme id: read colors from that theme's JSON so the
 *   editor can intentionally differ from the active workbench theme.
 * - anything unresolved: return `{}` (fall back to VS Code's native palette).
 */
export async function resolveThemeColors(themeId: string): Promise<ThemeColors> {
    // Custom theme (format: custom:themeName)
    if (themeId.startsWith("custom:")) {
        const customThemeName = themeId.slice("custom:".length);
        const customTheme = getCustomThemes().find(t => t.name === customThemeName);
        if (customTheme) {
            const colors: ThemeColors = {};
            for (const [key, value] of Object.entries(customTheme.colors)) {
                colors[`--vscode-${key.replace(/\./g, "-")}`] = value;
            }
            return colors;
        }
        return {};
    }

    // Auto mode: let VS Code's live-updating native variables show through.
    // The colorsAreSimilar selection-contrast fallback in getThemeColors (which
    // substitutes a visible blue when a theme's selection highlight is nearly
    // invisible against its background) is intentionally NOT applied here: auto
    // uses VS Code's own --vscode-editor-selectionBackground verbatim, so
    // selection contrast matches the native editor exactly. Pinned/custom themes
    // below still get the fallback.
    if (themeId === "auto") {
        return {};
    }

    // A specific built-in theme was pinned: read its colors from the theme JSON.
    const theme = getAllThemes().find(t => t.id === themeId);
    if (theme) {
        return await getThemeColors(theme.path);
    }

    return {};
}

export function getThemeTypeString(): string {
    const themeKind = vscode.window.activeColorTheme.kind;
    switch (themeKind) {
        case vscode.ColorThemeKind.Light:
            return "light";
        case vscode.ColorThemeKind.Dark:
            return "dark";
        case vscode.ColorThemeKind.HighContrast:
            return "hc-dark";
        case vscode.ColorThemeKind.HighContrastLight:
            return "hc-light";
        default:
            return "dark";
    }
}
