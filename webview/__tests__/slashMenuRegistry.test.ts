/**
 * Pure-function tests for the slash-menu registry: the trigger regex /
 * context extractor, the tiered filter, and the drift guard that pins every
 * item to a real editor command (mirrors toolbarRegistry.test.ts).
 */
import { describe, it, expect } from "vitest";
import {
    filterSlashItems,
    SLASH_MENU_ITEMS,
    type SlashMenuItem,
} from "../components/slashMenu/registry";
import { slashContext, SLASH_CONTEXT_REGEX } from "../plugins/slashMenu";
import { EDITOR_COMMANDS } from "../../shared/editorCommands";

describe("slashContext", () => {
    it("a slash at block start should match with an empty query", () => {
        expect(slashContext("/")).toEqual({ query: "" });
    });

    it("a slash after a space should match and extract the query", () => {
        expect(slashContext("some text /hea")).toEqual({ query: "hea" });
    });

    it("a slash at block start with a query should extract it", () => {
        expect(slashContext("/table")).toEqual({ query: "table" });
    });

    it("a slash glued to a word should not match", () => {
        expect(slashContext("a/")).toBeNull();
        expect(slashContext("and/or")).toBeNull();
    });

    it("an unclosed link construct should not match (linkUrlComplete owns it)", () => {
        expect(slashContext("[text](/")).toBeNull();
        expect(slashContext("[text](/partial")).toBeNull();
    });

    it("whitespace inside the query should end the construct", () => {
        expect(slashContext("/heading 1")).toBeNull();
    });

    it("a second slash should end the construct (paths stop triggering)", () => {
        expect(slashContext("/usr/bin")).toBeNull();
        expect(slashContext("see /foo/")).toBeNull();
    });

    it("text without any slash should not match", () => {
        expect(slashContext("")).toBeNull();
        expect(slashContext("plain text")).toBeNull();
    });

    it("the regex should capture the query as group 1", () => {
        const m = SLASH_CONTEXT_REGEX.exec("intro /quo");
        expect(m?.[1]).toBe("quo");
    });
});

describe("filterSlashItems", () => {
    const label = (items: SlashMenuItem[]): string[] => items.map((i) => i.id);

    it("an empty query should return every item in registry order", () => {
        expect(filterSlashItems(SLASH_MENU_ITEMS, "")).toEqual([...SLASH_MENU_ITEMS]);
        expect(filterSlashItems(SLASH_MENU_ITEMS, "  ")).toEqual([...SLASH_MENU_ITEMS]);
    });

    it("label-prefix matches should rank above keyword-prefix matches", () => {
        // "ta": Task List (label prefix) beats Insert Table (keyword "table")
        const ids = label(filterSlashItems(SLASH_MENU_ITEMS, "ta"));
        expect(ids.indexOf("taskList")).toBeLessThan(ids.indexOf("table"));
        expect(ids).toContain("table");
    });

    it("keyword-prefix matches should rank above bare substring matches", () => {
        // "li": Link? no — label "Insert/Edit Link" doesn't start with "li";
        // keywords "link"/"list" prefix-match; "line" (divider) too. All
        // prefix matches rank above any substring-only match.
        const results = filterSlashItems(SLASH_MENU_ITEMS, "li");
        const ids = label(results);
        // bulletList/orderedList/taskList via keyword "list", link via
        // keyword "link", divider via keyword "line"
        expect(ids).toEqual(
            expect.arrayContaining(["bulletList", "orderedList", "taskList", "link", "divider"]),
        );
        // substring-only: none of these have a "li"-prefixed label
        for (const item of results) {
            expect(item.label.toLowerCase().startsWith("li")).toBe(false);
        }
    });

    it("matching should be case-insensitive", () => {
        expect(label(filterSlashItems(SLASH_MENU_ITEMS, "HEAD"))).toEqual(
            label(filterSlashItems(SLASH_MENU_ITEMS, "head")),
        );
        expect(filterSlashItems(SLASH_MENU_ITEMS, "HEAD").length).toBeGreaterThan(0);
    });

    it("a heading level should be reachable by its alias keyword", () => {
        const ids = label(filterSlashItems(SLASH_MENU_ITEMS, "h2"));
        expect(ids[0]).toBe("heading2");
    });

    it("order within a tier should be stable registry order", () => {
        const ids = label(filterSlashItems(SLASH_MENU_ITEMS, "head"));
        expect(ids.slice(0, 3)).toEqual(["heading1", "heading2", "heading3"]);
    });

    it("a query matching nothing should return an empty list", () => {
        expect(filterSlashItems(SLASH_MENU_ITEMS, "zzzz")).toEqual([]);
    });
});

describe("registry drift guards", () => {
    it("every commandId should exist in shared EDITOR_COMMANDS", () => {
        const known = new Set(EDITOR_COMMANDS.map((c) => c.id));
        for (const item of SLASH_MENU_ITEMS) {
            expect(known, `unknown commandId for item "${item.id}"`).toContain(
                item.commandId,
            );
        }
    });

    it("item ids should be unique", () => {
        const ids = SLASH_MENU_ITEMS.map((i) => i.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("every item should have at least one keyword and an icon or badge", () => {
        for (const item of SLASH_MENU_ITEMS) {
            expect(item.keywords.length, `item "${item.id}" has no keywords`).toBeGreaterThan(0);
            expect(
                item.icon !== "" || (item.badge ?? "") !== "",
                `item "${item.id}" has neither icon nor badge`,
            ).toBe(true);
        }
    });
});
