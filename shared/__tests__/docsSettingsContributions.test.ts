/**
 * User-facing docs ↔ package.json settings drift guard.
 *
 * The settings table in docs/FEATURES.md is a curated subset written for users,
 * which is exactly the kind of prose that rots silently when a key is renamed or
 * a default changes (the code-side defaults already have this guard in
 * configDefaultsContributions.test.ts; this extends it to the documents users
 * actually read). Two claims are pinned for every `birta.*` key those documents
 * name: the key must exist in package.json's contributes, and — when the table's
 * Default cell is a single code literal — it must equal the contributed default.
 *
 * Both README.md and docs/FEATURES.md are scanned for *mentions*, because the
 * README still names a handful of keys in prose; the table itself lives only in
 * FEATURES.md, and the row-count floor guards against it being moved or emptied
 * without this guard following it (which is what happened when the README was
 * cut down to a storefront and the table moved out).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const features = readFileSync(resolve(root, "docs/FEATURES.md"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const contributed: Record<string, { default?: unknown }> =
    pkg.contributes.configuration.properties;

/** Every `birta.*` key the user-facing docs mention, with backticks stripped. */
const mentionedKeys = [
    ...new Set(
        [...`${readme}\n${features}`.matchAll(/`(birta\.[A-Za-z0-9.]+)`/g)].map((m) => m[1]),
    ),
]
    // Family globs like `birta.styleCheck.*` name a prefix, not a key.
    .filter((k) => !k.endsWith("."));

/** Settings-table rows: | `birta.key` | `default` | description | */
const tableRows = [...features.matchAll(/^\| `(birta\.[A-Za-z0-9.]+)` \| (.+?) \| /gm)].map(
    (m) => ({ key: m[1], defaultCell: m[2].trim() }),
);

/**
 * The minimum VS Code version each user-facing document states. Both name it in
 * prose ("Requires VS Code 1.95 or later"), so match the number after the words.
 */
const statedEngines = [
    { file: "README.md", text: readme },
    { file: "docs/FEATURES.md", text: features },
].flatMap(({ file, text }) =>
    [...text.matchAll(/VS Code \*{0,2}(\d+\.\d+(?:\.\d+)?)\*{0,2} or later/g)].map((m) => ({
        file,
        stated: m[1],
    })),
);

describe("user-facing settings docs stay true to package.json", () => {
    it("docs/FEATURES.md should still carry the settings table", () => {
        expect(tableRows.length).toBeGreaterThanOrEqual(10);
    });

    // Both documents advertised 1.80 for some time after engines.vscode moved to
    // ^1.95 — and the README is the Marketplace listing, so that told shoppers a
    // minimum fifteen releases too low. Prose is where a version silently rots.
    it("both documents should state a minimum VS Code version", () => {
        expect(statedEngines.map((e) => e.file).sort()).toEqual(["README.md", "docs/FEATURES.md"]);
    });

    for (const { file, stated } of statedEngines) {
        it(`${file}'s stated VS Code minimum should match engines.vscode`, () => {
            const contributedMin = /(\d+\.\d+(?:\.\d+)?)/.exec(pkg.engines.vscode)?.[1];
            const norm = (v: string) => v.replace(/(\.0)+$/, "");
            expect(norm(stated), `${file} advertises ${stated}, package.json requires ${pkg.engines.vscode}`)
                .toBe(norm(contributedMin!));
        });
    }

    for (const key of mentionedKeys) {
        it(`mentioned key ${key} should exist in contributes (or prefix a family)`, () => {
            const exists =
                key in contributed ||
                Object.keys(contributed).some((k) => k.startsWith(`${key}.`));
            expect(exists, `${key} is named in user-facing docs but not contributed`).toBe(true);
        });
    }

    for (const { key, defaultCell } of tableRows) {
        const literal = /^`([^`]*)`$/.exec(defaultCell)?.[1];
        if (literal === undefined) continue; // prose default: existence-only
        it(`table default for ${key} should match the contributed default`, () => {
            const actual = contributed[key]?.default;
            // The cell holds a JSON-ish literal: `"preview"`, `600`, `true`, `""`.
            const expected = JSON.parse(literal === "" ? '""' : literal);
            expect(actual, `${key} documented default drifted`).toEqual(expected);
        });
    }
});
