/**
 * Pure helpers deciding which Mermaid palette (dark vs light) to render a
 * diagram with, kept free of the DOM so they can be unit-tested directly.
 * index.ts reads the live `--vscode-editor-background` at render time and passes
 * it here — the decision itself is pure.
 *
 * Why this exists as its own module: Mermaid is the only consumer that needs a
 * binary dark/light choice derived from the theme (CSS-driven consumers just
 * follow the native `--vscode-*` variables). In `auto` mode — the only mode —
 * that background is whatever VS Code injects, so a robust parse of it is what
 * keeps a diagram's palette matching the editor at first paint and across live
 * theme switches, with no extension-host round-trip.
 */

/** Parse `#rgb` / `#rrggbb` / `rgb()` / `rgba()` into 0–255 channels; null otherwise. */
export function parseRgb(color: string): { r: number; g: number; b: number } | null {
    if (!color) return null;
    const c = color.trim();

    const rgb = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb) {
        return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
    }

    const hex6 = c.match(/^#([0-9a-f]{6})$/i);
    if (hex6) {
        const h = hex6[1];
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }

    const hex3 = c.match(/^#([0-9a-f]{3})$/i);
    if (hex3) {
        const h = hex3[1];
        return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
    }

    return null;
}

/**
 * True when a background color reads as dark, by perceived luminance
 * (0.299·R + 0.587·G + 0.114·B, the standard sRGB weighting), dark below the
 * 128 midpoint. Replaces an older substring heuristic (`!bg.includes("255") &&
 * !bg.includes("fff")`) that mis-classified dark colors happening to contain
 * those substrings. An unparseable or empty background defaults to dark — the
 * safe assumption for a VS Code editor surface, and the historical behavior
 * when the variable was missing.
 */
export function isDarkBackground(bg: string): boolean {
    const rgb = parseRgb(bg);
    if (!rgb) return true;
    const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
    return luminance < 128;
}

/** The Mermaid `theme` value for a given editor background. */
export function mermaidThemeForBackground(bg: string): "dark" | "default" {
    return isDarkBackground(bg) ? "dark" : "default";
}
