/**
 * The one CSP grant the verify worker needs, declared by every surface that
 * serves the page under a policy (MAR-430).
 *
 * The worker starts from a Blob URL (webview/utils/verifyOracle.ts says why),
 * and a policy with `default-src 'none'` refuses a Blob worker unless
 * `worker-src` says otherwise. A host that dropped the grant would not fail:
 * the oracle retires itself and every sync runs on the main thread, which is
 * the previous behaviour exactly, so the only signal would be a large
 * document that hitches again. This holds the grant where it has to be
 * written, in the two hosts and in the harness pages that mirror them, so the
 * nightly's `mainReparses` ceiling is the second guard and not the first.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

const POLICIES: ReadonlyArray<[what: string, file: string]> = [
    ["the VS Code webview (src/webviewHtml.ts)", "src/webviewHtml.ts"],
    ["the Mac app (mac/Sources/BirtaWriter/WebHost.swift)", "mac/Sources/BirtaWriter/WebHost.swift"],
    ["the launch perf harness page", "e2e/perf/index.html"],
    ["the corpus harness page", "e2e/corpus/index.html"],
    ["the mdx harness page", "e2e/mdx/index.html"],
    ["the verify worker harness page", "e2e/verifyWorker/index.html"],
];

describe("the verify worker's CSP grant", () => {
    it.each(POLICIES)("%s should declare a policy, so the grant below is load-bearing", (_what, file) => {
        const source = readFileSync(join(root, file), "utf8");
        expect(source).toContain("default-src 'none'");
    });

    it.each(POLICIES)("%s should grant a Blob worker and nothing wider", (_what, file) => {
        const source = readFileSync(join(root, file), "utf8");
        const grants = source.match(/worker-src[^;"']*/g) ?? [];
        expect(grants.length, `${file} declares no worker-src`).toBeGreaterThan(0);
        for (const grant of grants) {
            expect(grant.trim()).toBe("worker-src blob:");
        }
    });
});
