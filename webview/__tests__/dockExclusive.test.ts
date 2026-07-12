/**
 * Dock mutual exclusion (ui/dockExclusive.ts): the find bar and the
 * Keyboard Shortcuts Help overlay occupy the IDENTICAL fixed dock rect
 * (top/right/z-index band), so opening either must close the other —
 * otherwise the second one opens invisibly underneath, focus in an
 * unseeable input.
 *
 * Both modules keep singleton state, and shortcutsHelp/i18n cache
 * platform bits at module load, so every test imports a FRESH module
 * graph via vi.resetModules() + dynamic import (the shortcutsHelp.test.ts
 * harness pattern) — the two components must come from the SAME graph so
 * they share one dockExclusive instance.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type FindBarController = import("../components/findBar").FindBarController;

interface Harness {
    openShortcutsHelp: () => void;
    findBar: FindBarController;
    closeTopmostLayer: () => boolean;
}

async function loadHarness(): Promise<Harness> {
    vi.resetModules();
    document.body.innerHTML = "";
    (window as unknown as { __i18n: { translations: Record<string, string>; isMac: boolean } }).__i18n = {
        translations: {},
        isMac: true,
    };
    // A focusable fake editor host for both components' close-focus handoff.
    const editorDom = document.createElement("div");
    editorDom.className = "ProseMirror";
    editorDom.tabIndex = -1;
    document.body.appendChild(editorDom);
    const { openShortcutsHelp } = await import("../components/shortcutsHelp");
    const { initFindBar } = await import("../components/findBar");
    const { createEventManager } = await import("../eventManager");
    const { closeTopmostLayer } = await import("../ui/escapeLayers");
    const findBar = initFindBar(() => null, () => "", createEventManager());
    return { openShortcutsHelp, findBar, closeTopmostLayer };
}

const helpOpen = (): boolean =>
    document.querySelector(".shortcuts-help")?.classList.contains("shortcuts-help--visible") ?? false;
const findOpen = (): boolean =>
    document.querySelector(".find-bar")?.classList.contains("find-bar--visible") ?? false;

describe("dock exclusivity — find bar vs shortcuts help", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("opening the find bar while the Help overlay is open should close the overlay", async () => {
        const h = await loadHarness();
        h.openShortcutsHelp();
        expect(helpOpen()).toBe(true);

        h.findBar.open();

        expect(helpOpen()).toBe(false);
        expect(findOpen()).toBe(true);
        // No leaked escape layer from the displaced overlay: exactly one
        // layer (the find bar's) remains on the stack.
        expect(h.closeTopmostLayer()).toBe(true); // closes the find bar
        expect(findOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(false); // stack empty
    });

    it("opening the Help overlay while the find bar is open should close the bar", async () => {
        const h = await loadHarness();
        h.findBar.open();
        expect(findOpen()).toBe(true);

        h.openShortcutsHelp();

        expect(findOpen()).toBe(false);
        expect(helpOpen()).toBe(true);
        expect(h.findBar.isOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(true); // closes the overlay
        expect(helpOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(false); // stack empty
    });

    it("normal close-then-open of the other surface should not re-close anything (released dock)", async () => {
        const h = await loadHarness();
        h.findBar.open();
        h.findBar.close();
        h.openShortcutsHelp();
        expect(helpOpen()).toBe(true);
        expect(findOpen()).toBe(false);
        expect(h.closeTopmostLayer()).toBe(true);
        expect(h.closeTopmostLayer()).toBe(false);
    });
});
