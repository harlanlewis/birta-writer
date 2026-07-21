import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
    {
        extends: "./vitest.config.ts",
        test: {
            name: "extension",
            environment: "node",
            include: [
                "src/__tests__/**/*.test.ts",
                "shared/__tests__/**/*.test.ts",
                "packages/*/src/__tests__/**/*.test.ts",
                // Pure e2e helper logic (the launch-A/B gate's decision math) —
                // NOT the browser-driving runners, which stay Vitest-excluded.
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
]);
