/**
 * resolveThemeColors maps a `markdownWriter.colorTheme` setting value to the
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
import { resolveThemeColors } from "../themeManager";

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
