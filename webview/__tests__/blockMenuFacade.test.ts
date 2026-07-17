/**
 * Block-menu facade guard (round-2 architecture findings F1/F2): the gutter
 * block menu is consumed only through its facade, and the fold layer never
 * imports component modules.
 *
 * Two invariants, each of which held only by convention before and regressed:
 *
 * 1. `webview/plugins/headingFold/**` imports NOTHING from `components/`.
 *    The fold hub used to import blockMenu internals (openBlockMenu,
 *    wireMarkerDrag, wireMarquee, the range veil), forming a headingFold ⇄
 *    blockMenu package cycle. The inverted wiring now goes through
 *    `plugins/blockHandles.ts` (late-bound registration, the
 *    setDocChangeListener posture) and relocated primitives
 *    (`editing/rangeIndicator.ts`, `foldModel.selectionCoverRange`).
 *
 * 2. `components/blockMenu/index.ts` is the ONE import surface for code
 *    outside the directory. A deep import (`components/blockMenu/drag`,
 *    `.../rangeIndicator`, even `.../index`) grows a shadow public surface
 *    that bypasses the facade — exactly how the fold layer's coupling crept
 *    in. Internal cross-imports between blockMenu's own files stay direct.
 *
 * Scope mirrors pmFunnel.test.ts: all of webview/** including tests — a test
 * reaching into internals couples the suite to the layout the facade exists
 * to hide (vi.mock counts too: mocking an internal path pins it).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { walkFiles } from "../../shared/__tests__/cjkScanner";

const WEBVIEW_ROOT = path.resolve(__dirname, "..");
const BLOCK_MENU_DIR = path.join(WEBVIEW_ROOT, "components", "blockMenu");
const HEADING_FOLD_DIR = path.join(WEBVIEW_ROOT, "plugins", "headingFold");

// Static `from "..."`, dynamic/type `import("...")`, and `vi.mock("...")`
// specifiers that reach INTO the blockMenu directory (any path segment
// `blockMenu/` — including the explicit `blockMenu/index`; the facade is
// imported as `.../blockMenu`, never as a file inside it).
const DEEP_BLOCK_MENU = /(?:from\s*|import\s*\(|vi\.mock\(\s*)["'][^"']*blockMenu\/[^"']+["']/;
// Any import of a component module (relative `../components/...` at any
// depth, or the `@/components/...` alias) from inside the fold directory.
const COMPONENT_IMPORT = /(?:from\s*|import\s*\(|vi\.mock\(\s*)["'][^"']*(?:\.\.\/|@\/)components\/[^"']*["']/;

function offendersIn(files: string[], matcher: RegExp): string[] {
    const offenders: string[] = [];
    for (const file of files) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, idx) => {
            if (matcher.test(line)) {
                offenders.push(`${path.relative(WEBVIEW_ROOT, file)}:${idx + 1}`);
            }
        });
    }
    return offenders;
}

describe("block menu facade (components/blockMenu/index.ts)", () => {
    it("the matchers should flag deep/component imports and allow facade imports", () => {
        expect(DEEP_BLOCK_MENU.test('import { wireMarkerDrag } from "../../components/blockMenu/drag";')).toBe(true);
        expect(DEEP_BLOCK_MENU.test('import { moveRangeAt } from "../blockMenu/index";')).toBe(true);
        expect(DEEP_BLOCK_MENU.test('const { selectionCoverRange } = await import("../components/blockMenu/drag");')).toBe(true);
        expect(DEEP_BLOCK_MENU.test('vi.mock("../components/blockMenu/rangeIndicator", () => ({}));')).toBe(true);
        expect(DEEP_BLOCK_MENU.test('import { closeBlockMenu } from "../components/blockMenu";')).toBe(false);
        expect(DEEP_BLOCK_MENU.test("// see components/blockMenu/drag for the session machinery")).toBe(false);
        expect(COMPONENT_IMPORT.test('import { openBlockMenu } from "../../components/blockMenu";')).toBe(true);
        expect(COMPONENT_IMPORT.test('import { openBlockMenuAtCaret } from "@/components/blockMenu";')).toBe(true);
        expect(COMPONENT_IMPORT.test("// matching the slashMenu plugin ↔ component precedent")).toBe(false);
    });

    it("code outside components/blockMenu should import only the facade, never its internals", () => {
        const files = walkFiles(WEBVIEW_ROOT, [".ts"], []).filter(
            (f) => !f.startsWith(BLOCK_MENU_DIR + path.sep) && f !== __filename,
        );
        expect(files.length).toBeGreaterThan(0);
        const offenders = offendersIn(files, DEEP_BLOCK_MENU);
        expect(
            offenders,
            `Deep import into components/blockMenu — import the name from the facade (components/blockMenu) instead, exporting it there if it is genuinely public:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });

    it("the fold layer (plugins/headingFold) should import no component modules at all", () => {
        const files = walkFiles(HEADING_FOLD_DIR, [".ts"], []);
        expect(files.length).toBeGreaterThan(0);
        const offenders = offendersIn(files, COMPONENT_IMPORT);
        expect(
            offenders,
            `plugins/headingFold imports a component — invert it through plugins/blockHandles.ts (late-bound registration) or relocate the shared primitive to a neutral layer:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });
});
