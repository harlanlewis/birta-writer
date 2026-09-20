/**
 * Where the gear menu draws its rules, on a surface that keeps every group and
 * on one that has withdrawn most of them.
 *
 * A separator separates GROUPS. Between two groups that are each a single row
 * it separates two rows, which is what the space around them already does, and
 * a run of them turns a short menu into a ladder. The taxonomy itself is
 * untouched (`shared/editorCommands.ts`, mirrored by the native context menu's
 * group prefixes); what changes is whether a boundary is worth drawing on the
 * surface actually being drawn.
 *
 * Both surfaces are here because either alone is satisfied by a menu that
 * draws no rules at all, or by one that draws every rule it can.
 *
 * Read as a SEQUENCE of labels with "-" for a rule, rather than by index: an
 * assertion sliced off the end of the list says nothing about which pair it
 * landed on, and it was wrong about that the first time it was written.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initToolbar } from "../components/toolbar";
import { HOST_PROFILES } from "../../shared/hostProfile";
import type { HostArrangement, HostCapability } from "../../shared/hostProfile";

interface Declaration {
    __i18n?: {
        host?: { capabilities: readonly HostCapability[]; arrangements: readonly HostArrangement[] };
        formattingRowExpanded?: boolean;
    };
}

/**
 * Declare a host. Omitted entirely for VS Code, because an absent declaration
 * IS the VS Code profile (shared/hostProfile.ts) and an empty one is a host
 * with no capabilities at all, which is a different and much emptier menu.
 */
function declare(host?: { capabilities: HostCapability[]; arrangements: HostArrangement[] }): void {
    const g = globalThis as unknown as Declaration;
    if (!host) { delete g.__i18n; return; }
    g.__i18n = { host, formattingRowExpanded: false };
}

/** The gear's own children in order: each row's label, or "-" for a rule. */
function gearSequence(): string[] {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    initToolbar(topbar, () => null);
    const menu = topbar.querySelector(".tb-settings-menu");
    if (!menu) { throw new Error("no gear menu was built"); }
    return Array.from(menu.children).map((el) => {
        if (el.classList.contains("tb-menu-sep")) { return "-"; }
        if (el.classList.contains("tb-submenu-wrap")) {
            return el.querySelector(".tb-submenu-row-label")?.textContent ?? "?";
        }
        return el.textContent ?? "?";
    });
}

/** Whether a rule sits between these two rows, which must both be present. */
function ruleBetween(sequence: string[], before: string, after: string): boolean {
    const i = sequence.indexOf(before);
    const j = sequence.indexOf(after);
    expect(i, `${before} is not in the menu`).toBeGreaterThanOrEqual(0);
    expect(j, `${after} is not in the menu`).toBeGreaterThan(i);
    return sequence.slice(i + 1, j).includes("-");
}

describe("the gear menu's separators", () => {
    beforeEach(() => { document.body.innerHTML = ""; });
    afterEach(() => { declare(); });

    it("a surface that keeps every group should keep every rule", () => {
        // VS Code: layout, shortcuts and settings each carry two rows, so no
        // boundary here is between two lone rows and nothing moves. This is
        // the arm that says the rule below is about singletons rather than
        // about dropping rules in general.
        declare();
        const sequence = gearSequence();
        expect(sequence).toContain("Hide Toolbar");
        expect(ruleBetween(sequence, "Hide Toolbar", "Show Keyboard Shortcuts")).toBe(true);
        expect(ruleBetween(sequence, "Show Keyboard Shortcuts", "Edit Keyboard Shortcuts")).toBe(false);
        expect(ruleBetween(sequence, "Edit Keyboard Shortcuts", "Birta Writer Settings")).toBe(true);
        expect(ruleBetween(sequence, "Birta Writer Settings", "What's New")).toBe(false);
    });

    it("a surface with two lone groups in a row should not fence them from each other", () => {
        // The Mac app: the layout rows are withdrawn by an arrangement and
        // VS Code's own settings, keybindings and release rows by capability,
        // which leaves the keyboard cheatsheet as the whole of one group and
        // the host's Settings row as the whole of the next.
        // The capability list is the shared one; the arrangements are written
        // out because the Mac's are declared in its own Swift and its harness
        // page rather than here (`hostProfile.test.ts` is what holds those two
        // together). Only the three this menu reads are needed, and naming
        // them is what makes the case legible: the layout rows go, the
        // typography arrives, and the formatting row's switch appears.
        declare({
            capabilities: [...HOST_PROFILES.mac],
            arrangements: ["typographyInGearMenu", "fixedToolbarLayout", "formattingInSecondRow"],
        });
        const sequence = gearSequence();
        // The instrument reached the menu this is about, with both pairs in
        // it: an absent row makes `ruleBetween` fail rather than pass.
        expect(ruleBetween(sequence, "Show Keyboard Shortcuts", "Birta Writer Settings")).toBe(false);
        // ...and the editor block runs together, the formatting row's switch
        // beside the checks it sits with.
        expect(ruleBetween(sequence, "Formatting toolbar", "Proofreading")).toBe(false);
        // The typography above them keeps its rule, so this is not a menu that
        // has simply stopped drawing any.
        expect(sequence).toContain("-");
        expect(ruleBetween(sequence, "Monospace", "Formatting toolbar")).toBe(true);
    });
});
