/**
 * Floating selection toolbar registry tests — resolveVisible's default-on
 * contract and its handling of partial / malformed per-item config.
 */
import { describe, it, expect } from "vitest";
import {
    FLOATING_TOOLBAR_ITEM_IDS,
    resolveVisible,
} from "../components/selectionToolbar/registry";

describe("floating toolbar resolveVisible", () => {
    it("undefined config should show every item (default on)", () => {
        const visible = resolveVisible(undefined);
        expect(visible.size).toBe(FLOATING_TOOLBAR_ITEM_IDS.length);
        for (const id of FLOATING_TOOLBAR_ITEM_IDS) {
            expect(visible.has(id)).toBe(true);
        }
    });

    it("a flag set exactly to false should hide only that item", () => {
        const visible = resolveVisible({ bold: false });
        expect(visible.has("bold")).toBe(false);
        expect(visible.has("italic")).toBe(true);
        expect(visible.has("link")).toBe(true);
    });

    it("a flag set to true should keep the item visible", () => {
        const visible = resolveVisible({ math: true, highlight: false });
        expect(visible.has("math")).toBe(true);
        expect(visible.has("highlight")).toBe(false);
    });

    it("a missing flag on a partial config should default to visible", () => {
        // Only 'format' is specified (false); every other id is absent and so
        // must remain visible — a newly registered item is on until opted out.
        const visible = resolveVisible({ format: false });
        expect(visible.has("format")).toBe(false);
        for (const id of FLOATING_TOOLBAR_ITEM_IDS) {
            if (id !== "format") {
                expect(visible.has(id), `${id} should default visible`).toBe(true);
            }
        }
    });
});
