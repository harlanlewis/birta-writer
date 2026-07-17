/**
 * PM funnel guard (MAR-100): the webview consumes raw ProseMirror only through
 * the re-export barrel `webview/pm.ts`. A direct `@milkdown/prose/*` import
 * anywhere else silently grows the raw-PM surface outside the one file that
 * inventories it (the evidence base for MAR-101), so this test fails the build
 * on any occurrence.
 *
 * Allowed exceptions:
 * - `webview/pm.ts` — the funnel itself.
 * - `webview/plugins/fidelitySerializer.ts` — vendored from upstream Milkdown;
 *   its imports document its provenance and the file is deliberately kept
 *   diffable against its source.
 *
 * Scope: all of webview/** including tests — test files count toward the
 * inventory too, otherwise the barrel understates what the code depends on.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { walkFiles } from "../../shared/__tests__/cjkScanner";

const WEBVIEW_ROOT = path.resolve(__dirname, "..");
const ALLOWED = new Set([
    path.join(WEBVIEW_ROOT, "pm.ts"),
    path.join(WEBVIEW_ROOT, "plugins", "fidelitySerializer.ts"),
    // This file: the matcher probes below contain import-shaped strings.
    __filename,
]);
// Static `from "@milkdown/prose..."` and dynamic/type `import("@milkdown/prose...")`.
const RAW_PM_IMPORT = /(?:from\s*|import\s*\()\s*["']@milkdown\/prose(?:\/[a-z-]+)?["']/;

describe("PM funnel (webview/pm.ts)", () => {
    it("the matcher should flag direct prose imports and allow funnel imports", () => {
        expect(RAW_PM_IMPORT.test('import { TextSelection } from "@milkdown/prose/state";')).toBe(true);
        expect(RAW_PM_IMPORT.test('import type { Node } from "@milkdown/prose/model";')).toBe(true);
        expect(RAW_PM_IMPORT.test('type Tr = import("@milkdown/prose/state").Transaction;')).toBe(true);
        expect(RAW_PM_IMPORT.test('import { markRule } from "@milkdown/prose";')).toBe(true);
        expect(RAW_PM_IMPORT.test('import { TextSelection } from "@/pm";')).toBe(false);
        expect(RAW_PM_IMPORT.test('import { getView } from "../pm";')).toBe(false);
        // A comment merely mentioning the package name is not an import.
        expect(RAW_PM_IMPORT.test("// mirrors @milkdown/prose markRule")).toBe(false);
    });

    it("webview source should contain no direct @milkdown/prose imports outside the funnel", () => {
        const files = walkFiles(WEBVIEW_ROOT, [".ts"], []).filter((f) => !ALLOWED.has(f));
        // Guard against a vacuous pass if a future move makes the paths vanish.
        expect(files.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const file of files) {
            const lines = fs.readFileSync(file, "utf8").split("\n");
            lines.forEach((line, idx) => {
                if (RAW_PM_IMPORT.test(line)) {
                    offenders.push(`${path.relative(WEBVIEW_ROOT, file)}:${idx + 1}`);
                }
            });
        }
        expect(
            offenders,
            `Direct @milkdown/prose import found outside webview/pm.ts — add the name to the pm barrel and import it from there:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });
});
