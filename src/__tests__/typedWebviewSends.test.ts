/**
 * Typed-send guard (MAR-166): every extension→webview send must go through the
 * `postToWebview` funnel in src/webviewMessaging.ts, whose parameter is
 * `ToWebviewMessage`. `Webview.postMessage` itself takes `any`, so a raw call
 * site compiles even when its payload has drifted from the protocol — exactly
 * how an untyped `{ type: "..." }` literal rots silently. This test fails the
 * build if a raw `.postMessage(` reappears anywhere in extension source
 * outside the funnel module.
 *
 * Scope: src/ shipped source only (tests excluded — they fake webviews and may
 * name postMessage freely; the webview side has its own typed layer in
 * webview/messaging.ts).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { walkFiles } from "../../shared/__tests__/cjkScanner";

const SRC_ROOT = path.resolve(__dirname, "..");
const FUNNEL = path.join(SRC_ROOT, "webviewMessaging.ts");
const RAW_SEND = /\.postMessage\(/;

describe("typed webview sends", () => {
    it("the matcher should flag a raw send and allow the funnel call", () => {
        expect(RAW_SEND.test("panel.webview.postMessage({ type: 'init' })")).toBe(true);
        expect(RAW_SEND.test("postToWebview(panel.webview, { type: 'init' })")).toBe(false);
    });

    it("extension source should contain no raw .postMessage( outside the funnel module", () => {
        const files = walkFiles(SRC_ROOT, [".ts"], ["__tests__", "test"]).filter(
            (f) => f !== FUNNEL,
        );
        // Guard against a vacuous pass if a future move makes the paths vanish.
        expect(files.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const file of files) {
            const lines = fs.readFileSync(file, "utf8").split("\n");
            lines.forEach((line, idx) => {
                if (RAW_SEND.test(line)) {
                    offenders.push(`${path.relative(SRC_ROOT, file)}:${idx + 1}`);
                }
            });
        }
        expect(
            offenders,
            `Raw .postMessage( found outside src/webviewMessaging.ts — route it through postToWebview:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });
});
