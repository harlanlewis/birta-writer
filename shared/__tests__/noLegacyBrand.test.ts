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
 * describe below. `Jot` is retired as a display name and kept as the internal
 * codename, so the patterns above cannot be reused: a rule banning the word
 * outright would fail on the module names, the defaults domain and every
 * comment that says what the codename is for. What is banned is the word
 * reaching a string a person reads, and that lives under `jot/`, which nothing
 * above scans.
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
 * The retired display name, in the shell that used to carry it.
 *
 * `Jot` names a program and a directory and nothing a user reads. The rule is
 * therefore about STRING LITERALS rather than about the word: `BirtaJotCore`,
 * `com.birtalabs.jot`, `BIRTA_JOT_MEASURE`, `JotPanel` and every comment
 * explaining the codename are all legal, and a scan that judged whole lines
 * would fail on all of them and be deleted within a week.
 *
 * The word `Jot` standing ALONE inside a literal is the shape that reaches a
 * person: it is how the name is written in a sentence, and no identifier
 * spells it that way. That is what this bans, case sensitively, so the
 * lowercase stem in a path or a bridge message never enters the question.
 *
 * `jot/Sources` is the scope because that is where the app's own sentences
 * are, and it is the scope the rebrand actually moved: every describe above
 * reads `src/`, `webview/`, `shared/`, `docs/` and the contribution JSON, so
 * the whole Swift shell sat outside the one guard whose job this is. The miss
 * that earned it: `NotesMoveOffer`'s move sheet went on saying "Jot writes to
 * the new location either way" through a rename that touched eighty-odd
 * files, because the sentence is inside a `"""` block and a single-line
 * literal scan cannot see into one.
 */
describe("retired display name", () => {
    const SWIFT_ROOT = path.join(REPO_ROOT, "jot", "Sources");

    /** The word as a sentence writes it, which is the only spelling banned. */
    const RETIRED = /\bJot\b/;

    /**
     * Literals that keep the word, each with the reason it is not a display
     * name. Checked in both directions below: an entry that no longer appears
     * fails, because an exemption nobody removed is a hole nobody can see.
     */
    const ALLOWED: Record<string, string> = {
        "Jot %Y-%m-%d.md":
            "the dated note's filename template. A filename is not branding: the " +
            "word is a short stem in front of a date rather than the app signing " +
            "its work, and AGENTS.md records it as kept on purpose.",
        "Jot":
            "the same stem, used when a typed name sanitizes away to nothing and " +
            "the date has to be hung on something.",
        "Jot \\(f.string(from: Date())).md":
            "the same stem again, in the fixed-locale fallback name a Save a Copy " +
            "As sheet opens on. Interpolated rather than templated, so it reads " +
            "as its own literal here.",
    };

    /**
     * Every string literal in `src`, with its line, comments excluded.
     *
     * Multi-line `"""` blocks are read line by line, because that is where the
     * miss was: a sentence long enough to wrap is exactly the kind that names
     * the product, and a `"[^"]*"` scan finds nothing inside one.
     */
    function literals(src: string): { line: number; text: string }[] {
        const out: { line: number; text: string }[] = [];
        let inBlock = false;
        src.split("\n").forEach((raw, i) => {
            if (inBlock) {
                if (/"""/.test(raw)) { inBlock = false; return; }
                out.push({ line: i + 1, text: raw });
                return;
            }
            if (/"""\s*$/.test(raw) && !/""".*"""/.test(raw)) { inBlock = true; return; }
            if (/^\s*\/\//.test(raw)) { return; }
            for (const m of raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
                out.push({ line: i + 1, text: m[1]! });
            }
        });
        return out;
    }

    const scanned = walkFiles(SWIFT_ROOT, [".swift"], []).map((file) => ({
        rel: path.relative(REPO_ROOT, file),
        found: literals(fs.readFileSync(file, "utf8")),
    }));

    it("the scan should have reached the shell's own strings", () => {
        // An extractor that stopped matching reports a clean shell with total
        // confidence, and every assertion below would pass over nothing.
        expect(scanned.length, "no Swift sources found under jot/Sources").toBeGreaterThan(20);
        const total = scanned.reduce((n, f) => n + f.found.length, 0);
        expect(total, "the literal extractor read almost nothing").toBeGreaterThan(500);
        // And it must reach INTO a multi-line block, which is the case the
        // single-line form cannot see and the one this guard exists for.
        const sheet = scanned.find((f) => f.rel.endsWith("NotesMoveOffer.swift"));
        expect(sheet, "NotesMoveOffer.swift should still be scanned").toBeDefined();
        expect(
            sheet!.found.some((l) => l.text.includes("writes to the new location")),
            'the extractor no longer reads inside a """ block',
        ).toBe(true);
    });

    it("the rule should discriminate, rather than accept or refuse everything", () => {
        // A predicate that says no to everything passes the sweep below on any
        // shell at all; one that says yes to everything could not ship beside
        // the codename. Both halves, on the shapes that actually occur.
        for (const legal of ["BirtaJotCore", "com.birtalabs.jot", "BIRTA_JOT_WEB_DIR",
                             "NSWindow Frame JotPanel", "BirtaJot-", "jot-trace ready",
                             "__jotSaveNow", "BJOT"]) {
            expect(RETIRED.test(legal), `${legal} is an identifier, not a display name`).toBe(false);
        }
        for (const leak of ["Jot writes to the new location either way.",
                            "Birta Writer Jot Settings", "Show Jot", "Quit Jot"]) {
            expect(RETIRED.test(leak), `${leak} should be caught`).toBe(true);
        }
    });

    it("no string the shell shows should carry the retired name", () => {
        const offenders: string[] = [];
        for (const { rel, found } of scanned) {
            for (const { line, text } of found) {
                if (!RETIRED.test(text)) { continue; }
                if (text.trim() in ALLOWED) { continue; }
                offenders.push(`${rel}:${line} ${JSON.stringify(text.trim())}`);
            }
        }
        expect(
            offenders,
            "The retired display name reached a string. Rename it, or — if it is " +
                "a filename stem rather than the app naming itself — record it in " +
                `ALLOWED with the reason:\n${offenders.join("\n")}`,
        ).toEqual([]);
    });

    it("every recorded exemption should still be one", () => {
        const all = scanned.flatMap((f) => f.found.map((l) => l.text.trim()));
        for (const [literal, reason] of Object.entries(ALLOWED)) {
            expect(all, `${literal} is exempt and no longer appears`).toContain(literal);
            expect(reason.length, `${literal} has no reason`).toBeGreaterThan(40);
        }
    });

    it("the bundle should not name itself with the retired name either", () => {
        // Info.plist is the other place the app says what it is called, and it
        // is not source, so the sweep above cannot reach it. `CFBundleExecutable`
        // and `CFBundleIdentifier` are identifiers and spell the codename glued
        // or lowercase, so the same rule reads them correctly.
        const plist = fs.readFileSync(
            path.join(REPO_ROOT, "jot", "Resources", "Info.plist"), "utf8");
        expect(plist, "the plist should still be readable here").toContain("CFBundleName");
        const offenders = plist.split("\n")
            .map((line, i) => ({ line: i + 1, text: line }))
            .filter(({ text }) => RETIRED.test(text))
            .map((o) => `Info.plist:${o.line} ${o.text.trim()}`);
        expect(offenders).toEqual([]);
    });
});
