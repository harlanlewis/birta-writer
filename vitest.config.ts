import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    resolve: {
        alias: {
            // 将 vscode 模块重定向到 mock 实现，Extension 侧单元测试所需
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
                "src/MarkdownDocument.ts",
                "webview/utils/**/*.ts",
                // Shared pure logic (messages.ts is type-only — nothing to cover)
                "shared/frontmatterTable.ts",
                "shared/linkTargetSuggest.ts",
                "shared/proofreadFilter.ts",
                // Editor plugins/components with dedicated test suites
                "webview/plugins/linkInputRule.ts",
                "webview/plugins/linkUrlComplete.ts",
                "webview/plugins/list.ts",
                "webview/components/pathLink/linkTargetComplete.ts",
                "webview/components/frontmatter/**/*.ts",
            ],
            thresholds: {
                lines: 70,
                functions: 70,
            },
        },
    },
});
