/**
 * Language-picker selection marking. The current language is indicated by the
 * shared leading check glyph (`.menu-check`, same as the toolbar menus), not a
 * colour/weight change — so the row no longer reads as disabled/greyed.
 */
import { describe, it, expect } from "vitest";
import {
    createLangPickerItem,
    isSameLanguage,
} from "../components/codeBlock/index";

describe("isSameLanguage", () => {
    it("the same canonical language should match", () => {
        expect(isSameLanguage("javascript", "javascript")).toBe(true);
    });

    it("an alias should match its canonical language", () => {
        expect(isSameLanguage("js", "javascript")).toBe(true);
        expect(isSameLanguage("tex", "latex")).toBe(true);
    });

    it("matching should be case-insensitive", () => {
        expect(isSameLanguage("JavaScript", "javascript")).toBe(true);
        expect(isSameLanguage("LaTeX", "tex")).toBe(true);
    });

    it("different languages should not match", () => {
        expect(isSameLanguage("python", "javascript")).toBe(false);
    });
});

describe("createLangPickerItem", () => {
    it("a selected item should be marked selected and carry the shared check column", () => {
        const item = createLangPickerItem("javascript", "JavaScript", true);
        expect(item.getAttribute("aria-selected")).toBe("true");
        expect(item.classList.contains("lang-picker-item--active")).toBe(true);
        // The check is the shared .menu-check glyph (visibility driven by CSS).
        expect(item.querySelector(".menu-check")).not.toBeNull();
        expect(item.querySelector(".lang-picker-item-label")?.textContent).toBe(
            "JavaScript",
        );
        expect(item.dataset["value"]).toBe("javascript");
    });

    it("an unselected item should reserve the check column but not be active", () => {
        const item = createLangPickerItem("python", "Python", false);
        expect(item.getAttribute("aria-selected")).toBe("false");
        expect(item.classList.contains("lang-picker-item--active")).toBe(false);
        // Column is still present so every label aligns; CSS keeps it hidden.
        expect(item.querySelector(".menu-check")).not.toBeNull();
    });

    it("every item should expose role=option for assistive tech", () => {
        const item = createLangPickerItem("go", "Go", false);
        expect(item.getAttribute("role")).toBe("option");
    });

    it("exactly one item in a rendered list should be marked selected", () => {
        const langs: Array<[string, string]> = [
            ["plaintext", "Plain Text"],
            ["javascript", "JavaScript"],
            ["python", "Python"],
            ["latex", "LaTeX"],
        ];
        // Current language given by an alias — the canonical row must be the one selected.
        const current = "js";
        const items = langs.map(([val, label]) =>
            createLangPickerItem(val, label, isSameLanguage(val, current)),
        );
        const selected = items.filter(
            (i) => i.getAttribute("aria-selected") === "true",
        );
        expect(selected).toHaveLength(1);
        expect(selected[0]?.dataset["value"]).toBe("javascript");
    });
});
