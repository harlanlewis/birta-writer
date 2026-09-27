/**
 * The page-side settings the Mac app declares ON in its boot blob, held
 * against the e2e mac page that restates the blob by hand.
 *
 * `hostProfile.test.ts` holds the three declarers of `host` together; a
 * setting beside it on the blob has no such guard, and a dropped key fails
 * quietly in the direction that matters: the page's default is the VS Code
 * default (off), so the app would lose the Backlinks and Graph tabs in every
 * folder window while the macHost e2e suite stayed green on a page that
 * still says true. Both files are read as text, so a move of either fails
 * here by name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

/** Settings the app turns on for its own surface, with the reason each is the app's. */
const APP_ON_FLAGS = ["folderGraph"] as const;

describe("the Mac app's boot-blob settings", () => {
    const swift = read("mac/Sources/BirtaWriterCore/Bridge.swift");
    const page = read("e2e/macHost/index.html");

    it("the guard reads both declarers", () => {
        expect(swift).toContain("func i18nObject(");
        expect(page).toContain("window.__i18n = {");
    });

    for (const flag of APP_ON_FLAGS) {
        it(`${flag} should be declared on by the app and by the e2e mac page alike`, () => {
            expect(swift, `Bridge.swift's blob no longer turns ${flag} on; the page defaults it off`)
                .toMatch(new RegExp(`"${flag}":\\s*true`));
            expect(page, `e2e/macHost/index.html no longer restates ${flag}: true, so its sweep tests a page the app does not boot`)
                .toMatch(new RegExp(`\\b${flag}:\\s*true`));
        });
    }
});
