/**
 * The `/ai` progress reader, held across the two languages that implement it.
 *
 * `src/agentBridge/agentProgress.ts` is the source; the Mac app cannot import
 * it, so `mac/Sources/BirtaWriterCore/AgentProgress.swift` restates it. The
 * cases in `shared/__fixtures__/agentProgressCases.json` catch a port that
 * behaves differently on anything somebody thought of, and both suites read
 * that file. This catches the two things a case list cannot.
 *
 * The first is the constants and words the two readers share: a line's length,
 * the buffer cap, the tail kept for a failure report, the throttle's window,
 * the keys a tool call is named by, the escape patterns stripped, and the words
 * a line is built from. Each is a number or a string that would drift silently,
 * because a fixture written against one side's value passes on both.
 *
 * The second is that the cases are still being read at all. A guard names the
 * files it reads, so moving or renaming the fixture empties both suites while
 * they go on passing; this fails when either one stops naming it.
 *
 * The extraction is self-validating: every pattern below is read out of the
 * TypeScript and rebuilt, and a read that matched nothing throws rather than
 * comparing two things this file invented.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TS_PATH = "src/agentBridge/agentProgress.ts";
const ASK_PATH = "src/agentBridge/askAgent.ts";
const SWIFT_PATH = "mac/Sources/BirtaWriterCore/AgentProgress.swift";
const FIXTURE = "shared/__fixtures__/agentProgressCases.json";
const TS_TEST = "src/__tests__/agentProgress.test.ts";
const SWIFT_TEST = "mac/Tests/BirtaWriterCoreTests/AgentProgressTests.swift";

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** The one capture of `pattern` in `rel`, or a failure naming what was sought. */
function one(rel: string, pattern: RegExp, what: string): string {
    const match = pattern.exec(read(rel));
    if (match === null || match[1] === undefined) {
        throw new Error(`no ${what} found in ${rel}; this guard must follow it`);
    }
    return match[1];
}

/** Every capture of `pattern` in `rel`, which must find at least one. */
function all(rel: string, pattern: RegExp, what: string): string[] {
    const found = [...read(rel).matchAll(pattern)].map((m) => m[1]!);
    if (found.length === 0) {
        throw new Error(`no ${what} found in ${rel}; this guard must follow it`);
    }
    return found;
}

