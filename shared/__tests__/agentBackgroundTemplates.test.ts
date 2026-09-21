/**
 * The `/ai` command templates Birta offers for itself, held across the two
 * surfaces that offer them.
 *
 * Birta never adds a flag to a command somebody else wrote, so the only place
 * it can ask a harness for the structured events the corner notice reads is a
 * template of its own. The extension's first-use picker has two
 * (`CLAUDE_BACKGROUND_TEMPLATE`, `CODEX_BACKGROUND_TEMPLATE` in
 * `src/agentBridge/askAgent.ts`); the Mac app's Settings pull-down has its own
 * list (`AgentPreset.template` in `mac/Sources/BirtaWriterCore/NoteModel.swift`),
 * because Swift cannot import the TypeScript.
 *
 * Nothing held them together, and they drifted: the Mac app shipped both
 * commands without their structured flags, so a reader who took a preset and
 * never edited it got one line at the end of a silence where the extension
 * showed the run working. That is the defect this guard exists for, and it is
 * invisible to every other check in the tree, because each list is correct on
 * its own terms.
 *
 * Paired by the PROGRAM each command runs, not by position, and every
 * extension constant must find its pair: a third background template added
 * there fails here until the Mac list carries it. The nine presets with no
 * counterpart in the extension are the Mac app's alone and are not compared.
 *
 * The extraction is self-validating. Both sides are read out of the source and
 * rebuilt, and a read that matched nothing throws rather than comparing two
 * things this file invented.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TS_PATH = "src/agentBridge/askAgent.ts";
const SWIFT_PATH = "mac/Sources/BirtaWriterCore/NoteModel.swift";

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * The program a command line runs: its first word, with any path and any
 * surrounding quotes taken off. A port of `AgentPreset.program`, which is what
 * the Mac app's own pull-down reads a stored command back with.
 */
function program(command: string): string {
    const head = command.trim().split(/\s+/)[0]!.replace(/^["']|["']$/g, "");
    return head.split("/").pop()!.toLowerCase();
}

/** The extension's background templates, as name to command. */
function extensionTemplates(): Map<string, string> {
    const source = read(TS_PATH);
    const found = new Map<string, string>();
    for (const m of source.matchAll(/export const (\w+_BACKGROUND_TEMPLATE) =\s*"([^"]+)";/g)) {
        found.set(m[1]!, m[2]!);
    }
    if (found.size === 0) {
        throw new Error(`no *_BACKGROUND_TEMPLATE constants found in ${TS_PATH}; this guard must follow them`);
    }
    return found;
}

/** The Mac app's presets, as case name to command, from the `template` switch. */
function macTemplates(): Map<string, string> {
    const source = read(SWIFT_PATH);
    const block = /public var template: String \{\n\s*switch self \{([\s\S]*?)\n {8}\}/.exec(source);
    if (block === null) {
        throw new Error(`no \`var template\` switch found in ${SWIFT_PATH}; this guard must follow it`);
    }
    const found = new Map<string, string>();
    for (const m of block[1]!.matchAll(/case \.(\w+):\s*(?:\n\s*)?return "([^"]+)"/g)) {
        found.set(m[1]!, m[2]!);
    }
    if (found.size === 0) {
        throw new Error(`no \`case .name: return "…"\` arms found in ${SWIFT_PATH}'s template switch`);
    }
    return found;
}

describe("the background command templates across the extension and the Mac app", () => {
    it("every template the extension offers should be offered by the Mac app, character for character", () => {
        const extension = extensionTemplates();
        const mac = macTemplates();
        let compared = 0;
        for (const [name, command] of extension) {
            const binary = program(command);
            const pair = [...mac].find(([, template]) => program(template) === binary);
            expect(pair, `${SWIFT_PATH} offers no preset running \`${binary}\`, which ${name} does`)
                .toBeDefined();
            expect(pair![1], `${name} and AgentPreset.${pair![0]} have drifted`).toBe(command);
            compared += 1;
        }
        // A floor on what returned a verdict rather than a sum of the buckets
        // the loop sorted its own inputs into: an extraction that matched
        // nothing would otherwise pass having compared nothing.
        expect(compared).toBe(extension.size);
        expect(compared).toBeGreaterThanOrEqual(2);
    });

    it("a template Birta offers should ask its CLI for the events the corner reads", () => {
        // The property, not the strings: the check above holds the two lists
        // equal, and two lists can be equally wrong. What makes a background
        // template a background template is that its harness is asked to
        // speak, so a flag dropped from BOTH sides at once still fails here.
        const asks = /--output-format stream-json|--json/;
        let checked = 0;
        for (const [name, command] of extensionTemplates()) {
            expect(command, `${name} asks its CLI for nothing, so its run is a clock`).toMatch(asks);
            checked += 1;
        }
        expect(checked).toBeGreaterThanOrEqual(2);
    });

    it("Claude Code's two flags should travel together on both sides", () => {
        // `--output-format stream-json` is refused without `--verbose`: the
        // help does not say so and only the error does, so a template carrying
        // one and not the other is a command that fails rather than one that
        // says less.
        const carriers = [...extensionTemplates().values(), ...macTemplates().values()]
            .filter((command) => command.includes("--output-format stream-json"));
        expect(carriers.length,
               "both sides declare a stream-json template, so fewer than two means one stopped")
            .toBeGreaterThanOrEqual(2);
        for (const command of carriers) {
            expect(command, "stream-json without --verbose is refused by the CLI").toContain("--verbose");
        }
    });

    it("the extension's constants should still be the ones its picker offers", () => {
        // A constant nobody offers is a guard pinned to nothing: the two lists
        // would agree while the picker stored a third string.
        const source = read(TS_PATH);
        for (const name of extensionTemplates().keys()) {
            expect(source, `${name} is declared but no longer offered`).toContain(`value: ${name},`);
        }
    });
});
