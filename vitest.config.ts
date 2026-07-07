import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    resolve: {
        alias: {
            // Redirect the vscode module to the mock implementation (needed by extension-side unit tests)
            vscode: path.resolve(__dirname, "__mocks__/vscode.ts"),
            "@": path.resolve(__dirname, "webview"),
        },
    },
    test: {
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov", "html"],
            include: [
                "src/utils/**/*.ts",
                "shared/**/*.ts",
                "webview/utils/**/*.ts",
                // Shared pure logic (messages.ts is type-only — nothing to cover)
                "shared/frontmatterTable.ts",
                "shared/linkTargetSuggest.ts",
                "shared/proofreadFilter.ts",
                // Editor plugins/components with dedicated test suites
                "webview/plugins/linkInputRule.ts",
                "webview/plugins/linkUrlComplete.ts",
                "webview/plugins/list.ts",
                "webview/plugins/slashMenu.ts",
                "webview/components/pathLink/linkTargetComplete.ts",
                "webview/components/frontmatter/**/*.ts",
                "webview/components/slashMenu/**/*.ts",
            ],
            thresholds: {
                lines: 70,
                functions: 70,
            },
        },
    },
});
