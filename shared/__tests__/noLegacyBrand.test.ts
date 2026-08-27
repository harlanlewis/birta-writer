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
 *
 * The SECOND rebrand has a rule of its own and a scope of its own, in the last
 * describe below. The Mac app's former name was first retired from display
 * strings and kept as an internal codename; the codename itself was then
 * retired too, everywhere: module names, bundle ids, env vars, CSS hooks,
 * filenames and prose all spell Birta Writer (or `mac`, for the surface). The
 * word is therefore banned as a SUBSTRING, case-insensitively, across the
 * whole tree, with shipped history (the changelogs) as the one exemption.
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

/**
 * The retired codename, banned everywhere but history.
 *
 * The Mac app's former name went in two steps: first out of display strings
 * (leaving module names, the bundle id, env vars and a directory spelling it),
 * then out of the identifiers too, because a codename that is also a retired
 * product name misleads everything that touches it — tickets, docs, release
 * assets, the defaults domain a user can list. Since nothing may spell it at
 * all any more, the rule is the simple one the display-string era could not
 * afford: the three letters, case-insensitive, as a substring, anywhere.
 *
 * That strictness is deliberate. A word-boundary rule would miss the glued
 * identifiers (the old module prefix, the old dev bundle id), and an
 * identifier rule would miss prose. The one cost is that no scanned file may
 * use the verb ("jot something down"); rephrase, or carve a considered
 * exemption here if that day comes.
 *
 * Exempt, each with its reason:
 *   - the changelogs and `docs/CHANGELOG-PRE-MARKETPLACE.md`: point-in-time
 *     history naming things as they shipped; policing them would falsify the
 *     record.
 *   - `licenses/`, NOTICE, LICENSE-MIT, THIRD_PARTY_NOTICES.md: generated or
 *     upstream attribution, not our prose.
 *   - `samples/` and `webview/__tests__/fixtures/`: content under test.
 *   - `changelogSplit.test.ts`: it parses shipped history, so its misfile
 *     matcher and fixtures must recognize the spelling history used.
 *   - this file, which needs fixtures for its own matcher.
 */
describe("retired codename", () => {
    const BANNED = /jot/i;

    /** Directory NAMES never descended into, wherever they appear. */
    const SKIP_DIRS = [
        "node_modules", ".git", ".build", "build", "dist", "dist-base",
        "dist-head", "out", "coverage", "releases", ".vscode-test", "fixtures",
        "worktrees",
    ];

    /** Text extensions worth reading; binaries and images are not prose. */
    const EXTS = [
        ".ts", ".mts", ".mjs", ".js", ".css", ".swift", ".sh", ".md", ".json",
        ".yml", ".yaml", ".html", ".plist", ".nls.json",
    ];

    const SCAN_ROOTS = [
        "src", "webview", "shared", "mac", "e2e", "scripts", "docs",
        "packages", ".github", ".claude",
    ];

    const ROOT_FILES = [
        "package.json", "package.nls.json", "AGENTS.md", "CLAUDE.md",
        "README.md", ".vscodeignore", "esbuild.mjs", "vitest.config.ts",
    ];

    const EXEMPT_SUFFIXES = [
        "CHANGELOG.md", // both changelogs
        "CHANGELOG-PRE-MARKETPLACE.md",
        path.join("shared", "__tests__", "noLegacyBrand.test.ts"),
        path.join("shared", "__tests__", "changelogSplit.test.ts"),
    ];

    const files = [
        ...SCAN_ROOTS.flatMap((d) => {
            const root = path.join(REPO_ROOT, d);
            return fs.existsSync(root) ? walkFiles(root, EXTS, SKIP_DIRS) : [];
        }),
        ...ROOT_FILES.map((f) => path.join(REPO_ROOT, f)).filter((f) => fs.existsSync(f)),
    ].filter((f) => !EXEMPT_SUFFIXES.some((suffix) => f.endsWith(suffix)));

    it("the scan should reach the whole tree, not a corner of it", () => {
        // A walker that stopped matching reports a clean tree with total
        // confidence. The floor is far below the real count and far above
        // what a broken walk returns.
        expect(files.length, "the walk found almost nothing").toBeGreaterThan(400);
        for (const mustReach of [
            path.join("mac", "Resources", "Info.plist"),
            path.join("mac", "Sources", "BirtaWriterCore", "AppFlavor.swift"),
            path.join(".github", "workflows", "release.yml"),
            "AGENTS.md",
        ]) {
            expect(
                files.some((f) => f.endsWith(mustReach)),
                `${mustReach} should be scanned`,
            ).toBe(true);
        }
    });

    it("the matcher should catch every spelling the tree ever used", () => {
        for (const leak of [
            "Birta" + "Jot" + "Core", "com.birtalabs." + "jot" + "dev",
            "BIRTA_" + "JOT" + "_MEASURE", "__" + "jot" + "SaveNow",
            "Quit " + "Jot", "the " + "Jot" + " shell",
        ]) {
            expect(BANNED.test(leak), `${leak} should be caught`).toBe(true);
        }
        for (const legal of [
            "BirtaWriterCore", "com.birtalabs.birta-writer-dev",
            "BIRTA_MAC_MEASURE", "__birtaSaveNow", "Birta Writer for Mac",
            "mac/Sources", "e2e/macHost",
        ]) {
            expect(BANNED.test(legal), `${legal} is the current vocabulary`).toBe(false);
        }
    });

    it("nothing in the tree should spell the codename", () => {
        const offenders: string[] = [];
        for (const file of files) {
            const lines = fs.readFileSync(file, "utf8").split("\n");
            lines.forEach((line, idx) => {
                if (BANNED.test(line)) {
                    offenders.push(`${path.relative(REPO_ROOT, file)}:${idx + 1} ${line.trim().slice(0, 120)}`);
                }
            });
        }
        expect(
            offenders,
            `The retired codename is back. Rename it — Birta Writer for the ` +
                `product, mac for the surface — or, for shipped history, keep it ` +
                `in a changelog, which is not scanned:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });
});
