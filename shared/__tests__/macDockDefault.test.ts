/**
 * The Mac app's Dock icon is ON for a new install, and an install from before
 * that default keeps the OFF it never wrote down, because the launch writes it
 * (`Prefs.keepExistingDockChoice`). `DockDefaultTests` holds the migration's
 * arms; what no Swift test can reach is that the launch calls it, and calls it
 * before the activation policy reads the setting. Dropped or moved below that
 * read, every install that never touched the switch gains an icon on update.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const entry = readFileSync(join(__dirname, "..", "..", "mac", "Sources", "BirtaWriter", "Entry.swift"), "utf8");

describe("the Mac app's Dock default", () => {
    it("the launch should keep an existing install's choice before the policy reads it", () => {
        const keep = entry.indexOf("Prefs.keepExistingDockChoice()");
        const apply = entry.indexOf("AppDelegate.applyActivationPolicy()");
        expect(keep, "the launch never keeps an existing install's Dock choice").toBeGreaterThan(0);
        expect(apply).toBeGreaterThan(0);
        expect(keep).toBeLessThan(apply);
    });
});
