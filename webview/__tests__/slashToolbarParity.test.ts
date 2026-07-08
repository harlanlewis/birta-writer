/**
 * Drift guard: everything the toolbar can do must also be reachable from the
 * slash menu. Each toolbar item id maps to the slash item id(s) that cover it;
 * a new toolbar item without slash coverage fails here until the mapping (and
 * usually a registry row) is added.
 */
import { describe, it, expect } from "vitest";
import { TOOLBAR_ITEM_IDS, type ToolbarItemId } from "../components/toolbar/registry";
import { SLASH_MENU_ITEMS } from "../components/slashMenu/registry";

/**
 * Toolbar item → covering slash item ids. Dropdown-style toolbar items map to
 * every choice they contain (format → all heading levels; fontPreset → the
 * four presets plus the size stepper; styleCheck → the three master toggles;
 * settings → the gear-menu entries).
 */
const SLASH_COVERAGE: Record<ToolbarItemId, readonly string[]> = {
    format: ["paragraph", "heading1", "heading2", "heading3", "heading4", "heading5", "heading6"],
    bold: ["bold"],
    italic: ["italic"],
    strikethrough: ["strikethrough"],
    highlight: ["highlight"],
    inlineCode: ["inlineCode"],
    link: ["link"],
    bulletList: ["bulletList"],
    orderedList: ["orderedList"],
    taskList: ["taskList"],
    codeBlock: ["codeBlock"],
    blockquote: ["blockquote"],
    horizontalRule: ["divider"],
    table: ["table"],
    image: ["image"],
    math: ["math"],
    footnote: ["footnote"],
    clearFormatting: ["clearFormatting"],
    viewSource: ["viewSource"],
    find: ["find"],
    styleCheck: ["spellCheck", "grammarCheck", "styleCheck"],
    fontPreset: ["fontEditor", "fontSans", "fontSerif", "fontMono", "fontSizeIncrease", "fontSizeDecrease"],
    settings: ["customizeToolbar", "hideToolbar", "showToolbar", "keyboardShortcuts", "settings"],
};

describe("toolbar ↔ slash menu parity", () => {
    const slashIds = new Set(SLASH_MENU_ITEMS.map((i) => i.id));

    it("every toolbar item should declare its slash coverage", () => {
        for (const id of TOOLBAR_ITEM_IDS) {
            const coverage = SLASH_COVERAGE[id];
            expect(coverage, `toolbar item "${id}" has no slash coverage mapping`).toBeDefined();
            expect(coverage.length, `toolbar item "${id}" maps to nothing`).toBeGreaterThan(0);
        }
    });

    it("every mapped slash id should exist in the slash registry", () => {
        for (const [toolbarId, coverage] of Object.entries(SLASH_COVERAGE)) {
            for (const slashId of coverage) {
                expect(
                    slashIds.has(slashId),
                    `toolbar item "${toolbarId}" maps to missing slash item "${slashId}"`,
                ).toBe(true);
            }
        }
    });

    it("the mapping should not reference toolbar items that no longer exist", () => {
        const known = new Set<string>(TOOLBAR_ITEM_IDS);
        for (const toolbarId of Object.keys(SLASH_COVERAGE)) {
            expect(known.has(toolbarId), `stale mapping for "${toolbarId}"`).toBe(true);
        }
    });
});
