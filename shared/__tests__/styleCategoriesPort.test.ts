/**
 * The style-check vocabulary, held across the two languages that declare it.
 *
 * `webview/utils/styleCategories.ts` is the source: the toolbar's Checks menu,
 * the review sidebar's grouping and the in-text chips all read it. The Mac app's Style
 * Options submenu is the fourth surface and cannot, because Swift cannot import
 * TypeScript, so `mac/Sources/BirtaWriterCore/StyleCategories.swift` is a port and
 * this is what stops the two drifting.
 *
 * The alternative was hand-listing fourteen rows in `AppMenu.swift`, which is
 * the shape AGENTS.md warns about: a hand-written list is a list a new case
 * never joins. Both sides are enumerations now (`STYLE_CATEGORIES` and a
 * `CaseIterable` enum), so the menu is derived on each side and this compares
 * the derivations rather than either menu.
 *
 * ORDER is compared, not just membership. The reader meets these in one order
 * in the toolbar and another in the menu bar if nobody checks, and a section
 * boundary in the wrong place puts a rule between two rows that belong
 * together.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { STYLE_CATEGORIES, STYLE_SECTIONS } from "../../webview/utils/styleCategories";
import { EDITOR_COMMANDS } from "../editorCommands";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SWIFT_PATH = "mac/Sources/BirtaWriterCore/StyleCategories.swift";
const MENU_PATH = "mac/Sources/BirtaWriter/AppMenu.swift";

const swift = fs.readFileSync(path.join(REPO_ROOT, SWIFT_PATH), "utf8");

/** The enum's cases, in declaration order. */
function swiftCases(): string[] {
    const body = /public enum StyleCategory: String, CaseIterable \{([\s\S]*?)\n {4}\/\/\/ The heading/.exec(swift);
    if (body === null) {
        throw new Error(`no \`enum StyleCategory\` case block found in ${SWIFT_PATH}`);
    }
    return [...body[1]!.matchAll(/^\s*case (\w+)$/gm)].map((m) => m[1]!);
}

/** A `switch self { case .a, .b: return X }` property, as case → value. */
function swiftSwitch(property: string, valuePattern: string): Map<string, string> {
    const body = new RegExp(
        String.raw`public var ${property}: \w+ \{\n\s*switch self \{([\s\S]*?)\n {8}\}`,
    ).exec(swift);
    if (body === null) {
        throw new Error(`no \`var ${property}\` switch found in ${SWIFT_PATH}`);
    }
    const out = new Map<string, string>();
    const arm = new RegExp(String.raw`case ((?:\.\w+(?:, )?)+): return ${valuePattern}`, "g");
    for (const m of body[1]!.matchAll(arm)) {
        for (const one of m[1]!.matchAll(/\.(\w+)/g)) { out.set(one[1]!, m[2]!); }
    }
    return out;
}

/** Every `case x = "Label"` of the nested Section enum, as case → label. */
function swiftSections(): string[] {
    const body = /public enum Section: String, CaseIterable \{([\s\S]*?)\n {4}\}/.exec(swift);
    if (body === null) {
        throw new Error(`no \`enum Section\` found in ${SWIFT_PATH}`);
    }
    return [...body[1]!.matchAll(/case \w+ = "([^"]+)"/g)].map((m) => m[1]!);
}

/** The categories the page lets a reader toggle one at a time, in order. */
const TOGGLEABLE = STYLE_CATEGORIES.filter((d) => d.section !== null);

describe("the Mac app's style-category port against the page's list", () => {
    it("both readers should have reached a plausible number of categories", () => {
        // The floor before anything is concluded. A regex that stopped
        // matching returns an empty list, and every comparison below passes
        // when both sides are empty.
        expect(TOGGLEABLE.length).toBeGreaterThan(10);
        expect(swiftCases().length).toBeGreaterThan(10);
        expect(swiftSections().length).toBe(STYLE_SECTIONS.length);
        expect(swiftSwitch("label", '"([^"]+)"').size).toBeGreaterThan(10);
        expect(swiftSwitch("section", String.raw`\.(\w+)`).size).toBeGreaterThan(10);
    });

    it("the Swift cases should be the page's toggleable categories, in the page's order", () => {
        expect(swiftCases()).toEqual(TOGGLEABLE.map((d) => d.category));
    });

    it("a category the page folds into the master should have no case of its own", () => {
        // `repeated` is the one, and its absence is the page's decision rather
        // than the port's: with `section: null` it has no row in the toolbar's
        // menu either. A case here would be a Style Options row that is a
        // switch with nothing behind it.
        const folded = STYLE_CATEGORIES.filter((d) => d.section === null).map((d) => d.category);
        expect(folded.length).toBeGreaterThan(0);
        for (const category of folded) {
            expect(swiftCases(), `${category} is folded into the master and has a Swift case`)
                .not.toContain(category);
        }
    });

    it("every category should carry the page's own label", () => {
        const labels = swiftSwitch("label", '"([^"]+)"');
        for (const def of TOGGLEABLE) {
            expect(labels.get(def.category), `${def.category}'s label`).toBe(def.label);
        }
        expect([...labels.keys()].sort()).toEqual(TOGGLEABLE.map((d) => d.category).sort());
    });

    it("every category should sit in the page's own section", () => {
        const sections = swiftSwitch("section", String.raw`\.(\w+)`);
        // The Swift case names are the shell's; the LABELS are what has to
        // agree, so each is resolved through the Section enum's raw values in
        // declaration order, which is also the order the rules fall in.
        const sectionLabels = swiftSections();
        const caseOrder = [...new Set([...sections.values()])];
        expect(caseOrder.length).toBe(sectionLabels.length);
        const byCase = new Map(
            [...swift.matchAll(/case (\w+) = "([^"]+)"/g)].map((m) => [m[1]!, m[2]!]),
        );
        for (const def of TOGGLEABLE) {
            const swiftCase = sections.get(def.category);
            expect(swiftCase, `${def.category} is in no section`).toBeDefined();
            expect(byCase.get(swiftCase!), `${def.category}'s section`).toBe(def.section);
        }
        expect(sectionLabels).toEqual([...STYLE_SECTIONS]);
    });

    it("the menu rows should be derived from the enum rather than written out", () => {
        // The whole reason the port exists. A future edit that spells the
        // fourteen rows by hand in the table would satisfy every check above
        // and put the list back where a new category never joins it.
        const menu = fs.readFileSync(path.join(REPO_ROOT, MENU_PATH), "utf8");
        expect(menu).toContain("StyleCategory.allCases.map");
        for (const def of TOGGLEABLE) {
            expect(menu, `${def.label} is written into the menu table by hand`)
                .not.toContain(`"${def.label}"`);
        }
    });

    it("the command the rows run should exist and take its category as an argument", () => {
        const menu = fs.readFileSync(path.join(REPO_ROOT, MENU_PATH), "utf8");
        expect(menu).toContain('.command("toggleStyleOption", arg: category.rawValue)');
        const meta = EDITOR_COMMANDS.find((c) => c.id === "toggleStyleOption");
        expect(meta, "toggleStyleOption is not a command").toBeDefined();
        // Palette-hidden on purpose: a palette row for a command that needs an
        // argument the palette cannot supply is a row that does nothing.
        expect(meta!.palette).toBe(false);
    });
});
