/**
 * Floating selection toolbar registry tests — resolveVisible's shipped
 * defaults (on, except the FLOATING_TOOLBAR_DEFAULT_OFF opt-ins) and its
 * handling of partial / malformed per-item config.
 */
import { describe, it, expect } from "vitest";
import {
    FLOATING_TOOLBAR_ITEM_IDS,
    FLOATING_TOOLBAR_DEFAULT_OFF,
    resolveVisible,
} from "../components/selectionToolbar/registry";

describe("floating toolbar resolveVisible", () => {
    it("undefined config should show exactly the default-on items", () => {
        const visible = resolveVisible(undefined);
        for (const id of FLOATING_TOOLBAR_ITEM_IDS) {
            expect(visible.has(id), id).toBe(!FLOATING_TOOLBAR_DEFAULT_OFF.has(id));
        }
    });

    it("the palette should ship slim: math, highlight, sectionLink, clearFormatting are opt-in", () => {
        expect([...FLOATING_TOOLBAR_DEFAULT_OFF].sort()).toEqual([
            "clearFormatting",
            "highlight",
            "math",
            "sectionLink",
        ]);
    });

    it("a flag set exactly to false should hide only that item", () => {
        const visible = resolveVisible({ bold: false });
        expect(visible.has("bold")).toBe(false);
        expect(visible.has("italic")).toBe(true);
        expect(visible.has("link")).toBe(true);
    });

    it("an explicit true should override a default-off item", () => {
        const visible = resolveVisible({ math: true, highlight: false });
        expect(visible.has("math")).toBe(true);
        expect(visible.has("highlight")).toBe(false);
    });

    it("a missing flag on a partial config should fall back to the item's default", () => {
        // Only 'format' is specified (false); every other id is absent and so
        // follows its shipped default.
        const visible = resolveVisible({ format: false });
        expect(visible.has("format")).toBe(false);
        for (const id of FLOATING_TOOLBAR_ITEM_IDS) {
            if (id !== "format") {
                expect(visible.has(id), id).toBe(!FLOATING_TOOLBAR_DEFAULT_OFF.has(id));
            }
        }
    });
});
