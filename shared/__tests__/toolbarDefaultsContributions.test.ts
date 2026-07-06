/**
 * Drift guard: the toolbar's shipped default layout is declared in TWO
 * places — `DEFAULT_PLACEMENTS` in the webview registry (what the editor
 * renders when a setting is absent) and the `markdownWysiwyg.toolbar.items.*`
 * setting defaults in package.json (what the Settings UI shows). They must
 * agree, or the Settings UI lies about what the user gets.
 *
 * To change the shipped defaults: edit `DEFAULT_PLACEMENTS`
 * (webview/components/toolbar/registry.ts) AND the matching package.json
 * defaults; the shipped in-zone order is the `TOOLBAR_ITEM_IDS` array order.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
    TOOLBAR_ITEM_IDS,
    DEFAULT_PLACEMENTS,
} from "../../webview/components/toolbar/registry";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const props: Record<string, { default?: unknown; enum?: unknown[] }> =
    pkg.contributes.configuration.properties;

const SETTING_PREFIX = "markdownWysiwyg.toolbar.items.";

describe("toolbar default placements", () => {
    it("every registry item should have a matching setting whose default agrees", () => {
        for (const id of TOOLBAR_ITEM_IDS) {
            const prop = props[`${SETTING_PREFIX}${id}`];
            expect(prop, `missing setting for toolbar item "${id}"`).toBeDefined();
            expect(prop!.default, `default for "${id}" drifted`).toBe(DEFAULT_PLACEMENTS[id]);
            expect(prop!.enum, `enum for "${id}"`).toEqual(["hidden", "left", "center", "right"]);
        }
    });

    it("every toolbar.items setting should map to a registry item", () => {
        const ids = new Set<string>(TOOLBAR_ITEM_IDS);
        for (const key of Object.keys(props)) {
            if (key.startsWith(SETTING_PREFIX)) {
                expect(
                    ids.has(key.slice(SETTING_PREFIX.length)),
                    `setting ${key} has no registry item`,
                ).toBe(true);
            }
        }
    });
});
