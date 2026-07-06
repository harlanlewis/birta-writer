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

        // Assert: defaults put six items in center and four on the right
        expect(zones.center).toEqual([
            "format",
            "clearFormatting",
            "fontPreset",
            "link",
            "image",
            "table",
        ]);
        expect(zones.right).toEqual(["viewSource", "styleCheck", "find", "settings"]);
        expect(zones.left).toEqual([]);
    });

    it("hidden items should be omitted from every zone and listed under hidden", () => {
        // Arrange
        const config = cfg({ link: "hidden", table: "hidden" });

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.center).not.toContain("link");
        expect(zones.center).not.toContain("table");
        expect(zones.center).toContain("image");
        expect(zones.hidden).toContain("link");
        expect(zones.hidden).toContain("table");
    });

    it("default-hidden items should populate the hidden list in registry order", () => {
        // Act
        const zones = computeZones(undefined);

        // Assert: bold precedes italic (registry order); visible items absent
        expect(zones.hidden).toContain("bold");
        expect(zones.hidden.indexOf("bold")).toBeLessThan(zones.hidden.indexOf("italic"));
        expect(zones.hidden).not.toContain("format");
    });

    it("showing a default-hidden item should move it out of the hidden list", () => {
        // Arrange
        const config = cfg({ bold: "left" });

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.left).toContain("bold");
        expect(zones.hidden).not.toContain("bold");
    });

    it("without an order hint, items should keep canonical registry order within a zone", () => {
        // Arrange: place bold + italic in center, out of registry order in the config
        const config = cfg({ italic: "center", bold: "center" });

        // Act
        const zones = computeZones(config);

        // Assert: bold precedes italic because that is the registry order
        expect(zones.center.indexOf("bold")).toBeLessThan(zones.center.indexOf("italic"));
    });

    it("an order hint should reorder items within a zone", () => {
        // Arrange: move clearFormatting to the end of the left set
        const config = cfg(
            { format: "left", clearFormatting: "left", link: "left" },
            ["format", "link", "clearFormatting"],
        );

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.left).toEqual(["format", "link", "clearFormatting"]);
    });

    it("items not named in the order hint should follow the listed ones in canonical order", () => {
        // Arrange: pin fontPreset first; hide the other default-center items so
        // only format + clearFormatting remain to fall through in registry order
        const config = cfg(
            {
                format: "center",
                clearFormatting: "center",
                fontPreset: "center",
                link: "hidden",
                image: "hidden",
                table: "hidden",
            },
            ["fontPreset"],
        );

        // Act
        const zones = computeZones(config);

        // Assert: fontPreset first, then format + clearFormatting in registry order
        expect(zones.center).toEqual(["fontPreset", "format", "clearFormatting"]);
    });

    it("an order id in another zone should not affect this zone", () => {
        // Arrange: order references a right-zone item while ranking left
        const config = cfg(
            { format: "left", link: "left", settings: "right" },
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

        // Assert: link keeps its default (center)
        expect(zones[DEFAULT_PLACEMENTS.link as "center"]).toContain("link");
    });

    it("a malformed order value should be ignored", () => {
        // Arrange: order is not an array
        const config = { placements: {}, order: "nope" } as unknown as ToolbarConfig;

        // Act + Assert: falls back to canonical default layout, no throw
        expect(() => computeZones(config)).not.toThrow();
        expect(computeZones(config).center[0]).toBe("format");
    });

    it("unknown item ids in the config should be ignored", () => {
        // Arrange
        const config = { placements: { notARealItem: "center" }, order: [] } as unknown as ToolbarConfig;

        // Act
        const zones = computeZones(config);

        // Assert: only real ids ever appear
        const all = [...zones.left, ...zones.center, ...zones.right];
        expect(all).not.toContain("notARealItem");
        all.forEach((id) => expect(TOOLBAR_ITEM_IDS).toContain(id));
    });

    it("hiding everything should produce three empty zones", () => {
        // Arrange
        const config = cfg(
            Object.fromEntries(TOOLBAR_ITEM_IDS.map((id) => [id, "hidden"])),
        );

        // Act
        const zones = computeZones(config);

        // Assert
        expect(zones.left).toEqual([]);
        expect(zones.center).toEqual([]);
        expect(zones.right).toEqual([]);
    });
});
