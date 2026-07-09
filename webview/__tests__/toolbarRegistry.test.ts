import { describe, it, expect } from "vitest";
import {
    computeZones,
    DEFAULT_PLACEMENTS,
    TOOLBAR_ITEM_IDS,
} from "../components/toolbar/registry";
import type { ToolbarConfig, ToolbarPlacements } from "../../shared/messages";

/** Build a config from a placements map (order defaults to empty). */
function cfg(placements: ToolbarPlacements, order: string[] = []): ToolbarConfig {
    return { placements, order };
}

describe("computeZones", () => {
    it("an undefined config should fall back to the default placements", () => {
        // Act
        const zones = computeZones(undefined);

        // Assert: shipped layout — editing controls left, utilities right,
        // footnote the sole opt-in
        expect(zones.left).toEqual([
            "format",
            "bold",
            "italic",
            "strikethrough",
            "inlineCode",
            "link",
            "bulletList",
            "orderedList",
            "taskList",
            "codeBlock",
            "blockquote",
            "callouts",
            "horizontalRule",
            "table",
            "image",
            "math",
            "clearFormatting",
        ]);
        expect(zones.right).toEqual(["viewSource", "find", "styleCheck", "fontPreset", "settings"]);
        expect(zones.hidden).toEqual(["highlight", "footnote"]);
    });

    it("hidden items should be omitted from every zone and listed under hidden", () => {
        // Arrange
        const config = cfg({ link: "hidden", table: "hidden" });

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.left).not.toContain("link");
        expect(zones.left).not.toContain("table");
        expect(zones.left).toContain("image");
        expect(zones.hidden).toContain("link");
        expect(zones.hidden).toContain("table");
    });

    it("hiding items should populate the hidden list in registry order", () => {
        // Arrange: hide two visible items on top of the default-hidden footnote
        const zones = computeZones(cfg({ bold: "hidden", italic: "hidden" }));

        // Assert: bold precedes italic (registry order); visible items absent
        expect(zones.hidden.indexOf("bold")).toBeLessThan(zones.hidden.indexOf("italic"));
        expect(zones.hidden).not.toContain("format");
    });

    it("showing a default-hidden item should move it out of the hidden list", () => {
        // Arrange
        const config = cfg({ footnote: "left" });

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.left).toContain("footnote");
        expect(zones.hidden).not.toContain("footnote");
    });

    it("without an order hint, items should keep canonical registry order within a zone", () => {
        // Arrange: place bold + italic on the right, out of registry order in the config
        const config = cfg({ italic: "right", bold: "right" });

        // Act
        const zones = computeZones(config);

        // Assert: bold precedes italic because that is the registry order
        expect(zones.right.indexOf("bold")).toBeLessThan(zones.right.indexOf("italic"));
    });

    it("an order hint should reorder items within a zone", () => {
        // Arrange: pull link ahead of the format anchor
        const config = cfg(
            Object.fromEntries(
                TOOLBAR_ITEM_IDS.map((id) => [
                    id,
                    id === "format" || id === "link" || id === "clearFormatting" ? "left" : "hidden",
                ]),
            ),
            ["link", "clearFormatting", "format"],
        );

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.left).toEqual(["link", "clearFormatting", "format"]);
    });

    it("items not named in the order hint should follow the listed ones in canonical order", () => {
        // Arrange: pin fontPreset first; hide everything else so only
        // format + clearFormatting remain to fall through in registry order
        const config = cfg(
            Object.fromEntries(
                TOOLBAR_ITEM_IDS.map((id) => [
                    id,
                    id === "format" || id === "clearFormatting" || id === "fontPreset"
                        ? "right"
                        : "hidden",
                ]),
            ),
            ["fontPreset"],
        );

        // Act
        const zones = computeZones(config);

        // Assert: fontPreset first, then format + clearFormatting in registry order
        expect(zones.right).toEqual(["fontPreset", "format", "clearFormatting"]);
    });

    it("an order id in another zone should not affect this zone", () => {
        // Arrange: order references a right-zone item while ranking left
        const config = cfg(
            Object.fromEntries(
                TOOLBAR_ITEM_IDS.map((id) => [
                    id,
                    id === "format" || id === "link" ? "left" : id === "settings" ? "right" : "hidden",
                ]),
            ),
            ["settings", "link", "format"],
        );

        // Act
        const zones = computeZones(config);

        // Assert: within left, link precedes format (their order-hint positions)
        expect(zones.left).toEqual(["link", "format"]);
    });

    it("an item can be moved to a non-default zone", () => {
        // Arrange
        const config = cfg({ settings: "left" });

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.left).toContain("settings");
        expect(zones.right).not.toContain("settings");
    });

    it("an invalid placement value should fall back to the item default", () => {
        // Arrange: garbage placement for a normally-visible item
        const config = { placements: { link: "banana" }, order: [] } as unknown as ToolbarConfig;

        // Act
        const zones = computeZones(config);

        // Assert: link keeps its default zone
        expect(zones[DEFAULT_PLACEMENTS.link as "left"]).toContain("link");
    });

    it("a malformed order value should be ignored", () => {
        // Arrange: order is not an array
        const config = { placements: {}, order: "nope" } as unknown as ToolbarConfig;

        // Act + Assert: falls back to canonical default layout, no throw
        expect(() => computeZones(config)).not.toThrow();
        expect(computeZones(config).left[0]).toBe("format");
    });

    it("unknown item ids in the config should be ignored", () => {
        // Arrange
        const config = { placements: { notARealItem: "right" }, order: [] } as unknown as ToolbarConfig;

        // Act
        const zones = computeZones(config);

        // Assert: only real ids ever appear
        const all = [...zones.left, ...zones.right];
        expect(all).not.toContain("notARealItem");
        all.forEach((id) => expect(TOOLBAR_ITEM_IDS).toContain(id));
    });

    it("hiding everything should produce empty zones", () => {
        // Arrange
        const config = cfg(
            Object.fromEntries(TOOLBAR_ITEM_IDS.map((id) => [id, "hidden"])),
        );

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.left).toEqual([]);
        expect(zones.right).toEqual([]);
    });
});
