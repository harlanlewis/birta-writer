/**
 * Drift guard: the floating selection toolbar's per-item visibility is declared
 * in TWO places — FLOATING_TOOLBAR_ITEM_IDS in the selection-toolbar registry
 * (what the editor gates on) and the `birta.floatingToolbar.items.*` setting
 * defaults in package.json (what the Settings UI shows). Every registered item
 * must have a matching boolean setting defaulting to true ("default all on"),
 * and no orphan settings may exist.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
// Deliberate cross-project import: this node-env drift test asserts the
// package.json contribution defaults against the webview registry, which is
// verified DOM-free. The only place the extension test project reads webview
// source.
import { FLOATING_TOOLBAR_ITEM_IDS } from "../../webview/components/selectionToolbar/registry";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const props: Record<string, { type?: string; default?: unknown }> =
    pkg.contributes.configuration.properties;

const SETTING_PREFIX = "birta.floatingToolbar.items.";

describe("floating toolbar default visibility", () => {
    it("the master enable setting should default to true", () => {
        const master = props["birta.floatingToolbar.enabled"];
        expect(master, "missing birta.floatingToolbar.enabled").toBeDefined();
        expect(master!.type).toBe("boolean");
        expect(master!.default).toBe(true);
    });

    it("every registry item should have a boolean setting defaulting to true", () => {
        for (const id of FLOATING_TOOLBAR_ITEM_IDS) {
            const prop = props[`${SETTING_PREFIX}${id}`];
            expect(prop, `missing setting for floating item "${id}"`).toBeDefined();
            expect(prop!.type, `type for "${id}"`).toBe("boolean");
            expect(prop!.default, `default for "${id}" drifted`).toBe(true);
        }
    });

    it("every floatingToolbar.items setting should map to a registry item", () => {
        const ids = new Set<string>(FLOATING_TOOLBAR_ITEM_IDS);
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
