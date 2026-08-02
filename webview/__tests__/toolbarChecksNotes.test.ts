/**
 * The Checks menu's "Highlight notes" row — the in-text editor-note highlight
 * (birta.notes.highlightMarkers) surfaced as a switch.
 *
 * Its POSITION is the design, and that is what these assert: it leads the menu
 * as a sibling of the master Proofreading gate — same rank, same emphasis, and
 * outside the body that gate governs. Note markers are the writer's own content,
 * not findings, so turning proofreading off must leave them alone; the row
 * staying put through a gate cycle is the observable form of that.
 *
 * The order assertion is a structural guard, not a re-test of a live bug: with
 * the row first and the gated body last, the gate's detach/re-attach cannot
 * reorder anything today. It pins that arrangement, because the re-attach is an
 * `appendChild` — the moment anything is added to the menu *after* the body, an
 * off→on cycle would silently sort it above the checks, and a row count would
 * still read correct. (An earlier draft placed this row at the foot and hit
 * exactly that; the fix was the placement, not an `insertBefore`.)
 *
 * The gate's own behavior (what gets decorated) is covered by noteMarkers.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { initToolbar } from "../components/toolbar";
import { mockVscodeApi } from "./setup";

function buildToolbar(): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    initToolbar(topbar, () => null);
    return topbar;
}

const MENU = ".tb-checks-menu";

/** Switch-row labels in the Checks menu, in DOM order. */
function switchLabels(topbar: HTMLElement): string[] {
    return Array.from(
        topbar.querySelectorAll<HTMLElement>(`${MENU} .tb-switch-item-label`),
    ).map((el) => el.textContent ?? "");
}

function notesRow(topbar: HTMLElement): HTMLElement {
    return topbar.querySelectorAll<HTMLElement>(`${MENU} .tb-switch-item`)[0]!;
}

/**
 * Drive the gate the way the extension does — the `proofread-config-changed`
 * echo the toolbar repaints from. (Clicking the gate row instead would need the
 * editor singleton, which these DOM-shape tests deliberately do without; the
 * click path itself is covered by e2e/checksMenu.)
 */
function setGate(proofreadingEnabled: boolean): void {
    window.dispatchEvent(new CustomEvent("proofread-config-changed", {
        detail: { proofreadingEnabled, styleCheck: true },
    }));
}

const flip = (row: HTMLElement): void => {
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
};

afterEach(() => {
    delete window.__i18n;
    document.body.innerHTML = "";
});

describe("Checks menu — Notes section", () => {
    it("the highlight switch should lead the menu, above the Proofreading gate", () => {
        const topbar = buildToolbar();

        expect(switchLabels(topbar).slice(0, 2)).toEqual(["Highlight notes", "Proofreading"]);

        const row = notesRow(topbar);
        expect(row.getAttribute("role")).toBe("switch");
        // Highlighting ships on, so the switch must open showing "on" — a row
        // that reads off while chips are painted is worse than no row at all.
        expect(row.getAttribute("aria-checked")).toBe("true");
    });

    it("the highlight switch should carry the same rank as the gate, not a section header", () => {
        const topbar = buildToolbar();

        // Same emphasis class as the master gate: the two read as peers.
        expect(notesRow(topbar).classList.contains("tb-checks-master")).toBe(true);
        // Peers, not a titled section — a header would read as something the
        // gate below opens.
        const headers = Array.from(
            topbar.querySelectorAll<HTMLElement>(`${MENU} .tb-fmt-header`),
        ).map((el) => el.textContent);
        expect(headers).not.toContain("Notes");
    });

    it("the highlight switch should live outside the body the Proofreading gate governs", () => {
        const topbar = buildToolbar();
        const body = topbar.querySelector<HTMLElement>(`${MENU} .tb-checks-body`)!;

        expect(body.contains(notesRow(topbar))).toBe(false);
    });

    it("turning Proofreading off should keep the highlight switch offered", () => {
        const topbar = buildToolbar();

        setGate(false);

        // The checks collapse away; the writer's own notes are not a check.
        expect(switchLabels(topbar)).toEqual(["Highlight notes", "Proofreading"]);
    });

    it("cycling the Proofreading gate should not reorder the menu", () => {
        const topbar = buildToolbar();
        setGate(true);
        const before = switchLabels(topbar);
        expect(before.length).toBeGreaterThan(2);

        setGate(false);
        setGate(true);

        expect(switchLabels(topbar)).toEqual(before);
        expect(switchLabels(topbar)[0]).toBe("Highlight notes");
    });

    it("clicking the highlight switch should flip the gate, the row, and persist it", () => {
        window.__i18n = { translations: {}, isMac: false, notesHighlightMarkers: true };
        const topbar = buildToolbar();
        const row = notesRow(topbar);
        expect(row.getAttribute("aria-checked")).toBe("true");

        flip(row);

        expect(window.__i18n?.notesHighlightMarkers).toBe(false);
        expect(row.getAttribute("aria-checked")).toBe("false");
        expect(row.classList.contains("tb-switch-item--on")).toBe(false);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "setNoteHighlight",
            enabled: false,
        });
    });

    it("a flip made elsewhere should repaint the row without reopening the menu", () => {
        // The same gate is flippable from the Notes tab, the palette, and the
        // Settings UI; all of them land on the plugin's re-gate, which announces.
        window.__i18n = { translations: {}, isMac: false, notesHighlightMarkers: true };
        const topbar = buildToolbar();
        const row = notesRow(topbar);

        window.__i18n!.notesHighlightMarkers = false;
        window.dispatchEvent(new CustomEvent("note-highlight-changed"));

        expect(row.getAttribute("aria-checked")).toBe("false");
    });
});
