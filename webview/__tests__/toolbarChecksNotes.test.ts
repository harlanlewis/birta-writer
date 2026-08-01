/**
 * The Checks menu's Notes section — the in-text editor-note highlight
 * (birta.notes.highlightMarkers) surfaced as a switch beside the proofreading
 * checks (MAR-283).
 *
 * Two things are structural rather than cosmetic, and both are asserted here:
 *
 *   1. The row sits OUTSIDE the gated body. Note markers are the writer's own
 *      content, not findings, so the master Proofreading gate must not silence
 *      them — with proofreading off the menu still offers this switch.
 *   2. Because something is now pinned BELOW the body, the gate's re-attach has
 *      to insert rather than append. An append would leave the menu reordered
 *      (checks under the Notes header) after one gate off→on cycle — invisible
 *      to any assertion that only counts rows.
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
    return topbar.querySelector<HTMLElement>(`${MENU} .tb-checks-notes .tb-switch-item`)!;
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
    it("the menu should end with a Notes header and its highlight switch", () => {
        const topbar = buildToolbar();

        const headers = Array.from(
            topbar.querySelectorAll<HTMLElement>(`${MENU} .tb-fmt-header`),
        ).map((el) => el.textContent);
        expect(headers.at(-1)).toBe("Notes");

        const row = notesRow(topbar);
        expect(row.querySelector(".tb-switch-item-label")?.textContent).toBe("Highlight notes");
        expect(row.getAttribute("role")).toBe("switch");
        // Highlighting ships on, so the switch must open showing "on" — a row
        // that reads off while chips are painted is worse than no row at all.
        expect(row.getAttribute("aria-checked")).toBe("true");
    });

    it("the Notes row should live outside the body the Proofreading gate governs", () => {
        const topbar = buildToolbar();
        const body = topbar.querySelector<HTMLElement>(`${MENU} .tb-checks-body`)!;

        expect(body.contains(notesRow(topbar))).toBe(false);
    });

    it("turning Proofreading off should keep the Notes switch offered", () => {
        const topbar = buildToolbar();

        setGate(false);

        // The checks collapse away; the writer's own notes are not a check.
        expect(switchLabels(topbar)).toEqual(["Proofreading", "Highlight notes"]);
    });

    it("cycling the Proofreading gate should not reorder the menu", () => {
        const topbar = buildToolbar();
        setGate(true);
        const before = switchLabels(topbar);
        expect(before.length).toBeGreaterThan(2);

        setGate(false);
        setGate(true);

        // Re-attaching the body must put it back ABOVE the notes section.
        expect(switchLabels(topbar)).toEqual(before);
        expect(switchLabels(topbar).at(-1)).toBe("Highlight notes");
    });

    it("clicking the Notes switch should flip the gate, the row, and persist it", () => {
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
