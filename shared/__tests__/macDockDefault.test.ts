/**
 * The Mac app's Dock icon is ON for a new install, and an install from before
 * that default keeps the OFF it never wrote down, because the launch writes it
 * (`Prefs.keepExistingDockChoice`). `DockDefaultTests` holds the migration's
 * arms; what no Swift test can reach is that the launch calls it, and calls it
 * before the activation policy reads the setting. Dropped or moved below that
 * read, every install that never touched the switch gains an icon on update.
 *
 * The other half is the new install's ON written down on its first launch
 * (`Prefs.recordNewInstallDock`), without which its second launch looks like
 * an install from before the change. It has to come after the launch reads
 * whether it is the first, since storing any key ends a first launch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sources = join(__dirname, "..", "..", "mac", "Sources", "BirtaWriter");
const entry = readFileSync(join(sources, "Entry.swift"), "utf8");
const app = readFileSync(join(sources, "App.swift"), "utf8");

describe("the Mac app's Dock default", () => {
    it("the launch should keep an existing install's choice before the policy reads it", () => {
        const keep = entry.indexOf("Prefs.keepExistingDockChoice()");
        const apply = entry.indexOf("AppDelegate.applyActivationPolicy()");
        expect(keep, "the launch never keeps an existing install's Dock choice").toBeGreaterThan(0);
        expect(apply).toBeGreaterThan(0);
        expect(keep).toBeLessThan(apply);
    });

    it("a first launch should write its Dock default down after reading that it is the first", () => {
        const read = app.indexOf("let firstLaunch = Prefs.isFirstLaunch");
        const record = app.indexOf("Prefs.recordNewInstallDock(firstLaunch: firstLaunch)");
        expect(read).toBeGreaterThan(0);
        expect(record, "a new install never writes its Dock default down").toBeGreaterThan(0);
        expect(read).toBeLessThan(record);
    });
});
