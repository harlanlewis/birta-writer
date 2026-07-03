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

// Dispatch on document.body by default: real key events target the focused
// element and bubble through document up to window, which is where the
// VS Code webview host's key forwarder lives (the shortcuts and the key-leak
// guard both listen on document, one node below it).
function pressKey(
    code: string,
    modifiers: Partial<KeyboardEvent> = {},
    target: EventTarget = document.body,
): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
        code,
        bubbles: true,
        cancelable: true,
        ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
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

describe("initKeyboardShortcuts workbench key-leak guard", () => {
    let manager: EventManager;
    let findBar: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; isOpen: ReturnType<typeof vi.fn> };
    /**
     * Stand-in for the VS Code webview host's key forwarder: a bubble-phase
     * keydown listener on `window`. Keys the editor claims must never reach
     * it; everything else must.
     */
    let workbenchForwarder: ReturnType<typeof vi.fn>;
    let editorEl: HTMLElement;
    let proseMirrorEl: HTMLElement;

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
        workbenchForwarder = vi.fn();
        window.addEventListener("keydown", workbenchForwarder);

        editorEl = document.createElement("div");
        editorEl.id = "editor";
        proseMirrorEl = document.createElement("div");
        proseMirrorEl.className = "ProseMirror";
        editorEl.appendChild(proseMirrorEl);
        document.body.appendChild(editorEl);
    });

    afterEach(() => {
        manager.dispose();
        window.removeEventListener("keydown", workbenchForwarder);
        editorEl.remove();
        delete window.__i18n;
    });

    it("Cmd+B inside the editor content should be stopped before reaching window", () => {
        init(true);
        const containerListener = vi.fn();
        editorEl.addEventListener("keydown", containerListener);

        const event = pressKey("KeyB", { metaKey: true }, proseMirrorEl);

        // The event must still bubble through the editor DOM (so ProseMirror
        // handles it) but never reach the window-level forwarder.
        expect(containerListener).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
        // The guard itself never suppresses the default action; that stays
        // ProseMirror's call (no ProseMirror is mounted in this test).
        expect(event.defaultPrevented).toBe(false);
    });

    it.each([
        ["Cmd+I (italic)", "KeyI", { metaKey: true }],
        ["Cmd+E (inline code)", "KeyE", { metaKey: true }],
        ["Cmd+Shift+X (strikethrough)", "KeyX", { metaKey: true, shiftKey: true }],
        ["Cmd+Z (undo)", "KeyZ", { metaKey: true }],
        ["Cmd+Shift+Z (redo)", "KeyZ", { metaKey: true, shiftKey: true }],
        ["Ctrl+Y (redo)", "KeyY", { ctrlKey: true }],
        ["Alt+K (send to Claude)", "KeyK", { altKey: true }],
    ] as const)("%s should not reach window listeners", (_label, code, modifiers) => {
        init(true);
        pressKey(code, modifiers, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Cmd+F should open the find bar and not leak to the workbench", () => {
        init(true);
        pressKey("KeyF", { metaKey: true }, proseMirrorEl);
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+M should still post the switch message while being swallowed", () => {
        init(true);
        pressKey("KeyM", { metaKey: true, shiftKey: true }, proseMirrorEl);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "switchToTextEditor" });
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Ctrl+H should be claimed on Windows/Linux but not on macOS", () => {
        init(false);
        pressKey("KeyH", { ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
        manager.dispose();

        init(true);
        pressKey("KeyH", { ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("Cmd+P (not claimed by the editor) should still reach window listeners", () => {
        init(true);
        const event = pressKey("KeyP", { metaKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    it("Cmd+Shift+E (claimed combo plus an extra modifier) should still reach window listeners", () => {
        init(true);
        pressKey("KeyE", { metaKey: true, shiftKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("plain letter typing should still reach window listeners", () => {
        init(true);
        const event = pressKey("KeyA", {}, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    it("Tab inside the ProseMirror content should be stopped", () => {
        init(true);
        pressKey("Tab", {}, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Tab outside the editor content should keep propagating", () => {
        init(true);
        pressKey("Tab", {}, document.body);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });
});
