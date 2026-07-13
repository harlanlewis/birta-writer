/**
 * shortcutsHelp component tests: lazy one-time DOM build, section content,
 * platform-correct kbd rendering, escape-layer hygiene on every close path,
 * the Customize Shortcuts messaging call, and focus handoff.
 *
 * The module keeps singleton state (panel element, visibility, layer
 * handle) and i18n caches `isMac` at module load, so every test imports a
 * FRESH module graph via vi.resetModules() + dynamic import, with
 * window.__i18n set first.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";

type ShortcutsHelpModule = typeof import("../components/shortcutsHelp");
type EscapeLayersModule = typeof import("../ui/escapeLayers");

interface Harness {
    openShortcutsHelp: ShortcutsHelpModule["openShortcutsHelp"];
    closeTopmostLayer: EscapeLayersModule["closeTopmostLayer"];
    editorDom: HTMLElement;
}

/** Fresh module graph + a focusable fake .ProseMirror host. */
async function loadHarness(isMac: boolean): Promise<Harness> {
    vi.resetModules();
    document.body.innerHTML = "";
    (window as unknown as { __i18n: { translations: Record<string, string>; isMac: boolean } }).__i18n = {
        translations: {},
        isMac,
    };
    const editorDom = document.createElement("div");
    editorDom.className = "ProseMirror";
    editorDom.tabIndex = -1; // focusable in jsdom
    document.body.appendChild(editorDom);
    const { openShortcutsHelp } = await import("../components/shortcutsHelp");
    const { closeTopmostLayer } = await import("../ui/escapeLayers");
    return { openShortcutsHelp, closeTopmostLayer, editorDom };
}

const panels = () => document.querySelectorAll<HTMLElement>(".shortcuts-help");
const panel = () => document.querySelector<HTMLElement>(".shortcuts-help");
const isOpen = () => panel()?.classList.contains("shortcuts-help--visible") ?? false;

function pressEscape(target: HTMLElement): void {
    target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
}

/** createButton acts on mousedown (real mouse) — mirror that in tests. */
function clickButton(btn: HTMLElement): void {
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

describe("shortcutsHelp — lazy build and toggling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("importing the module should build no DOM until the first open", async () => {
        const h = await loadHarness(true);
        expect(panels().length).toBe(0);
        h.openShortcutsHelp();
        expect(panels().length).toBe(1);
        expect(isOpen()).toBe(true);
    });

    it("reopening after a close should reuse the panel, not duplicate it", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        h.openShortcutsHelp(); // toggle closed
        expect(isOpen()).toBe(false);
        h.openShortcutsHelp(); // reopen
        expect(panels().length).toBe(1);
        expect(isOpen()).toBe(true);
    });

    it("invoking the command while open should close (toggle) without a dead layer", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        h.openShortcutsHelp();
        expect(isOpen()).toBe(false);
        // No stale escape-layer entry left behind
        expect(h.closeTopmostLayer()).toBe(false);
    });
});

