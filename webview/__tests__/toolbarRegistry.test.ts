import { describe, it, expect } from "vitest";
import {
    computeDockPartition,
    computeZones,
    DEFAULT_PLACEMENTS,
    hostAvailableItems,
    ITEM_COMMANDS,
    ITEM_HOST_CAPABILITY,
    ITEM_MUTATES,
    TOOLBAR_ITEM_IDS,
} from "../components/toolbar/registry";
import type { ToolbarConfig, ToolbarPlacements } from "../../shared/messages";
import { EDITOR_COMMANDS } from "../../shared/editorCommands";
import type { HostCapability } from "../../shared/hostProfile";
import { commandMutates } from "../readOnly";

/** Build a config from a placements map (order defaults to empty). */
function cfg(placements: ToolbarPlacements, order: string[] = []): ToolbarConfig {
    return { placements, order };
}

describe("computeZones", () => {
    it("an undefined config should fall back to the default placements", () => {
        // Act
        const zones = computeZones(undefined);

        // Assert: shipped layout — common editing controls left, utilities
        // right, less-used inserts (highlight, horizontalRule, math, footnote,
        // clearFormatting) hidden by default
        expect(zones.left).toEqual([
            "format",
            "bold",
            "italic",
            "link",
            "listMenu",
            "quote",
            "codeBlock",
            "table",
            "image",
        ]);
        expect(zones.right).toEqual(["viewSource", "find", "styleCheck", "fontPreset", "settings"]);
        // readOnly ships hidden (MAR-53): the Toggle Read-only command and
        // `birta.readOnly` cover it. Shown, it sits beside viewSource, the
        // two answering the same question about how you are working with
        // this file.
        expect(zones.hidden).toEqual([
            "strikethrough",
            "highlight",
            "inlineCode",
            "horizontalRule",
            "math",
            "footnote",
            "clearFormatting",
            "readOnly",
        ]);
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

describe("ITEM_MUTATES against the command classification (MAR-53)", () => {
    it("every item should mutate exactly when one of the commands it runs mutates", () => {
        // Two tables classify the same gestures: the toolbar's per-item flag,
        // which dims the control, and the command gate, which refuses the
        // action. Nothing structural ties them, so this is the tie. Asserted
        // over every id, and the count is asserted so an empty sweep cannot
        // pass.
        expect(TOOLBAR_ITEM_IDS.length).toBeGreaterThan(0);
        const disagreements = TOOLBAR_ITEM_IDS.filter((id) => {
            const commands = ITEM_COMMANDS[id];
            expect(commands.length, `${id} runs no command`).toBeGreaterThan(0);
            return ITEM_MUTATES[id] !== commands.some(commandMutates);
        });
        expect(disagreements).toEqual([]);
    });
});

describe("ITEM_HOST_CAPABILITY against the command metadata (MAR-373)", () => {
    const commandCapability = (id: string): HostCapability | undefined =>
        (EDITOR_COMMANDS as readonly { id: string; hostCapability?: HostCapability }[])
            .find((m) => m.id === id)?.hostCapability;

    it("every item should need a capability exactly when one of its commands needs it, settings excepted", () => {
        // Two tables classify the same gestures again: the per-item gate that
        // decides whether the control is built, and the per-command gate that
        // decides whether it runs. Three items are documented exceptions, all
        // for the same reason: they are MENUS that mix gated and unconditional
        // rows, so they are always built and filter row by row. The gear is
        // one; the font menu is the second, which carries the width segments
        // (`contentMeasure`) and the Editor-font row (`editorFont`) beside a
        // size stepper and three presets that every host can honour; the Checks
        // menu is the third, where Check Spelling and Check Grammar need a host
        // lint engine and Check Style and Highlight Note Markers are answered
        // by the page.
        const ROW_FILTERING_MENUS = ["settings", "fontPreset", "styleCheck"];
        expect(TOOLBAR_ITEM_IDS.length).toBeGreaterThan(0);
        const disagreements = TOOLBAR_ITEM_IDS.filter((id) => {
            if (ROW_FILTERING_MENUS.includes(id)) { return ITEM_HOST_CAPABILITY[id] !== null; }
            const needed = new Set(ITEM_COMMANDS[id].map(commandCapability).filter((c) => c !== undefined));
            const item = ITEM_HOST_CAPABILITY[id];
            return item === null ? needed.size !== 0 : !(needed.size === 1 && needed.has(item));
        });
        expect(disagreements).toEqual([]);
        // The sweep reached the gated items, not only the null ones.
        expect(TOOLBAR_ITEM_IDS.filter((id) => ITEM_HOST_CAPABILITY[id] !== null).length).toBeGreaterThanOrEqual(3);
    });

    it("each row-filtering menu should mix gated and unconditional commands, or its exception is dead", () => {
        for (const id of ["settings", "fontPreset", "styleCheck"] as const) {
            const caps = ITEM_COMMANDS[id].map(commandCapability);
            expect(caps.some((c) => c === undefined), id).toBe(true);
            expect(caps.some((c) => c !== undefined), id).toBe(true);
        }
    });
});

describe("computeZones with a host that lacks a capability (MAR-373)", () => {
    it("an unavailable item should be absent from every zone, hidden included", () => {
        // Arrange: readOnly ships hidden, viewSource ships right; the host has
        // neither, and the customize tray reads `hidden`, so both must vanish
        // from all three lists rather than merely fall to hidden.
        const available = new Set(TOOLBAR_ITEM_IDS.filter((id) => id !== "readOnly" && id !== "viewSource"));

        // Act
        const zones = computeZones(undefined, available);

        // Assert
        for (const zone of ["left", "right", "hidden"] as const) {
            expect(zones[zone]).not.toContain("readOnly");
            expect(zones[zone]).not.toContain("viewSource");
        }
        // Everything else is where it was.
        expect(zones.right).toEqual(["find", "styleCheck", "fontPreset", "settings"]);
        expect(zones.hidden).toContain("footnote");
    });

    it("a user placement or order hint cannot bring an unavailable item back", () => {
        const available = new Set(TOOLBAR_ITEM_IDS.filter((id) => id !== "image"));
        const zones = computeZones(cfg({ image: "right" }, ["image"]), available);
        expect([...zones.left, ...zones.right, ...zones.hidden]).not.toContain("image");
    });

    it("hostAvailableItems should read the host declaration through hostHas", () => {
        const prior = window.__i18n;
        try {
            window.__i18n = { translations: {}, isMac: true, host: { capabilities: [] } };
            const none = hostAvailableItems();
            expect(none.has("viewSource")).toBe(false);
            expect(none.has("image")).toBe(false);
            expect(none.has("readOnly")).toBe(false);
            // Present with a host that declares nothing, like the gear and the
            // font menu: it is a row-filtering menu whose style half the page
            // answers by itself, so the item survives and the two lint rows
            // inside it are what a host without an engine loses.
            expect(none.has("styleCheck")).toBe(true);
            expect(none.has("settings")).toBe(true);
            expect(none.has("bold")).toBe(true);
            // Absent means all.
            window.__i18n = { translations: {}, isMac: true };
            expect(hostAvailableItems().size).toBe(TOOLBAR_ITEM_IDS.length);
        } finally {
            window.__i18n = prior;
        }
    });
});

/**
 * The `formattingInSecondRow` partition.
 *
 * The point of every case here is that the split is DERIVED. A hand-written
 * list of "the formatting ones" would be a list a new toolbar item never joins,
 * and it would pass this file forever while the item sat on the wrong surface.
 * So nothing below names an item unless it is naming the derivation itself.
 */
describe("computeDockPartition", () => {
    it("every item the host can carry should appear on exactly one surface", () => {
        // Arrange
        const available = hostAvailableItems();

        // Act
        const { dock, topBar } = computeDockPartition(available);

        // Assert: a floor on the sweep first, because a partition of nothing
        // satisfies every property below it.
        expect(available.size).toBeGreaterThan(10);
        expect(dock.length).toBeGreaterThan(0);
        expect(topBar.length).toBeGreaterThan(0);
        expect(dock.length + topBar.length).toBe(available.size);
        expect(new Set([...dock, ...topBar])).toEqual(available);
        expect(dock.filter((id) => topBar.includes(id))).toEqual([]);
    });

    it("an item should dock exactly when it changes the document", () => {
        // `ITEM_MUTATES` is already tied to `COMMAND_EFFECTS` by the tests
        // above, so tying the dock to it is what makes "the formatting
        // controls" a derivation rather than an opinion restated here.
        const { dock, topBar } = computeDockPartition();
        for (const id of dock) { expect(ITEM_MUTATES[id], id).toBe(true); }
        for (const id of topBar) { expect(ITEM_MUTATES[id], id).toBe(false); }
        // Both arms have to discriminate, or one of the loops above is empty
        // and proves nothing.
        expect(dock.length).toBeGreaterThan(0);
        expect(topBar.length).toBeGreaterThan(0);
    });

    it("the dock should carry the items that ship hidden on the top bar, not only the visible ones", () => {
        // The dock takes no placement config at all, which is the difference
        // between "all the formatting controls" and "the ones the bar happens
        // to show". Derived from DEFAULT_PLACEMENTS rather than listed, so a
        // default that changes cannot leave this case asserting nothing.
        const { dock } = computeDockPartition();
        const hiddenByDefault = TOOLBAR_ITEM_IDS.filter(
            (id) => DEFAULT_PLACEMENTS[id] === "hidden" && ITEM_MUTATES[id]);
        expect(hiddenByDefault.length).toBeGreaterThan(0);
        for (const id of hiddenByDefault) { expect(dock, id).toContain(id); }
    });

    it("the dock should be in canonical registry order", () => {
        const { dock, topBar } = computeDockPartition();
        const rank = (id: (typeof TOOLBAR_ITEM_IDS)[number]): number => TOOLBAR_ITEM_IDS.indexOf(id);
        expect(dock.map(rank)).toEqual([...dock.map(rank)].sort((a, b) => a - b));
        expect(topBar.map(rank)).toEqual([...topBar.map(rank)].sort((a, b) => a - b));
    });

    it("an item the host cannot carry should reach neither surface", () => {
        // Arrange: `image` needs an image store, and is the mutating item a
        // host is most likely to lack.
        const available = new Set(TOOLBAR_ITEM_IDS.filter((id) => id !== "image" && id !== "find"));

        // Act
        const { dock, topBar } = computeDockPartition(available);

        // Assert
        expect(dock).not.toContain("image");
        expect(topBar).not.toContain("find");
        // …and the rest still arrived, or "not contains" would hold vacuously.
        expect(dock).toContain("bold");
        expect(topBar).toContain("settings");
    });
});
