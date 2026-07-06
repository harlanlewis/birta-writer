/**
 * eventManager.ts tests: onShortcut modifier matching.
 *
 * Regression coverage for the bug where `{ meta: true, ctrl: true }` was
 * interpreted as "both Meta AND Ctrl held", which made Cmd+F dead on macOS
 * and Ctrl+F dead on Windows/Linux.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventManager, type EventManager } from "../eventManager";

// Dispatch on document.body: real key events target the focused element and
// bubble through document up to window (onShortcut listens on document, below
// the window-level listener the VS Code webview host uses to forward keys to
// the workbench).
function pressKey(code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
        code,
        bubbles: true,
        cancelable: true,
        ...modifiers,
    });
    document.body.dispatchEvent(event);
    return event;
}

describe("EventManager.onShortcut", () => {
    let manager: EventManager;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = createEventManager();
        handler = vi.fn();
    });

    afterEach(() => {
        manager.dispose();
    });

    describe("Mod shortcuts (meta: true, ctrl: true)", () => {
        beforeEach(() => {
            manager.onShortcut({ code: "KeyF", meta: true, ctrl: true }, handler);
        });

        it("Cmd+F (metaKey only, macOS) should trigger the handler", () => {
            pressKey("KeyF", { metaKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("Ctrl+F (ctrlKey only, Windows/Linux) should trigger the handler", () => {
            pressKey("KeyF", { ctrlKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("plain F without modifiers should not trigger the handler", () => {
            pressKey("KeyF");
            expect(handler).not.toHaveBeenCalled();
        });

        it("Cmd+Shift+F should not trigger a shortcut that did not request Shift", () => {
            pressKey("KeyF", { metaKey: true, shiftKey: true });
            expect(handler).not.toHaveBeenCalled();
        });

        it("Cmd+Alt+F should not trigger a shortcut that did not request Alt", () => {
            pressKey("KeyF", { metaKey: true, altKey: true });
            expect(handler).not.toHaveBeenCalled();
        });

        it("a different key code should not trigger the handler", () => {
            pressKey("KeyG", { metaKey: true });
            expect(handler).not.toHaveBeenCalled();
        });

        it("matching shortcut should prevent the default action", () => {
            const event = pressKey("KeyF", { metaKey: true });
            expect(event.defaultPrevented).toBe(true);
        });

        it("non-matching shortcut should not prevent the default action", () => {
            const event = pressKey("KeyF", { metaKey: true, shiftKey: true });
            expect(event.defaultPrevented).toBe(false);
        });
    });

    describe("Mod+Shift shortcuts", () => {
        it("Cmd+Shift+M should trigger a { meta, ctrl, shift } shortcut", () => {
            manager.onShortcut({ code: "KeyM", meta: true, ctrl: true, shift: true }, handler);
            pressKey("KeyM", { metaKey: true, shiftKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("Cmd+M without Shift should not trigger a { meta, ctrl, shift } shortcut", () => {
            manager.onShortcut({ code: "KeyM", meta: true, ctrl: true, shift: true }, handler);
            pressKey("KeyM", { metaKey: true });
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe("single-modifier shortcuts", () => {
        it("Alt+K should trigger an { alt } shortcut", () => {
            manager.onShortcut({ code: "KeyK", alt: true }, handler);
            pressKey("KeyK", { altKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("Cmd+Alt+K should not trigger an { alt } shortcut", () => {
            manager.onShortcut({ code: "KeyK", alt: true }, handler);
            pressKey("KeyK", { altKey: true, metaKey: true });
            expect(handler).not.toHaveBeenCalled();
        });

        it("Ctrl+H should trigger a { ctrl } shortcut but Cmd+H should not", () => {
            manager.onShortcut({ code: "KeyH", ctrl: true }, handler);
            pressKey("KeyH", { ctrlKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
            pressKey("KeyH", { metaKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });
    });

    describe("produced-character (key) matching with non-Latin layouts", () => {
        // prosemirror-keymap resolves letter bindings via base[event.keyCode]
        // when the produced character is non-ASCII; the `key` matcher must
        // apply the same fallback so e.g. Cmd+F works on a Russian layout.
        it("Russian Cmd+F (key 'а', keyCode 70) should trigger a { key: 'f' } shortcut", () => {
            manager.onShortcut({ key: "f", meta: true }, handler);
            pressKey("KeyF", { key: "а", keyCode: 70, metaKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("Russian Cmd+P (key 'з', keyCode 80) should not trigger a { key: 'f' } shortcut", () => {
            manager.onShortcut({ key: "f", meta: true }, handler);
            pressKey("KeyP", { key: "з", keyCode: 80, metaKey: true });
            expect(handler).not.toHaveBeenCalled();
        });

        it("an ASCII produced character should not fall back to the keyCode", () => {
            // Dvorak-style remap: physical KeyB produces "x"; a { key: "b" }
            // shortcut must NOT fire (prosemirror-keymap only falls back for
            // non-ASCII characters, and "x" names the binding directly).
            manager.onShortcut({ key: "b", meta: true }, handler);
            pressKey("KeyB", { key: "x", keyCode: 66, metaKey: true });
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe("distinct shortcuts on the same key", () => {
        it("Mod+F and Mod+Alt+F should dispatch to their own handlers", () => {
            const altHandler = vi.fn();
            manager.onShortcut({ code: "KeyF", meta: true, ctrl: true }, handler);
            manager.onShortcut({ code: "KeyF", meta: true, ctrl: true, alt: true }, altHandler);

            pressKey("KeyF", { metaKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(altHandler).not.toHaveBeenCalled();

            pressKey("KeyF", { metaKey: true, altKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(altHandler).toHaveBeenCalledTimes(1);
        });
    });

    describe("propagation to window (VS Code webview key forwarding)", () => {
        it("stopPropagation: true should keep a matching event from reaching window listeners", () => {
            const windowListener = vi.fn();
            window.addEventListener("keydown", windowListener);
            try {
                manager.onShortcut(
                    { code: "KeyF", meta: true, ctrl: true, stopPropagation: true },
                    handler,
                );
                pressKey("KeyF", { metaKey: true });
                expect(handler).toHaveBeenCalledTimes(1);
                expect(windowListener).not.toHaveBeenCalled();
            } finally {
                window.removeEventListener("keydown", windowListener);
            }
        });

        it("a non-matching event should still reach window listeners", () => {
            const windowListener = vi.fn();
            window.addEventListener("keydown", windowListener);
            try {
                manager.onShortcut(
                    { code: "KeyF", meta: true, ctrl: true, stopPropagation: true },
                    handler,
                );
                pressKey("KeyP", { metaKey: true });
                expect(handler).not.toHaveBeenCalled();
                expect(windowListener).toHaveBeenCalledTimes(1);
            } finally {
                window.removeEventListener("keydown", windowListener);
            }
        });
    });

    describe("unbinding", () => {
        it("the returned unbind function should remove the shortcut", () => {
            const unbind = manager.onShortcut({ code: "KeyF", meta: true, ctrl: true }, handler);
            unbind();
            pressKey("KeyF", { metaKey: true });
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
