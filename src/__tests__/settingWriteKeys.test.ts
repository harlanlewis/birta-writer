/**
 * Every setting the extension WRITES must be a setting it CONTRIBUTES.
 *
 * `updateSettingRespectingScope(key, value)` calls `cfg.update(key, …)` on the
 * `birta` configuration section, so its first argument is the VS Code SETTINGS
 * KEY. That is easy to get wrong in exactly one way: for a flat setting the key
 * and the config snapshot's field name are identical, so a nested one is the
 * only place they can diverge, and the divergence is silent. Writing an
 * unregistered key does not surface anywhere the user can see; the toggle
 * simply never survives a reload.
 *
 * That is not hypothetical. `review.groupByType` was written as
 * `reviewGroupByType` (the field name), so the review sidebar's
 * By-type/In-order choice was discarded on every reload. Found by an
 * enumeration pass over the message handlers, not by a test, because no test
 * covered that key.
 *
 * This guard reads the SOURCE rather than driving each handler, deliberately.
 * Driving them would pin only the handlers someone remembered to drive, and the
 * defect class is precisely "nobody looked at this one". Scanning every literal
 * means a new write site is covered the day it lands.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const contributed = new Set(Object.keys(pkg.contributes.configuration.properties));

/** Source files that may write a setting. */
const SOURCES = ["src/MarkdownEditorProvider.ts", "src/extension.ts", "src/config.ts"];

/** `updateSettingRespectingScope("some.key"` / `updateUserSetting("some.key"` */
const WRITE_CALL = /update(?:SettingRespectingScope|UserSetting)\(\s*"([^"]+)"/g;

describe("settings the extension writes", () => {
    const found: Array<{ file: string; key: string }> = [];
    for (const rel of SOURCES) {
        const text = fs.readFileSync(path.join(root, rel), "utf8");
        for (const m of text.matchAll(WRITE_CALL)) {
            found.push({ file: rel, key: m[1] });
        }
    }

    it("should find write sites at all, or this guard is asserting over nothing", () => {
        // A sweep that enumerates nothing passes. The floor is deliberately
        // well under the real count so an ordinary edit does not trip it, while
        // a regex that stopped matching does.
        expect(found.length, JSON.stringify(found)).toBeGreaterThan(8);
    });

    it("every written key should be contributed in package.json", () => {
        const orphans = found
            .filter(({ key }) => !contributed.has(`birta.${key}`))
            .map(({ file, key }) => `${file}: birta.${key}`);
        expect(orphans, orphans.join("\n")).toEqual([]);
    });
});
