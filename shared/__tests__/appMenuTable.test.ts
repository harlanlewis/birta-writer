/**
 * The completeness check in `parseAppMenu`, driven rather than read.
 *
 * `parseAppMenu` is the single source two guards stand on, and the only thing
 * between them and a partial table is one comparison: rows read against rows
 * declared. That comparison is worth nothing if the two numbers are computed
 * from the same requirement, because a row the parser stops recognising leaves
 * BOTH sides and the guard reports a whole table having read part of one. The
 * check has been that tautology twice, in two spellings, and no run went red
 * either time.
 *
 * So it is asked here the only way it can be: reformat a real row into a shape
 * `ROW_RE` cannot read, and require the parser to say so. Each mutation asserts
 * that it changed the file, because a mutation that never landed reads as a
 * survivor, and the unmutated copy is the control.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseAppMenu, menuSections, APP_MENU_PATH } from "./appMenuTable";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SOURCE = readFileSync(join(REPO_ROOT, APP_MENU_PATH), "utf8");

/** A repo root holding one Swift file: `source`, at the real path. */
function rootHolding(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mac-menu-table-"));
    const dest = join(dir, APP_MENU_PATH);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, source);
    return dir;
}

/** `parseAppMenu` over a mutated copy: the row count, or the message it threw. */
function parseMutated(replace: [string, string]): { rows?: number; threw?: string } {
    const [from, to] = replace;
    const mutated = SOURCE.replace(from, to);
    // The arm without which a mutation that never applied reads as a survivor:
    // `String.replace` returns the input unchanged when the pattern is absent,
    // and every assertion below would then be describing the real file.
    expect(mutated, `the mutation did not apply: ${from.slice(0, 60)}`).not.toBe(SOURCE);
    try {
        return { rows: parseAppMenu(rootHolding(mutated)).length };
    } catch (error) {
        return { threw: (error as Error).message };
    }
}

/**
 * One real row, in the three shapes Swift accepts and `ROW_RE` does not.
 *
 * All three are formatting rather than meaning: the row still declares the
 * same title, chord, command and menu, and Swift compiles every one. That is
 * what makes them the right probe, because a reformat is the change nobody
 * reviews as a change to the table.
 */
const ROW = '              action: .command("toggleBold"), menu: .format, group: 0),';
const REFORMATTED: Record<string, string> = {
    "wrapped before `menu:`":
        '              action: .command("toggleBold"),\n              menu: .format, group: 0),',
    "`menu:` written ahead of `action:`":
        '              menu: .format, action: .command("toggleBold"), group: 0),',
    "two spaces after the comma":
        '              action: .command("toggleBold"),  menu: .format, group: 0),',
    "a space before the colon":
        '              action: .command("toggleBold"), menu : .format, group: 0),',
};

/** The same row whole, for the deletion arm: two lines, leaving valid Swift. */
const WHOLE_ROW =
    '        .init(title: "Bold", key: "b", modifiers: [.command],\n'
    + '              action: .command("toggleBold"), menu: .format, group: 0),\n';

describe("parseAppMenu's completeness check", () => {
    const BASELINE = parseAppMenu(REPO_ROOT).length;

    it("the control should read the whole table, so a throw below is the mutation's", () => {
        expect(BASELINE).toBeGreaterThan(40);
        expect(parseAppMenu(rootHolding(SOURCE)).length).toBe(BASELINE);
    });

    for (const [shape, rewritten] of Object.entries(REFORMATTED)) {
        it(`a row ${shape} should be reported, not silently dropped`, () => {
            const result = parseMutated([ROW, rewritten]);
            expect(
                result.threw,
                `the parser read ${result.rows} of ${BASELINE} rows and said nothing: the ` +
                    "denominator fell with the numerator, which is the tautology this check " +
                    "exists to not be",
            ).toBeDefined();
            expect(result.threw).toContain("shape the parser does not recognise");
        });
    }

    it("a row genuinely deleted should not be reported, or the check cries at every edit", () => {
        // The discriminating half. A denominator that threw at everything would
        // pass every assertion above while saying nothing about shape.
        const result = parseMutated([WHOLE_ROW, ""]);
        expect(result.threw).toBeUndefined();
        expect(result.rows).toBe(BASELINE - 1);
    });

    it("a row written in Swift's other constructor form should still be reported", () => {
        // The shape the previous denominator was widened for. It stays covered:
        // widening for one shape must not narrow for another.
        const result = parseMutated([
            '.init(title: "Bold", key: "b", modifiers: [.command],',
            'Row(title: "Bold", key: "b", modifiers: [.command],',
        ]);
        expect(result.threw).toBeDefined();
    });
});

describe("menuSections' denominator", () => {
    it("a heading missing from the switch should be reported, not returned short", () => {
        // The enum's cases are the denominator and the switch arms the
        // numerator, so this one is not derived from the parse at all. Pinned
        // because a short map is what every check written over it would pass on.
        const mutated = SOURCE.replace(/ *case \.help: return "[^"]+"\n/, "");
        expect(mutated, "the mutation did not apply").not.toBe(SOURCE);
        expect(() => menuSections(rootHolding(mutated))).toThrow(/missing help/);
        // And the control answers, so the throw above is the mutation's.
        expect(Object.keys(menuSections(rootHolding(SOURCE))).sort())
            .toEqual(["app", "edit", "file", "format", "help", "view"]);
    });
});
