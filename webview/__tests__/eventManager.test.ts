/**
 * eventManager.ts tests: DOM/custom event binding, unbinding, disposal, and
 * the prosemirror-keymap keyCode fallback used by the key-leak guard.
 *
 * The onShortcut helper was removed on purpose — editor shortcuts are
 * contributed (user-rebindable) VS Code keybindings now, and
 * shared/__tests__/noHardcodedKeybindings.test.ts guards against hardcoded
 * chord matching creeping back in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    createEventManager,
    fallbackKeyFromKeyCode,
    type EventManager,
} from "../eventManager";

describe("EventManager DOM bindings", () => {
    let manager: EventManager;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = createEventManager();
    });

    afterEach(() => {
        manager.dispose();
    });

    it("onDocument should receive bubbled events and unbind cleanly", () => {
        const handler = vi.fn();
        const unbind = manager.onDocument("keydown", handler);

        document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "a", bubbles: true }),
        );
        expect(handler).toHaveBeenCalledTimes(1);

        unbind();
        document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "a", bubbles: true }),
        );
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("onElement should bind to the given element only", () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const handler = vi.fn();
        manager.onElement(el, "click", handler);

        el.dispatchEvent(new MouseEvent("click"));
        document.body.dispatchEvent(new MouseEvent("click"));

        expect(handler).toHaveBeenCalledTimes(1);
        el.remove();
    });

    it("dispose should unbind every listener and reject further binds", () => {
        const handler = vi.fn();
        manager.onDocument("keydown", handler);
        manager.onWindow("resize", handler);
        expect(manager.stats.domEvents).toBe(2);

        manager.dispose();

        document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "a", bubbles: true }),
        );
        expect(handler).not.toHaveBeenCalled();
        expect(manager.stats.domEvents).toBe(0);
        expect(() => manager.onDocument("keydown", handler)).toThrow();
    });
});

describe("EventManager custom events", () => {
    let manager: EventManager;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = createEventManager();
    });

    afterEach(() => {
        manager.dispose();
    });

    it("emit should invoke every handler registered for the type with the detail", () => {
        const a = vi.fn();
        const b = vi.fn();
        manager.onCustom("thing", a);
        manager.onCustom("thing", b);

        manager.emit("thing", { value: 7 });

        expect(a).toHaveBeenCalledWith({ value: 7 });
        expect(b).toHaveBeenCalledWith({ value: 7 });
    });

    it("an unbound handler should no longer receive emits", () => {
        const handler = vi.fn();
        const unbind = manager.onCustom("thing", handler);
        unbind();

        manager.emit("thing");

        expect(handler).not.toHaveBeenCalled();
    });

    it("a throwing handler should not keep other handlers from running", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const ok = vi.fn();
        manager.onCustom("thing", () => {
            throw new Error("boom");
        });
        manager.onCustom("thing", ok);

        manager.emit("thing");

        expect(ok).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});

describe("fallbackKeyFromKeyCode", () => {
    // Mirrors prosemirror-keymap's second resolution path: when the produced
    // character cannot name a "Mod-z"-style letter binding, the binding is
    // resolved via base[event.keyCode] (w3c-keyname). The key-leak guard in
    // keyboardShortcuts.ts relies on the exact same fallback.
    const event = (init: Partial<KeyboardEvent>) =>
        new KeyboardEvent("keydown", init);

    it("a non-ASCII produced character should fall back to the keyCode letter", () => {
        // Russian layout Ctrl+Z: key "я", physical Z (keyCode 90)
        expect(fallbackKeyFromKeyCode(event({ key: "я", keyCode: 90 }))).toBe("z");
    });

    it("a named key should fall back to the keyCode letter when it is one", () => {
        expect(fallbackKeyFromKeyCode(event({ key: "Dead", keyCode: 78 }))).toBe("n");
    });

    it("an ASCII produced character should not fall back", () => {
        // Dvorak Cmd+X: physical KeyB (keyCode 66) produces "x" — must stay "x"
        expect(fallbackKeyFromKeyCode(event({ key: "x", keyCode: 66 }))).toBe(null);
    });

    it("a keyCode outside A-Z should yield no fallback", () => {
        expect(fallbackKeyFromKeyCode(event({ key: "F3", keyCode: 114 }))).toBe(null);
    });
});
