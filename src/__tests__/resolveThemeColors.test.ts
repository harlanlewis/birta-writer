/**
 * resolveThemeColors maps a `markdownWysiwyg.colorTheme` setting value to the
 * `--vscode-*` overrides pushed to the webview.
 *
 * The critical case is "auto": it must return an EMPTY map so the webview falls
 * back to VS Code's natively-injected --vscode-* variables, which update live on
 * theme change. Returning colors here would shadow those native variables with
 * inline styles and freeze the theme until the webview reloads (the original
 * "theme doesn't update" bug).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import {
    resolveThemeColors,
    BASE_THEME_DEFAULTS,
    parseColor,
    colorsAreSimilar,
    THEME_COLOR_KEYS,
} from "../themeManager";

/**
 * Register a single pinned built-in theme whose JSON is `themeJson`, then
 * resolve it. Mirrors the "pinned built-in theme" setup so the backfill and
 * selection-contrast branches of getThemeColors are exercised via the public
 * resolveThemeColors entry point.
 */
async function resolvePinnedTheme(themeJson: unknown) {
    (vscode.extensions as unknown as { all: unknown[] }).all = [
        {
            id: "vendor.pinned",
            extensionPath: "/ext/pinned",
            packageJSON: {
                contributes: {
                    themes: [
                        { id: "vendor-pinned", label: "Vendor Pinned", uiTheme: "vs-dark", path: "./pinned.json" },
                    ],
                },
            },
        },
    ];
    (vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new TextEncoder().encode(JSON.stringify(themeJson)),
    );
    return resolveThemeColors("vendor-pinned");
}

describe("resolveThemeColors", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: no custom themes, no installed theme extensions.
        (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
        });
        (vscode.extensions as unknown as { all: unknown[] }).all = [];
    });

    afterEach(() => {
        // Restore the shared singleton mock's default so this file's mutations
        // don't leak into other test files.
        (vscode.extensions as unknown as { all: unknown[] }).all = [];
    });

    it("auto mode should return an empty map so native --vscode-* variables show through", async () => {
        const colors = await resolveThemeColors("auto");
        expect(colors).toEqual({});
    });

    it("an unknown/unresolved theme id should return an empty map", async () => {
        const colors = await resolveThemeColors("Some Uninstalled Theme");
        expect(colors).toEqual({});
    });

    it("a custom theme should map its color ids to --vscode-* variables", async () => {
        (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            get: vi.fn((key: string, defaultValue?: unknown) =>
                key === "customThemes"
                    ? [{ name: "Solar", colors: { "editor.background": "#002b36" } }]
                    : defaultValue,
            ),
        });

        const colors = await resolveThemeColors("custom:Solar");
        expect(colors["--vscode-editor-background"]).toBe("#002b36");
    });

    it("a custom theme id with no matching definition should return an empty map", async () => {
        const colors = await resolveThemeColors("custom:DoesNotExist");
        expect(colors).toEqual({});
    });

    it("a pinned built-in theme should read colors from its theme JSON", async () => {
        (vscode.extensions as unknown as { all: unknown[] }).all = [
            {
                id: "vendor.dark",
                extensionPath: "/ext/dark",
                packageJSON: {
                    contributes: {
                        themes: [
                            { id: "vendor-dark", label: "Vendor Dark", uiTheme: "vs-dark", path: "./dark.json" },
                        ],
                    },
                },
            },
        ];
        (vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
            new TextEncoder().encode(
                JSON.stringify({ type: "dark", colors: { "editor.background": "#123456" } }),
            ),
        );

        const colors = await resolveThemeColors("vendor-dark");
        expect(colors["--vscode-editor-background"]).toBe("#123456");
    });
});

/**
 * The pinned/custom-theme backfill table (BASE_THEME_DEFAULTS) is a hand-written
 * snapshot of VS Code's base-theme defaults. These tests are the "leash" that
 * keeps it from silently rotting: every value must stay a parseable color, the
 * selection-contrast heuristic must keep firing, and keys with no row must still
 * fall through to the webview's native --vscode-* variables.
 */
describe("BASE_THEME_DEFAULTS backfill table", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
            get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
        });
        (vscode.extensions as unknown as { all: unknown[] }).all = [];
    });

    afterEach(() => {
        (vscode.extensions as unknown as { all: unknown[] }).all = [];
    });

    it("every light and dark default value should parse to a valid color", () => {
        for (const [key, { light, dark }] of Object.entries(BASE_THEME_DEFAULTS)) {
            expect(parseColor(light), `${key}.light (${light})`).not.toBeNull();
            expect(parseColor(dark), `${key}.dark (${dark})`).not.toBeNull();
        }
    });

    it("every BASE_THEME_DEFAULTS key should be a member of THEME_COLOR_KEYS", () => {
        // A default for a key the webview never consumes would be dead weight.
        const keySet = new Set(THEME_COLOR_KEYS);
        const orphans = Object.keys(BASE_THEME_DEFAULTS).filter((k) => !keySet.has(k));
        expect(orphans).toEqual([]);
    });

    it("colorsAreSimilar should return true for a near-identical color pair", () => {
        expect(colorsAreSimilar("#1e1e1e", "#1f1f1f")).toBe(true);
    });

    it("colorsAreSimilar should return false for a clearly-distinct color pair", () => {
        expect(colorsAreSimilar("#000000", "#ffffff")).toBe(false);
    });

    it("a pinned theme whose selection background is too close to its background should get the contrast fallback", async () => {
        // Dark theme; selection nearly identical to the background.
        const colors = await resolvePinnedTheme({
            type: "dark",
            colors: {
                "editor.background": "#1e1e1e",
                "editor.selectionBackground": "#1f1f1f",
            },
        });
        expect(colors["--vscode-editor-selectionBackground"]).toBe("rgba(38, 79, 120, 0.6)");
    });

    it("a pinned theme whose selection background is distinct should keep its own selection color", async () => {
        const colors = await resolvePinnedTheme({
            type: "dark",
            colors: {
                "editor.background": "#1e1e1e",
                "editor.selectionBackground": "#264f78",
            },
        });
        expect(colors["--vscode-editor-selectionBackground"]).toBe("#264f78");
    });

    it("a THEME_COLOR_KEYS entry with no backfill row should be absent so CSS uses the native var", async () => {
        // editor.lineHighlightBackground is in THEME_COLOR_KEYS but intentionally
        // has no BASE_THEME_DEFAULTS row — it must not appear in the resolved map.
        expect(BASE_THEME_DEFAULTS["editor.lineHighlightBackground"]).toBeUndefined();
        const colors = await resolvePinnedTheme({
            type: "dark",
            colors: { "editor.background": "#1e1e1e" },
        });
        expect(colors["--vscode-editor-lineHighlightBackground"]).toBeUndefined();
    });
});
