/**
 * Regression test for the proofread findings-popup Escape handler: its
 * document-capture keydown listener used to fire on ANY Escape while the
 * popup was open, with no modifier check — so Shift+Esc (which should pop a
 * layer via the escape-layer stack) was swallowed to just hide the popup.
 * The desired-outcome principle: no surface acts on modifier-Escape. Only a
 * bare Escape may close the popup; modifier-Escape must fall through.
 *
 * Drives the REAL renderer (showFindingsPopup) against a minimal fake
 * EditorView — the popup imports neither the engine nor ProseMirror at
 * runtime, only `coordsAtPos`/`focus` off the view.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { EditorView } from "@milkdown/prose/view";
import { showFindingsPopup, hideLintPopup } from "../proofread/popup";
import { closeTopmostLayer } from "../ui/escapeLayers";

/** Minimal EditorView stub: only the members the popup touches. */
function fakeView(): EditorView {
    return {
        coordsAtPos: () => ({ left: 100, right: 110, top: 100, bottom: 116 }),
        focus: () => {},
    } as unknown as EditorView;
}

function escape(mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    return new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        ...mods,
    });
}

const popupOpen = (): boolean => document.querySelector(".pf-popup") !== null;

afterEach(() => {
    hideLintPopup();
    while (closeTopmostLayer()) { /* drain the module-level layer stack */ }
    document.body.innerHTML = "";
});

describe("proofread findings popup — Escape modifier guard", () => {
    it("a bare Escape should close the popup and consume the key", () => {
        showFindingsPopup(fakeView(), 0, [
            { tag: "Filler", message: "This word is filler.", buttons: [] },
        ]);
        expect(popupOpen()).toBe(true);

        const e = escape();
        document.dispatchEvent(e);

        expect(popupOpen()).toBe(false);
        expect(e.defaultPrevented).toBe(true);
    });

    it("a Shift+Escape should NOT close or consume — it falls through to the layer stack", () => {
        showFindingsPopup(fakeView(), 0, [
            { tag: "Filler", message: "This word is filler.", buttons: [] },
        ]);
        expect(popupOpen()).toBe(true);

        const e = escape({ shiftKey: true });
        document.dispatchEvent(e);

        expect(popupOpen()).toBe(true);
        expect(e.defaultPrevented).toBe(false);
    });

    it("a Ctrl/Alt/Meta+Escape should NOT close or consume the popup", () => {
        for (const mod of ["ctrlKey", "altKey", "metaKey"] as const) {
            hideLintPopup();
            showFindingsPopup(fakeView(), 0, [
                { tag: "Filler", message: "This word is filler.", buttons: [] },
            ]);
            expect(popupOpen()).toBe(true);

            const e = escape({ [mod]: true });
            document.dispatchEvent(e);

            expect(popupOpen(), `${mod}+Escape kept the popup open`).toBe(true);
            expect(e.defaultPrevented, `${mod}+Escape not consumed`).toBe(false);
        }
    });
});
