import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
    resolve: {
        alias: {
            // Redirect the vscode module to the mock implementation (needed by extension-side unit tests)
            vscode: path.resolve(__dirname, "__mocks__/vscode.ts"),
            "@": path.resolve(__dirname, "webview"),
            // `@kookyleo/plantuml-little-web`'s exports map publishes only `.`
            // and `./wasm`, both leading to the wasm-pack `bundler` entry we
            // deliberately bypass (see webview/utils/plantUmlLoader.ts). The
            // esbuild build resolves these two internals via plantUmlWasmPlugin;
            // this is the same mapping for Vitest, which would otherwise fail
            // every webview suite that transitively reaches the loader.
            "@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.js": path.resolve(
                __dirname,
                "node_modules/@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.js",
            ),
            "@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.wasm": path.resolve(
                __dirname,
                "node_modules/@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.wasm",
            ),
        },
    },
    test: {
        // One heavy harness at a time (e2e/harnessLock.mjs). It lives on the
        // ROOT config, not on a project: globalSetup runs once per vitest
        // process, and both projects are that one process.
        globalSetup: ["./e2e/harnessLock.globalSetup.mjs"],
        // The two suites, formerly `vitest.workspace.ts`. `defineWorkspace` is
        // deprecated in Vitest 3 and removed in 4; `test.projects` is the same
        // thing in the main config, so the split lives here now.
        //
        // Each project re-`extends` this file, which is what pulls in the
        // `resolve.alias` above (the `vscode` mock) plus `exclude` and
        // `sequence` — a project does NOT inherit them otherwise.
        projects: [
            {
                extends: "./vitest.config.ts",
                test: {
                    name: "extension",
                    environment: "node",
                    include: [
                        "src/__tests__/**/*.test.ts",
                        "shared/__tests__/**/*.test.ts",
                        "packages/*/src/__tests__/**/*.test.ts",
                        // Pure e2e helper logic (the launch-A/B gate's decision
                        // math) — NOT the browser-driving runners, which stay
                        // Vitest-excluded.
                        "e2e/**/*.test.mjs",
                    ],
                },
            },
            {
                extends: "./vitest.config.ts",
                test: {
                    name: "webview",
                    environment: "jsdom",
                    include: ["webview/__tests__/**/*.test.ts"],
                    setupFiles: ["./webview/__tests__/setup.ts"],
                },
            },
        ],
        // The @vscode/test-electron integration suite (src/test/**, compiled to
        // out/**) runs in a real Extension Host via Mocha — never under Vitest.
        // It uses bare Mocha globals and the real `vscode` API, so exclude it here.
        exclude: [...configDefaults.exclude, "src/test/**", "out/**"],
        // Pinned, not inherited. `"stack"` runs after-hooks in reverse
        // registration order, which is what puts the timer-clearing `afterAll`
        // in `webview/__tests__/setup.ts` (registered first, so it runs last)
        // AFTER a test file's own `afterAll`. Several files destroy a shared
        // editor there, and destroying arms nine fresh Milkdown timers — under
        // `list`/`parallel` the clear would already have run and those nine
        // would outlive teardown, which is the random CI failure MAR-298 fixed.
        // This is the default today, but vitest's own CLI help advertises
        // `parallel`, so it is spelled out rather than relied upon.
        sequence: { hooks: "stack" },
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov", "html"],
            include: [
                "src/utils/**/*.ts",
                "shared/**/*.ts",
                "webview/utils/**/*.ts",
                "packages/minimal-diff/src/**/*.ts",
                // Shared pure logic (messages.ts is type-only — nothing to cover)
                "shared/frontmatterTable.ts",
                "shared/linkTargetSuggest.ts",
                "shared/proofreadFilter.ts",
                // Editor plugins/components with dedicated test suites
                "webview/plugins/linkInputRule.ts",
                "webview/plugins/linkUrlComplete.ts",
                "webview/plugins/list.ts",
                "webview/plugins/slashMenu.ts",
                "webview/plugins/math.ts",
                "webview/components/pathLink/linkTargetComplete.ts",
                "webview/components/frontmatter/**/*.ts",
                "webview/components/slashMenu/**/*.ts",
                "webview/components/blockMenu/**/*.ts",
                "webview/plugins/headingFold/**/*.ts",
                "webview/components/toolbar/hoverMenu.ts",
                "webview/ui/dom.ts",
                "webview/ui/tooltip.ts",
                "webview/ui/suggestList.ts",
                "webview/components/imageView/imgPathComplete.ts",
                "webview/components/pathLink/pathComplete.ts",
            ],
            thresholds: {
                lines: 70,
                functions: 70,
            },
        },
    },
});
