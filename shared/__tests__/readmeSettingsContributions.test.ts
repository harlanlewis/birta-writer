/**
 * README ↔ package.json settings drift guard.
 *
 * The README's Settings table is a curated subset written for users, which is
 * exactly the kind of prose that rots silently when a key is renamed or a
 * default changes (the code-side defaults already have this guard in
 * configDefaultsContributions.test.ts; this extends it to the document users
 * actually read). Two claims are pinned for every `birta.*` key the README
 * names anywhere: the key must exist in package.json's contributes, and —
 * when the table's Default cell is a single code literal — it must equal the
 * contributed default.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const contributed: Record<string, { default?: unknown }> =
    pkg.contributes.configuration.properties;

/** Every `birta.*` key the README mentions, with backticks stripped. */
const mentionedKeys = [...new Set([...readme.matchAll(/`(birta\.[A-Za-z0-9.]+)`/g)].map((m) => m[1]))]
    // Family globs like `birta.styleCheck.*` name a prefix, not a key.
    .filter((k) => !k.endsWith("."));

/** Settings-table rows: | `birta.key` | `default` | description | */
const tableRows = [...readme.matchAll(/^\| `(birta\.[A-Za-z0-9.]+)` \| (.+?) \| /gm)].map(
    (m) => ({ key: m[1], defaultCell: m[2].trim() }),
);

describe("README settings stay true to package.json", () => {
    it("the README should name at least the settings-table keys", () => {
        expect(tableRows.length).toBeGreaterThanOrEqual(10);
    });

    for (const key of mentionedKeys) {
        it(`mentioned key ${key} should exist in contributes (or prefix a family)`, () => {
            const exists =
                key in contributed ||
                Object.keys(contributed).some((k) => k.startsWith(`${key}.`));
            expect(exists, `${key} is named in README but not contributed`).toBe(true);
        });
    }

    for (const { key, defaultCell } of tableRows) {
        const literal = /^`([^`]*)`$/.exec(defaultCell)?.[1];
        if (literal === undefined) continue; // prose default: existence-only
        it(`table default for ${key} should match the contributed default`, () => {
            const actual = contributed[key]?.default;
            // The cell holds a JSON-ish literal: `"preview"`, `600`, `true`, `""`.
            const expected = JSON.parse(literal === "" ? '""' : literal);
            expect(actual, `${key} README default drifted`).toEqual(expected);
        });
    }
});