describe("the /ai progress reader across TypeScript and Swift", () => {
    it("the numbers both readers bound a line and a buffer by should agree", () => {
        const pairs: [string, string, string][] = [
            // [what, the TypeScript's value, the Swift's]
            ["the display line's length",
                one(TS_PATH, /PROGRESS_LINE_MAX = (\d+)/, "PROGRESS_LINE_MAX"),
                one(SWIFT_PATH, /lineMax = (\d+)/, "lineMax")],
            ["the tail kept for a failure report",
                one(TS_PATH, /SAID_MAX = (\d+)/, "SAID_MAX"),
                one(SWIFT_PATH, /saidMax = (\d+)/, "saidMax")],
            ["the unbounded-line cap",
                one(TS_PATH, /MAX_PENDING = (\d+ \* \d+)/, "MAX_PENDING"),
                one(SWIFT_PATH, /maxPending = (\d+ \* \d+)/, "maxPending")],
        ];
        for (const [what, ts, swift] of pairs) {
            expect(swift, what).toBe(ts);
        }
        // The extraction reached real values rather than empty strings.
        expect(pairs.every(([, ts]) => ts.length > 0)).toBe(true);
    });

    it("the throttle's window should be the same length on both sides", () => {
        const ms = Number(one(ASK_PATH, /PROGRESS_THROTTLE_MS = (\d+)/, "PROGRESS_THROTTLE_MS"));
        const seconds = Number(one(SWIFT_PATH, /window: TimeInterval = ([\d.]+)/, "the throttle window"));
        expect(ms).toBeGreaterThan(0);
        expect(seconds * 1000).toBe(ms);
    });

    it("a tool call should be named by the same keys in the same order", () => {
        const keys = (source: string, pattern: RegExp, what: string): string[] =>
            all(source, pattern, what);
        expect(keys(SWIFT_PATH, /pathKeys = \[(.+)\]/g, "pathKeys")[0]!.replace(/"/g, ""))
            .toBe(keys(TS_PATH, /PATH_KEYS = \[(.+)\] as const/g, "PATH_KEYS")[0]!.replace(/"/g, ""));
        expect(keys(SWIFT_PATH, /phraseKeys = \[(.+)\]/g, "phraseKeys")[0]!.replace(/"/g, ""))
            .toBe(keys(TS_PATH, /PHRASE_KEYS = \[(.+)\] as const/g, "PHRASE_KEYS")[0]!.replace(/"/g, ""));
    });

    it("the escape sequences stripped should be the same patterns, character for character", () => {
        const tsAnsi = one(TS_PATH, /const ANSI = \/(.+)\/g;/, "the ANSI pattern");
        const tsControls = one(TS_PATH, /const CONTROLS = \/(.+)\/g;/, "the CONTROLS pattern");
        const swiftAnsi = one(SWIFT_PATH, /ansi = try! NSRegularExpression\(\s*pattern: #"(.+)"#\)/, "the ansi pattern");
        const swiftControls = one(SWIFT_PATH, /controls = try! NSRegularExpression\(\s*pattern: #"(.+)"#\)/, "the controls pattern");
        // The patterns read out of the TypeScript are the live ones: rebuilt
        // here, they must strip what the module strips.
        expect("\u001B[32mred\u001B[0m".replace(new RegExp(tsAnsi, "g"), "")).toBe("red");
        expect("a\u0007b".replace(new RegExp(tsControls, "g"), "")).toBe("ab");
        expect(swiftAnsi).toBe(tsAnsi);
        expect(swiftControls).toBe(tsControls);
    });

    it("the words a line is built from should be the same in both readers", () => {
        const tsSource = read(TS_PATH);
        const swiftSource = read(SWIFT_PATH);
        // `l10n.t` on one side and a literal on the other, so the words are
        // compared rather than the call.
        const words = [
            [/l10n\.t\("(Thinking)"\)/, /thinkingWord = "(Thinking)"/],
            [/l10n\.t\("(Running) \{0\}"/, /"(Running) \\\(command\)"/],
            [/l10n\.t\("(Editing) \{0\}"/, /"(Editing) \\\(AgentProgressReader\.basename/],
            [/l10n\.t\("(Editing) \{0\} files"/, /"(Editing) \\\(paths\.count\) files"/],
        ] as const;
        let compared = 0;
        for (const [tsPattern, swiftPattern] of words) {
            const ts = tsPattern.exec(tsSource);
            const swift = swiftPattern.exec(swiftSource);
            expect(ts, `no ${tsPattern} in ${TS_PATH}`).not.toBeNull();
            expect(swift, `no ${swiftPattern} in ${SWIFT_PATH}`).not.toBeNull();
            expect(swift![1]).toBe(ts![1]);
            compared += 1;
        }
        // A floor on what returned a verdict: a loop over a list that stopped
        // matching would otherwise pass having compared nothing.
        expect(compared).toBe(words.length);
    });

    it("neither reader should render a thinking step's content", () => {
        // The property the fixture cannot fully carry, because the captured
        // thinking block arrived empty: what a thinking branch produces is the
        // word, never the block's own text.
        expect(read(TS_PATH)).not.toMatch(/block\.thinking/);
        expect(read(SWIFT_PATH)).not.toMatch(/block\["thinking"\]/);
    });

    it("both suites should still be reading the shared cases", () => {
        // A guard names the files it reads, so a renamed or moved fixture
        // empties both suites with the whole tree green.
        expect(fs.existsSync(path.join(REPO_ROOT, FIXTURE))).toBe(true);
        for (const suite of [TS_TEST, SWIFT_TEST]) {
            expect(read(suite), `${suite} no longer reads ${FIXTURE}`).toContain("agentProgressCases.json");
        }
        const cases = JSON.parse(read(FIXTURE)).cases as unknown[];
        expect(cases.length).toBeGreaterThanOrEqual(14);
    });
});
