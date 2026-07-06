/**
 * keyboardShortcuts.ts tests: the workbench key-leak guard.
 *
 * The module handles no editor shortcuts itself anymore — every rebindable
 * action (find family, insert link, switch to text editor) is a contributed
 * keybinding resolved by the workbench and routed back via the editorCommand
 * message. These tests verify the two sides of that contract:
 *   - typing-level ProseMirror combos (format, history, Tab) are claimed and
 *     never reach the workbench forwarder;
 *   - every rebindable chord keeps propagating so the user's (possibly
 *     rebound) keybinding can resolve it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventManager, type EventManager } from "../eventManager";
import { initKeyboardShortcuts } from "../keyboardShortcuts";

// Dispatch on the ProseMirror element by default: real key events target the
// focused element and bubble through document up to window, which is where
// the VS Code webview host's key forwarder lives (the guard listens on
// document, one node below it).
//
// Every press carries BOTH `code` (physical key) and `key` (produced
// character) like real events do: the guard matches on `key` (layout-aware),
// mirroring how ProseMirror keymaps resolve letter bindings.
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

describe("initKeyboardShortcuts workbench key-leak guard", () => {
    let manager: EventManager;
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
        initKeyboardShortcuts(manager);
    }

    beforeEach(() => {
        vi.clearAllMocks();
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

        const event = pressKey("KeyB", { key: "b", metaKey: true }, proseMirrorEl);

        // The event must still bubble through the editor DOM (so ProseMirror
        // handles it) but never reach the window-level forwarder.
        expect(containerListener).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
        // The guard itself never suppresses the default action; that stays
        // ProseMirror's call (no ProseMirror is mounted in this test).
        expect(event.defaultPrevented).toBe(false);
    });

    it.each([
        ["Cmd+I (italic)", "KeyI", { key: "i", metaKey: true }],
        ["Cmd+E (inline code)", "KeyE", { key: "e", metaKey: true }],
        ["Cmd+Shift+X (strikethrough)", "KeyX", { key: "X", metaKey: true, shiftKey: true }],
        ["Cmd+Z (undo)", "KeyZ", { key: "z", metaKey: true }],
        ["Cmd+Shift+Z (redo)", "KeyZ", { key: "Z", metaKey: true, shiftKey: true }],
        ["Cmd+Y (redo)", "KeyY", { key: "y", metaKey: true }],
    ] as const)("%s should not reach window listeners", (_label, code, modifiers) => {
        init(true);
        pressKey(code, modifiers, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    // Contributed keybindings only fire when the workbench sees the chord:
    // the VS Code webview host forwards keydowns to the workbench keybinding
    // service, which resolves the user's (possibly rebound) binding. The
    // guard must therefore NEVER claim any of the rebindable defaults.
    it.each([
        ["Cmd+F (find)", "KeyF", { key: "f", metaKey: true }],
        ["Cmd+Alt+F (find & replace)", "KeyF", { key: "ƒ", metaKey: true, altKey: true }],
        ["Cmd+K (insert link)", "KeyK", { key: "k", metaKey: true }],
        ["Cmd+Shift+M (switch to text editor)", "KeyM", { key: "M", metaKey: true, shiftKey: true }],
        ["Cmd+G (find next)", "KeyG", { key: "g", metaKey: true }],
        ["Cmd+Shift+G (find previous)", "KeyG", { key: "G", metaKey: true, shiftKey: true }],
        ["F3 (find next)", "F3", { key: "F3" }],
        ["Shift+F3 (find previous)", "F3", { key: "F3", shiftKey: true }],
        ["Cmd+D (find & replace selection)", "KeyD", { key: "d", metaKey: true }],
    ] as const)(
        "%s should keep propagating so the contributed keybinding resolves it",
        (_label, code, modifiers) => {
            init(true);
            const event = pressKey(code, modifiers, proseMirrorEl);
            expect(workbenchForwarder).toHaveBeenCalledTimes(1);
            expect(event.defaultPrevented).toBe(false);
        },
    );

    it("Ctrl+H on Windows/Linux should keep propagating (contributed replace binding)", () => {
        init(false);
        pressKey("KeyH", { key: "h", ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+G on Windows/Linux should keep propagating (go-to-line belongs to the workbench)", () => {
        init(false);
        pressKey("KeyG", { key: "g", ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    // ProseMirror keymaps match the PRODUCED character ("Mod-z" fires on
    // whatever physical key types "z"), so the guard must be layout-aware
    // too: claim by e.key, not e.code.
    it("QWERTZ Cmd+Shift+Z (physical KeyY producing 'z') should be claimed as redo", () => {
        init(true);
        pressKey("KeyY", { key: "z", metaKey: true, shiftKey: true }, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Dvorak Cmd+B (physical KeyN producing 'b') should be claimed as bold", () => {
        init(true);
        pressKey("KeyN", { key: "b", metaKey: true }, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Dvorak Cmd+X (physical KeyB producing 'x') should NOT be claimed", () => {
        init(true);
        // Under code-based matching this over-claimed as bold; it is cut.
        pressKey("KeyB", { key: "x", metaKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+Z on macOS should NOT be claimed (Mod is Meta-only there)", () => {
        init(true);
        // prosemirror-keymap normalizes "Mod-" to Meta on macOS, so nothing
        // handles Ctrl+Z there and the workbench must keep seeing it.
        pressKey("KeyZ", { key: "z", ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+Z on Windows/Linux should be claimed as undo", () => {
        init(false);
        pressKey("KeyZ", { key: "z", ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    // prosemirror-keymap has a second resolution path: when the produced
    // character is non-ASCII (charCodeAt(0) > 127) it also tries
    // base[event.keyCode] (w3c-keyname), so Ctrl+Z on a Russian layout
    // (key "я", keyCode 90) IS handled as undo. The guard must mirror that
    // fallback or the chord leaks and the workbench triggers a second undo.
    it("Russian Ctrl+Z (key 'я', keyCode 90) should be claimed as undo on Windows/Linux", () => {
        init(false);
        pressKey("KeyZ", { key: "я", keyCode: 90, ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Russian Cmd+Z (key 'я', keyCode 90) should be claimed as undo on macOS", () => {
        init(true);
        pressKey("KeyZ", { key: "я", keyCode: 90, metaKey: true }, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("a non-claimed Russian chord (Cmd+P, key 'з', keyCode 80) should still propagate", () => {
        init(true);
        pressKey("KeyP", { key: "з", keyCode: 80, metaKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("Cmd+P (not claimed by the editor) should still reach window listeners", () => {
        init(true);
        const event = pressKey("KeyP", { key: "p", metaKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    it("Cmd+Shift+E (claimed combo plus an extra modifier) should still reach window listeners", () => {
        init(true);
        pressKey("KeyE", { key: "E", metaKey: true, shiftKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("Cmd+Alt+B (claimed combo plus Alt) should still reach window listeners", () => {
        init(true);
        pressKey("KeyB", { key: "∫", metaKey: true, altKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("plain letter typing should still reach window listeners", () => {
        init(true);
        const event = pressKey("KeyA", { key: "a" }, proseMirrorEl);
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
