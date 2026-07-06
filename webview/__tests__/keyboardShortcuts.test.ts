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
import type { EditorView } from "@milkdown/prose/view";
import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { createEventManager, type EventManager } from "../eventManager";
import { initKeyboardShortcuts, selectionOrWordQuery } from "../keyboardShortcuts";
import type { FindBarController } from "../components/findBar";

// Minimal doc + view stub for the shortcuts that read the editor selection
const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
});

function fakeViewFor(text: string, from: number, to = from): EditorView {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
    return { state } as unknown as EditorView;
}

// Dispatch on document.body by default: real key events target the focused
// element and bubble through document up to window, which is where the
// VS Code webview host's key forwarder lives (the shortcuts and the key-leak
// guard both listen on document, one node below it).
//
// Every press carries BOTH `code` (physical key) and `key` (produced
// character) like real events do: letter shortcuts are matched on `key`
// (layout-aware), Alt combos on `code`.
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
    let findBar: {
        open: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        isOpen: ReturnType<typeof vi.fn>;
        findNext: ReturnType<typeof vi.fn>;
        findPrev: ReturnType<typeof vi.fn>;
    };
    let openLinkPrompt: ReturnType<typeof vi.fn>;

    function init(isMac: boolean, getView: () => EditorView | null = () => null): void {
        window.__i18n = { translations: {}, isMac };
        manager = createEventManager();
        initKeyboardShortcuts(
            manager,
            getView,
            () => [],
            () => 1,
            findBar as unknown as FindBarController,
            openLinkPrompt,
        );
    }

    beforeEach(() => {
        vi.clearAllMocks();
        findBar = {
            open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false),
            findNext: vi.fn(), findPrev: vi.fn(),
        };
        openLinkPrompt = vi.fn();
    });

    afterEach(() => {
        manager.dispose();
        delete window.__i18n;
    });

    it("Cmd+F (macOS) should open the find bar", () => {
        init(true);
        pressKey("KeyF", { key: "f", metaKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(findBar.open).toHaveBeenCalledWith();
    });

    it("Ctrl+F (Windows/Linux) should open the find bar", () => {
        init(false);
        pressKey("KeyF", { key: "f", ctrlKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
    });

    it("Cmd+F on Dvorak (physical KeyY produces 'f') should open the find bar", () => {
        init(true);
        pressKey("KeyY", { key: "f", metaKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
    });

    it("Cmd+Alt+F should open the find bar with the replace row shown", () => {
        init(true);
        // macOS Option remaps the produced character (Option+F types "ƒ"),
        // which is why Alt combos are matched on the physical code
        pressKey("KeyF", { key: "ƒ", metaKey: true, altKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(findBar.open).toHaveBeenCalledWith(undefined, { showReplace: true });
    });

    it("Ctrl+H on Windows/Linux should open the find bar with replace", () => {
        init(false);
        pressKey("KeyH", { key: "h", ctrlKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(findBar.open).toHaveBeenCalledWith(undefined, { showReplace: true });
    });

    it("Ctrl+H on macOS should stay unbound (it is delete-backward there)", () => {
        init(true);
        pressKey("KeyH", { key: "h", ctrlKey: true });
        expect(findBar.open).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+F should not open the find bar (reserved for global search)", () => {
        init(true);
        pressKey("KeyF", { key: "F", metaKey: true, shiftKey: true });
        expect(findBar.open).not.toHaveBeenCalled();
    });

    it("Ctrl+F on macOS should not open the find bar (Mod is Cmd-only there)", () => {
        init(true);
        pressKey("KeyF", { key: "f", ctrlKey: true });
        expect(findBar.open).not.toHaveBeenCalled();
    });

    it("Cmd+G (macOS) should find the next match", () => {
        init(true);
        pressKey("KeyG", { key: "g", metaKey: true });
        expect(findBar.findNext).toHaveBeenCalledTimes(1);
    });

    it("Cmd+Shift+G (macOS) should find the previous match", () => {
        init(true);
        pressKey("KeyG", { key: "G", metaKey: true, shiftKey: true });
        expect(findBar.findPrev).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+G (Windows/Linux) should stay unbound (it is go-to-line there)", () => {
        init(false);
        pressKey("KeyG", { key: "g", ctrlKey: true });
        expect(findBar.findNext).not.toHaveBeenCalled();
    });

    it("F3 should find the next match on all platforms", () => {
        init(false);
        pressKey("F3", { key: "F3" });
        expect(findBar.findNext).toHaveBeenCalledTimes(1);
        manager.dispose();

        init(true);
        pressKey("F3", { key: "F3" });
        expect(findBar.findNext).toHaveBeenCalledTimes(2);
    });

    it("Shift+F3 should find the previous match", () => {
        init(false);
        pressKey("F3", { key: "F3", shiftKey: true });
        expect(findBar.findPrev).toHaveBeenCalledTimes(1);
        expect(findBar.findNext).not.toHaveBeenCalled();
    });

    it("Cmd+D with no editor view should open find & replace focused on the replace input", () => {
        init(true);
        const event = pressKey("KeyD", { key: "d", metaKey: true });
        expect(findBar.open).toHaveBeenCalledWith(undefined, {
            showReplace: true,
            focusReplace: true,
        });
        expect(event.defaultPrevented).toBe(true);
    });

    it("Cmd+D with a selection should pre-fill the query from it", () => {
        // "foo bar baz": "bar" spans doc positions 5..8
        init(true, () => fakeViewFor("foo bar baz", 5, 8));
        pressKey("KeyD", { key: "d", metaKey: true });
        expect(findBar.open).toHaveBeenCalledWith("bar", {
            showReplace: true,
            focusReplace: true,
        });
    });

    it("Cmd+D with an empty selection should pre-fill the word around the caret", () => {
        init(true, () => fakeViewFor("foo bar baz", 6)); // caret inside "bar"
        pressKey("KeyD", { key: "d", metaKey: true });
        expect(findBar.open).toHaveBeenCalledWith("bar", {
            showReplace: true,
            focusReplace: true,
        });
    });

    it("Ctrl+D (Windows/Linux) should open find & replace too", () => {
        init(false);
        pressKey("KeyD", { key: "d", ctrlKey: true });
        expect(findBar.open).toHaveBeenCalledTimes(1);
    });

    it("Cmd+D in an overlay input should not open find & replace nor block typing", () => {
        init(true);
        const overlayInput = document.createElement("input");
        document.body.appendChild(overlayInput);

        const event = pressKey("KeyD", { key: "d", metaKey: true }, overlayInput);

        expect(findBar.open).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
        overlayInput.remove();
    });

    it("Cmd+Shift+M should request the switch to the text editor", () => {
        init(true);
        pressKey("KeyM", { key: "M", metaKey: true, shiftKey: true });
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "switchToTextEditor" });
    });

    it("Cmd+K (macOS) should open the insert/edit link prompt", () => {
        init(true);
        const event = pressKey("KeyK", { key: "k", metaKey: true });
        expect(openLinkPrompt).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
    });

    it("Ctrl+K (Windows/Linux) should open the insert/edit link prompt", () => {
        init(false);
        pressKey("KeyK", { key: "k", ctrlKey: true });
        expect(openLinkPrompt).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+K on macOS should not open the link prompt (Mod is Cmd-only there)", () => {
        init(true);
        pressKey("KeyK", { key: "k", ctrlKey: true });
        expect(openLinkPrompt).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+K should not open the link prompt (exact modifier match)", () => {
        init(true);
        pressKey("KeyK", { key: "K", metaKey: true, shiftKey: true });
        expect(openLinkPrompt).not.toHaveBeenCalled();
    });

    it("Cmd+K in an overlay input should not open the prompt nor block typing", () => {
        init(true);
        const overlayInput = document.createElement("input");
        document.body.appendChild(overlayInput);

        const event = pressKey("KeyK", { key: "k", metaKey: true }, overlayInput);

        expect(openLinkPrompt).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
        overlayInput.remove();
    });
});

describe("initKeyboardShortcuts workbench key-leak guard", () => {
    let manager: EventManager;
    let findBar: {
        open: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        isOpen: ReturnType<typeof vi.fn>;
        findNext: ReturnType<typeof vi.fn>;
        findPrev: ReturnType<typeof vi.fn>;
    };
    /**
     * Stand-in for the VS Code webview host's key forwarder: a bubble-phase
     * keydown listener on `window`. Keys the editor claims must never reach
     * it; everything else must.
     */
    let workbenchForwarder: ReturnType<typeof vi.fn>;
    let editorEl: HTMLElement;
    let proseMirrorEl: HTMLElement;
    let openLinkPrompt: ReturnType<typeof vi.fn>;

    function init(isMac: boolean): void {
        window.__i18n = { translations: {}, isMac };
        manager = createEventManager();
        initKeyboardShortcuts(
            manager,
            () => null,
            () => [],
            () => 1,
            findBar as unknown as FindBarController,
            openLinkPrompt,
        );
    }

    beforeEach(() => {
        vi.clearAllMocks();
        findBar = {
            open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false),
            findNext: vi.fn(), findPrev: vi.fn(),
        };
        openLinkPrompt = vi.fn();
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

    // ProseMirror keymaps match the PRODUCED character ("Mod-z" fires on
    // whatever physical key types "z"), so the guard must be layout-aware
    // too: claim by e.key, not e.code (except Alt combos).
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

    it("Russian Cmd+F (key 'а', keyCode 70) should open the find bar and not leak", () => {
        init(true);
        pressKey("KeyF", { key: "а", keyCode: 70, metaKey: true }, proseMirrorEl);
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("a non-claimed Russian chord (Cmd+P, key 'з', keyCode 80) should still propagate", () => {
        init(true);
        pressKey("KeyP", { key: "з", keyCode: 80, metaKey: true }, proseMirrorEl);
        expect(findBar.open).not.toHaveBeenCalled();
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("Cmd+F should open the find bar and not leak to the workbench", () => {
        init(true);
        pressKey("KeyF", { key: "f", metaKey: true }, proseMirrorEl);
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Cmd+K inside the editor content should open the link prompt and not leak", () => {
        init(true);
        pressKey("KeyK", { key: "k", metaKey: true }, proseMirrorEl);
        expect(openLinkPrompt).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Cmd+K in an overlay input should still be claimed but not open the prompt", () => {
        init(true);
        const overlayInput = document.createElement("input");
        document.body.appendChild(overlayInput);

        // Claimed document-wide (the chord must never start a workbench
        // Cmd+K key sequence), but the handler bails in overlay inputs.
        pressKey("KeyK", { key: "k", metaKey: true }, overlayInput);

        expect(openLinkPrompt).not.toHaveBeenCalled();
        expect(workbenchForwarder).not.toHaveBeenCalled();
        overlayInput.remove();
    });

    it("Cmd+Shift+M should still post the switch message while being swallowed", () => {
        init(true);
        pressKey("KeyM", { key: "M", metaKey: true, shiftKey: true }, proseMirrorEl);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "switchToTextEditor" });
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Ctrl+H should be claimed on Windows/Linux but not on macOS", () => {
        init(false);
        pressKey("KeyH", { key: "h", ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).not.toHaveBeenCalled();
        manager.dispose();

        init(true);
        pressKey("KeyH", { key: "h", ctrlKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("Cmd+G / Cmd+Shift+G on macOS should be claimed as find next/previous", () => {
        init(true);
        pressKey("KeyG", { key: "g", metaKey: true }, proseMirrorEl);
        pressKey("KeyG", { key: "G", metaKey: true, shiftKey: true }, proseMirrorEl);
        expect(findBar.findNext).toHaveBeenCalledTimes(1);
        expect(findBar.findPrev).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Ctrl+G on Windows/Linux should NOT be claimed (go-to-line belongs to the workbench)", () => {
        init(false);
        pressKey("KeyG", { key: "g", ctrlKey: true }, proseMirrorEl);
        expect(findBar.findNext).not.toHaveBeenCalled();
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
    });

    it("F3 and Shift+F3 should be claimed as find next/previous", () => {
        init(false);
        pressKey("F3", { key: "F3" }, proseMirrorEl);
        pressKey("F3", { key: "F3", shiftKey: true }, proseMirrorEl);
        expect(findBar.findNext).toHaveBeenCalledTimes(1);
        expect(findBar.findPrev).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Cmd+D inside the editor content should be claimed and open find & replace", () => {
        init(true);
        pressKey("KeyD", { key: "d", metaKey: true }, proseMirrorEl);
        expect(findBar.open).toHaveBeenCalledTimes(1);
        expect(workbenchForwarder).not.toHaveBeenCalled();
    });

    it("Cmd+D in an overlay input should still be claimed but not open find & replace", () => {
        init(true);
        const overlayInput = document.createElement("input");
        document.body.appendChild(overlayInput);

        pressKey("KeyD", { key: "d", metaKey: true }, overlayInput);

        expect(findBar.open).not.toHaveBeenCalled();
        expect(workbenchForwarder).not.toHaveBeenCalled();
        overlayInput.remove();
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

    it("plain letter typing should still reach window listeners", () => {
        init(true);
        const event = pressKey("KeyA", { key: "a" }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    it("Alt+K (no longer bound) should keep propagating to window listeners", () => {
        init(true);
        // macOS Option+K produces "˚" — the editor claims nothing on Alt+K
        // anymore, so the workbench must keep seeing the chord.
        const event = pressKey("KeyK", { key: "˚", altKey: true }, proseMirrorEl);
        expect(workbenchForwarder).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
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

describe("selectionOrWordQuery", () => {
    it("a non-empty selection should return the selected text", () => {
        // "foo bar baz": "bar" spans doc positions 5..8
        expect(selectionOrWordQuery(fakeViewFor("foo bar baz", 5, 8))).toBe("bar");
    });

    it("a whitespace-only selection should return undefined", () => {
        expect(selectionOrWordQuery(fakeViewFor("foo bar baz", 4, 5))).toBe(undefined);
    });

    it("an empty selection inside a word should return the surrounding word", () => {
        expect(selectionOrWordQuery(fakeViewFor("foo bar baz", 6))).toBe("bar");
    });

    it("an empty selection at a word boundary should still pick up the adjacent word", () => {
        // caret right after "foo" (position 4)
        expect(selectionOrWordQuery(fakeViewFor("foo bar baz", 4))).toBe("foo");
    });

    it("an empty selection surrounded by whitespace should return undefined", () => {
        // "foo  bar": caret between the two spaces (position 5)
        expect(selectionOrWordQuery(fakeViewFor("foo  bar", 5))).toBe(undefined);
    });

    it("word expansion should treat unicode letters as word characters", () => {
        // "der Käse hier": caret inside "Käse" (position 7)
        expect(selectionOrWordQuery(fakeViewFor("der Käse hier", 7))).toBe("Käse");
    });
});
