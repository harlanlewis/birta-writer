/**
 * keyboardShortcuts.ts tests: verify the window-level shortcuts are wired to
 * the right actions (find bar, replace, switch to text editor).
 *
 * These are the user-facing bindings that regressed when onShortcut required
 * Meta AND Ctrl together — the unit tests in eventManager.test.ts cover the
 * matcher itself; this file covers the wiring on top of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { createEventManager, type EventManager } from "../eventManager";
import { initKeyboardShortcuts } from "../keyboardShortcuts";
import type { FindBarController } from "../components/findBar";

function pressKey(code: string, modifiers: Partial<KeyboardEvent> = {}): void {
    window.dispatchEvent(
        new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...modifiers }),
    );
}

describe("initKeyboardShortcuts find/replace bindings", () => {
    let manager: EventManager;
    let findBar: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; isOpen: ReturnType<typeof vi.fn> };

    function init(isMac: boolean): void {
        window.__i18n = { translations: {}, isMac };
        manager = createEventManager();
        initKeyboardShortcuts(
            manager,
            () => null,
            () => [],
            () => "",
            () => 1,
            findBar as unknown as FindBarController,
        );
    }

    beforeEach(() => {
        vi.clearAllMocks();
        findBar = { open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false) };
    });

    afterEach(() => {
        manager.dispose();
        delete window.__i18n;
    });

    it("Cmd+F (macOS) should open the find bar", () => {
        init(true);
        pressKey("KeyF", { metaKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(findBar.open).toHaveBeenCalledWith();
    });

    it("Ctrl+F (Windows/Linux) should open the find bar", () => {
        init(false);
        pressKey("KeyF", { ctrlKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
    });

    it("Cmd+Alt+F should open the find bar with the replace row shown", () => {
        init(true);
        pressKey("KeyF", { metaKey: true, altKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(findBar.open).toHaveBeenCalledWith(undefined, { showReplace: true });
    });

    it("Ctrl+H on Windows/Linux should open the find bar with replace", () => {
        init(false);
        pressKey("KeyH", { ctrlKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(findBar.open).toHaveBeenCalledWith(undefined, { showReplace: true });
    });

    it("Ctrl+H on macOS should stay unbound (it is delete-backward there)", () => {
        init(true);
        pressKey("KeyH", { ctrlKey: true });
        expect(findBar.open).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+F should not open the find bar (reserved for global search)", () => {
        init(true);
        pressKey("KeyF", { metaKey: true, shiftKey: true });
        expect(findBar.open).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+M should request the switch to the text editor", () => {
        init(true);
        pressKey("KeyM", { metaKey: true, shiftKey: true });
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "switchToTextEditor" });
    });
});
