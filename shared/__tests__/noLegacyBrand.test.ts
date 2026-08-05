/**
 * Rebrand guard: the extension was renamed from "WYSIWYG Markdown Editor" /
 * md-wysiwyg-editor to Birta Writer, and its settings/command namespace moved
 * from `markdownWysiwyg.*` to `birta.*`. This test fails the build if the old
 * namespace or display name reappears in shipped source or in the contribution
 * surface (package.json / NLS bundles) — the exact way a copy-pasted snippet or
 * a branch merge can silently reintroduce it (as nearly happened when the
 * block-handles work landed on top of the rename).
 *
 * Scope mirrors the CJK guard: source under src/, webview/, shared/ plus the
 * user-facing JSON — and `docs/`, which is published prose a user acts on: a
 * stale `markdownWysiwyg.*` key there is a setting they will type and find
 * missing, which is exactly the failure this guard exists to prevent, yet it
 * sat outside the scan. CHANGELOG.md is intentionally NOT scanned — it is
 * point-in-time history and names settings/commands as they shipped. The
 * patterns below match only OUR former owner/slug and id — another owner's
 * repository that happens to share the old name is not our brand and is not
 * matched, which is what keeps the required attribution in NOTICE/LICENSE-MIT
 * (both unscanned) from tripping a guard aimed at ourselves.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { walkFiles } from "./cjkScanner";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCANNED_DIRS = ["src", "webview", "shared"];
const CONTRIB_FILES = ["package.json", "package.nls.json", "l10n/bundle.l10n.json"];

const LEGACY: { label: string; re: RegExp }[] = [
    { label: "old settings/command namespace `markdownWysiwyg.*`", re: /markdownWysiwyg/ },
    { label: 'old display name "WYSIWYG Markdown Editor"', re: /WYSIWYG Markdown Editor/ },
    // Only our own former owner/slug pair is banned — another owner's repository
    // of the same name is somebody else's, and is deliberately not matched.
    { label: "old repository slug `harlanlewis/md-wysiwyg-editor`", re: /harlanlewis\/md-wysiwyg-editor/ },
    // The publisher moved to the Birta Labs org (`BirtaLabs.birta-writer`).
    // Only the DOT-qualified extension ids are banned — the slash form
    // `harlanlewis/birta-writer` is the live GitHub repo slug and stays legal.
    { label: "pre-org qualified extension id `harlanlewis.<extension>`", re: /harlanlewis\.(birta-writer|md-wysiwyg-editor)/ },
];

function scan(files: string[]): string[] {
    const offenders: string[] = [];
    for (const file of files) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, idx) => {
            for (const { label, re } of LEGACY) {
                if (re.test(line)) {
                    offenders.push(`${path.relative(REPO_ROOT, file)}:${idx + 1} (${label})`);
                }
            }
        });
    }
    return offenders;
}

describe("rebrand guard", () => {
    it("matchers should flag legacy identifiers and allow the upstream reference", () => {
        expect(LEGACY[0].re.test("birta.smartLinks")).toBe(false);
        expect(LEGACY[0].re.test("markdownWysiwyg.smartLinks")).toBe(true);
        expect(LEGACY[1].re.test("Birta Writer")).toBe(false);
        expect(LEGACY[1].re.test("WYSIWYG Markdown Editor")).toBe(true);
        expect(LEGACY[2].re.test("github.com/someone-else/md-wysiwyg-editor")).toBe(false);
        expect(LEGACY[2].re.test("github.com/harlanlewis/md-wysiwyg-editor")).toBe(true);
        expect(LEGACY[3].re.test("github.com/harlanlewis/birta-writer")).toBe(false);
        expect(LEGACY[3].re.test("BirtaLabs.birta-writer")).toBe(false);
        expect(LEGACY[3].re.test("harlanlewis.birta-writer")).toBe(true);
        expect(LEGACY[3].re.test("harlanlewis.md-wysiwyg-editor")).toBe(true);
    });

    it("source under src/, webview/ and shared/ should use only the birta.* namespace and Birta Writer name", () => {
        const files = SCANNED_DIRS.flatMap((d) =>
            walkFiles(path.join(REPO_ROOT, d), [".ts", ".css"], ["__tests__"]),
        );
        // Guard against a vacuous pass if a future move makes the paths vanish.
        expect(files.length).toBeGreaterThan(0);
        const offenders = scan(files);
        expect(
            offenders,
            `Legacy brand/namespace found in source:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });

    it("published docs should name only the birta.* namespace and Birta Writer", () => {
        // README.md and NOTICE stay unscanned (legitimate upstream attribution
        // lives there); docs/ carries one exception, for the same reason
        // CHANGELOG.md is unscanned rather than a new one.
        //
        // CHANGELOG-PRE-MARKETPLACE.md IS CHANGELOG.md's older half: the
        // pre-rebrand releases were split out of it so the shipped changelog
        // covers only versions a user could install (MAR-282). It is
        // point-in-time history naming settings as they shipped — 0.2.3's entry
        // deprecating `markdownWysiwyg.autoSave` is a true statement about
        // 0.2.3 — so policing it would mean falsifying the record. Nothing here
        // is a live instruction: every version it names predates the listing.
        const files = walkFiles(path.join(REPO_ROOT, "docs"), [".md"], []).filter(
            (f) => path.basename(f) !== "CHANGELOG-PRE-MARKETPLACE.md",
        );
        expect(files.length).toBeGreaterThan(0);
        const offenders = scan(files);
        expect(
            offenders,
            `Legacy brand/namespace found in docs/:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });

    it("package.json and NLS bundles should carry no legacy brand/namespace", () => {
        const files = CONTRIB_FILES.map((rel) => path.join(REPO_ROOT, rel)).filter((f) =>
            fs.existsSync(f),
        );
        expect(files.length).toBeGreaterThan(0);
        const offenders = scan(files);
        expect(
            offenders,
            `Legacy brand/namespace found in contributions:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });
});
