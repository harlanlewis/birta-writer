/**
 * shared/fontPresets.ts
 * Editor content font presets shared by the extension (startup injection +
 * live config broadcast) and the webview (toolbar font picker).
 */
import type { FontPreset } from "./messages";

/**
 * The default content-font preset. Must stay in sync with the
 * `markdownWriter.fontPreset` default declared in package.json. Import this in
 * every `getConfiguration().get("fontPreset", …)` call so the code fallback
 * can never diverge from the contributed default.
 */
export const DEFAULT_FONT_PRESET: FontPreset = "mono";

/** Font-family stacks for the non-default presets. */
export const FONT_PRESET_STACKS: Record<Exclude<FontPreset, "default">, string> = {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
    serif: '"Iowan Old Style", "Palatino", Charter, ui-serif, Georgia, serif',
    mono: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
};

/**
 * Resolve the effective content font-family for a preset.
 *
 * A non-default preset always wins over the user's custom `fontFamily` string
 * (otherwise the toolbar picker would silently do nothing for users who set a
 * custom font). "default" falls back to the custom family when set, else null
 * — meaning "inherit the VS Code editor font".
 */
export function resolveFontFamily(preset: FontPreset, customFontFamily: string): string | null {
    if (preset !== "default") {
        return FONT_PRESET_STACKS[preset];
    }
    const trimmed = customFontFamily.trim();
    return trimmed ? trimmed : null;
}
