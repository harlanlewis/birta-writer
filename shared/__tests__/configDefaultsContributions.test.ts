/**
 * Drift guard for the WHOLE `birta.*` settings surface (MAR-167): every
 * contributed key in package.json must have its default asserted equal to the
 * code default in shared/config.ts's BIRTA_CONFIG_DEFAULTS — the one table the
 * extension reads through src/config.ts. One table-driven test, so adding a
 * setting without teaching the snapshot about it (or letting either side's
 * default drift) fails the build.
 *
 * The per-item `toolbar.items.*` / `floatingToolbar.items.*` keys are excluded
 * here: their snapshot fields are the nested object reads (code default `{}`,
 * VS Code merges the contributed per-item defaults in), and their per-item
 * drift is pinned by toolbarDefaultsContributions.test.ts /
 * floatingToolbarDefaultsContributions.test.ts.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
    BIRTA_CONFIG_DEFAULTS,
    BIRTA_SETTING_KEYS,
    type BirtaConfig,
} from "../config";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const props: Record<string, { default?: unknown }> =
    pkg.contributes.configuration.properties;

/** Per-item keys covered by their own registry drift tests, not the snapshot. */
const PER_ITEM_KEY = /^birta\.(toolbar|floatingToolbar)\.items\./;

/** Snapshot fields whose setting is the nested map itself (no contributed key). */
const NESTED_MAP_FIELDS = new Set<keyof BirtaConfig>([
    "toolbarPlacements",
    "floatingToolbarItems",
]);

const settingToField = new Map<string, keyof BirtaConfig>(
    (Object.entries(BIRTA_SETTING_KEYS) as Array<[keyof BirtaConfig, string]>).map(
        ([field, key]) => [`birta.${key}`, field],
    ),
);

describe("birta.* config defaults", () => {
    it("every contributed birta.* setting should be in the snapshot with a matching code default", () => {
        const contributed = Object.keys(props).filter(
            (key) => key.startsWith("birta.") && !PER_ITEM_KEY.test(key),
        );
        // Guard against a vacuous pass if the contribution section moves.
        expect(contributed.length).toBeGreaterThan(20);

        for (const key of contributed) {
            const field = settingToField.get(key);
            expect(field, `${key} is contributed but missing from BIRTA_SETTING_KEYS`).toBeDefined();
            expect(
                BIRTA_CONFIG_DEFAULTS[field!],
                `code default for ${String(field)} drifted from ${key}`,
            ).toEqual(props[key].default);
        }
    });

    it("every snapshot field should map to a contributed setting (or a nested item map)", () => {
        for (const [field, key] of Object.entries(BIRTA_SETTING_KEYS) as Array<
            [keyof BirtaConfig, string]
        >) {
            if (NESTED_MAP_FIELDS.has(field)) {
                expect(
                    BIRTA_CONFIG_DEFAULTS[field],
                    `${String(field)} is a nested map read; its code default must be the empty map`,
                ).toEqual({});
                continue;
            }
            expect(
                props[`birta.${key}`],
                `BIRTA_SETTING_KEYS.${String(field)} names birta.${key}, which is not contributed in package.json`,
            ).toBeDefined();
        }
    });
});