describe("shortcutsHelp — content", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("open should render the fixed-grammar sections and the rebindable groups", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        const text = panel()!.textContent!;
        const sections = [...panel()!.querySelectorAll(".shortcuts-help__section-title")].map(
            (s) => s.textContent,
        );
        expect(sections).toEqual([
            "Selection",
            "Blocks",
            "Formatting & history",
            "Customizable commands",
        ]);
        // Fixed grammar highlights
        expect(text).toContain("Select more: block text → block → document");
        expect(text).toContain("Move carries a heading's whole section.");
        expect(text).toContain("Duplicate copies the block alone");
        expect(text).toContain("Inside a code block or table: exits it instead.");
        expect(text).toContain("Esc first closes the open menu, popup, or find bar.");
        expect(text).toContain("Collapse / expand the selected foldable block");
        // Rebindable commands appear by NAME, sourced from the registry
        expect(text).toContain("Open Block Menu");
        expect(text).toContain("Select All Occurrences");
        const folding = [...panel()!.querySelectorAll(".shortcuts-help__group")].find(
            (g) => g.querySelector(".shortcuts-help__group-name")?.textContent === "Folding",
        );
        expect(folding).toBeDefined();
        expect(
            [...folding!.querySelectorAll(".shortcuts-help__group-item")].map((i) => i.textContent),
        ).toEqual(["Fold", "Unfold", "Fold All", "Unfold All"]);
        // Group items carry no kbd chips (names only)
        const groupKbds = panel()!.querySelectorAll(".shortcuts-help__group kbd");
        expect(groupKbds.length).toBe(0);
    });

    it("group items should be real list items with hover-recoverable titles", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        const lists = panel()!.querySelectorAll(".shortcuts-help__group-items");
        expect(lists.length).toBeGreaterThanOrEqual(1);
        for (const list of lists) {
            // ul/li semantics: assistive tech announces item count and
            // boundaries that the visual grid alone does not provide.
            expect(list.tagName).toBe("UL");
            const items = [...list.children];
            expect(items.length).toBeGreaterThanOrEqual(1);
            for (const item of items) {
                expect(item.tagName).toBe("LI");
                expect(item.className).toBe("shortcuts-help__group-item");
                // Ellipsized names stay recoverable on hover.
                expect((item as HTMLElement).title).toBe(item.textContent);
            }
        }
    });

    it("every row should use the two-column key/description grid structure", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        const rows = [...panel()!.querySelectorAll(".shortcuts-help__row")];
        expect(rows.length).toBeGreaterThanOrEqual(12);
        for (const row of rows) {
            // Exactly one key cell then one description cell — the shared
            // grid template (--shortcuts-keycol | 1fr) is what keeps every
            // description's left edge at the same x.
            expect(row.children.length).toBe(2);
            const [keysCell, descCell] = row.children;
            expect(keysCell.className).toBe("shortcuts-help__keys");
            expect(descCell.className).toBe("shortcuts-help__desc");
            // The key cell holds only pair sub-spans (one per gesture
            // alternative), and every chip lives inside a pair — that
            // atomicity is what keeps wraps between alternatives only.
            expect(keysCell.children.length).toBeGreaterThanOrEqual(1);
            for (const pair of keysCell.children) {
                expect(pair.className).toBe("shortcuts-help__pair");
                expect(pair.querySelectorAll("kbd").length).toBeGreaterThanOrEqual(1);
                for (const chip of pair.children) {
                    expect(chip.tagName).toBe("KBD");
                }
            }
            // Chips live only in the key cell; the description cell holds
            // the label and (optionally) the quieter note line beneath it.
            expect(keysCell.querySelectorAll("kbd").length).toBeGreaterThanOrEqual(1);
            expect(descCell.querySelector("kbd")).toBeNull();
            expect(descCell.querySelector(".shortcuts-help__label")).not.toBeNull();
        }
        // The move row groups its four chips as two alternatives of two
        // chips each (never a flat run that could wrap 3+1).
        const moveRow = rows.find((r) => r.textContent!.includes("Move block up / down"))!;
        const movePairs = [...moveRow.querySelectorAll(".shortcuts-help__pair")];
        expect(movePairs.map((p) => p.querySelectorAll("kbd").length)).toEqual([2, 2]);
        // Notes render inside the description cell, never as loose
        // full-width lines under the key column.
        const rowNotes = panel()!.querySelectorAll(".shortcuts-help__row .shortcuts-help__note");
        expect(rowNotes.length).toBeGreaterThanOrEqual(4);
        for (const note of rowNotes) {
            expect(note.parentElement!.className).toBe("shortcuts-help__desc");
        }
        // The platform column-width modifier is applied (mac harness).
        expect(panel()!.classList.contains("shortcuts-help--mac")).toBe(true);
    });

    it("macOS should render symbol chords (⌘B, ⌃⇧⌘→, ⇧⌥↓)", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        const chips = [...panel()!.querySelectorAll("kbd")].map((k) => k.textContent);
        expect(chips).toContain("⌘B");
        expect(chips).toContain("⌃⇧⌘→");
        expect(chips).toContain("⇧⌥↓");
        expect(chips).toContain("⌘Enter");
        expect(chips).toContain("⇧Tab");
        expect(chips).toContain("Esc");
    });

    it("Windows/Linux should render Ctrl+ chords and the Shift+Alt smart-select pair", async () => {
        const h = await loadHarness(false);
        h.openShortcutsHelp();
        const chips = [...panel()!.querySelectorAll("kbd")].map((k) => k.textContent);
        expect(chips).toContain("Ctrl+B");
        expect(chips).toContain("Shift+Alt+→");
        expect(chips).toContain("Ctrl+Shift+↑");
        expect(chips).toContain("Ctrl+Enter");
        expect(chips).toContain("Shift+Tab");
        // No mac-only chord leaks onto the other platform
        expect(chips.some((c) => c!.includes("⌘"))).toBe(false);
        // And the mac column-width modifier must be absent — win/linux use
        // the wider word-chain key column.
        expect(panel()!.classList.contains("shortcuts-help--mac")).toBe(false);
    });
});

describe("shortcutsHelp — escape layering and close paths", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("open should register exactly one escape layer that closes the panel", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        expect(h.closeTopmostLayer()).toBe(true); // pops + closes the overlay
        expect(isOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(false); // nothing left on the stack
    });

    it("Escape inside the panel should close and unregister the layer", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        pressEscape(panel()!);
        expect(isOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(false);
    });

    it("the close button should close and unregister the layer", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        clickButton(panel()!.querySelector<HTMLElement>(".shortcuts-help__close")!);
        expect(isOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(false);
    });

    it("an outside mousedown should close and unregister the layer", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        h.editorDom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(isOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(false);
    });

    it("a mousedown inside the panel should NOT close it", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        panel()!.querySelector<HTMLElement>(".shortcuts-help__title")!.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true }),
        );
        expect(isOpen()).toBe(true);
    });

    it("reopen after each close path should register a fresh layer, never two", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        pressEscape(panel()!);
        h.openShortcutsHelp();
        expect(h.closeTopmostLayer()).toBe(true);
        expect(h.closeTopmostLayer()).toBe(false); // exactly one entry existed
    });
});

describe("shortcutsHelp — focus and the customize action", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("open should move focus into the panel; close should return it to the editor", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        expect(document.activeElement).toBe(panel());
        pressEscape(panel()!);
        expect(document.activeElement).toBe(h.editorDom);
    });

    it("the Customize Shortcuts button should post openKeybindings and close", async () => {
        const h = await loadHarness(true);
        h.openShortcutsHelp();
        clickButton(panel()!.querySelector<HTMLElement>(".shortcuts-help__customize")!);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openKeybindings" });
        expect(isOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(false);
    });
});
