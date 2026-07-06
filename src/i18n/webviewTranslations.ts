/**
 * WebView translation data.
 *
 * Keys are the English base strings passed to t() in the webview
 * (see webview/i18n/index.ts — t() falls back to the key itself when
 * no translation is present, so English is the source language).
 *
 * This file is the only place in src/ or webview/ allowed to contain
 * CJK characters in code; the CJK guard test
 * (shared/__tests__/noCjkLiterals.test.ts) excludes it explicitly.
 */

/** Simplified Chinese translations, served when vscode.env.language starts with "zh". */
export const zhCn: Record<string, string> = {
    "Click to select row · drag to reorder": "点击选中整行 · 拖拽重排",
    "Click to select column · drag to reorder": "点击选中整列 · 拖拽重排",
};

/**
 * Picks the translation map for a VS Code display language. English is the base
 * language: t() falls back to the key itself, so every non-"zh" locale gets an
 * empty map and renders the English source strings. Only a "zh"-prefixed locale
 * receives the zhCn map.
 */
export function selectWebviewTranslations(
    language: string,
): Record<string, string> {
    return language.toLowerCase().startsWith("zh") ? zhCn : {};
}
