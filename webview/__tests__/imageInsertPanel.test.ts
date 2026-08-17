/**
 * The Insert Image dialog on the Escape-layer stack (MAR-117): the panel and
 * its enlarge lightbox are transient surfaces, so an Escape from anywhere in
 * the panel (a tab button, the grid, an input) closes the topmost of them,
 * modifier-Escape is left alone, and every close path unregisters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeTopmostLayer } from "../ui/escapeLayers";
import { showImageInsertPanel } from "../components/toolbar/imageInsertPanel";

const key = (target: Element, init: KeyboardEventInit): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
};
const panel = () => document.querySelector(".img-insert-panel");
const lightbox = () => document.querySelector(".img-lightbox");
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("image insert panel escape layers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        while (closeTopmostLayer()) { /* drain */ }
        document.body.innerHTML = "";
    });
    afterEach(() => {
        while (closeTopmostLayer()) { /* drain */ }
        document.body.innerHTML = "";
    });

    it("an open panel should be the topmost layer, and closing it should unregister", () => {
        showImageInsertPanel(vi.fn());
        expect(panel()).not.toBeNull();
        expect(closeTopmostLayer()).toBe(true);
        expect(panel()).toBeNull();
        expect(closeTopmostLayer()).toBe(false);
    });

    it("a bare Escape on a panel button should close the panel; a modifier Escape should not", () => {
        showImageInsertPanel(vi.fn());
        const cancel = document.querySelector(".img-insert-panel button:last-of-type") as HTMLButtonElement;
        expect(cancel).not.toBeNull();
        key(cancel, { key: "Escape", shiftKey: true });
        expect(panel()).not.toBeNull();
        const e = key(cancel, { key: "Escape" });
        expect(e.defaultPrevented).toBe(true);
        expect(panel()).toBeNull();
        expect(closeTopmostLayer()).toBe(false);
    });

    it("the enlarge lightbox should take the first Escape and the panel the next", async () => {
        showImageInsertPanel(vi.fn(), undefined, () =>
            Promise.resolve([{ relPath: "a.png", webviewUri: "vscode-resource://a.png", name: "a.png" }]));
        await flush();
        const enlarge = document.querySelector(".img-insert-thumb-enlarge") as HTMLButtonElement;
        expect(enlarge).not.toBeNull();
        enlarge.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(lightbox()).not.toBeNull();

        // Focus is still in the panel: the key arrives on the panel, and the
        // stack routes it to the lightbox above.
        key(document.querySelector(".img-insert-tab")!, { key: "Escape" });
        expect(lightbox()).toBeNull();
        expect(panel()).not.toBeNull();
        key(document.querySelector(".img-insert-tab")!, { key: "Escape" });
        expect(panel()).toBeNull();
        expect(closeTopmostLayer()).toBe(false);
    });

    it("closing the lightbox by its button should unregister it, so the next Escape closes the panel", async () => {
        showImageInsertPanel(vi.fn(), undefined, () =>
            Promise.resolve([{ relPath: "a.png", webviewUri: "vscode-resource://a.png", name: "a.png" }]));
        await flush();
        (document.querySelector(".img-insert-thumb-enlarge") as HTMLButtonElement)
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        (document.querySelector(".img-lightbox-close") as HTMLButtonElement)
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(lightbox()).toBeNull();
        expect(closeTopmostLayer()).toBe(true); // the panel, not a dead lightbox entry
        expect(panel()).toBeNull();
    });
});
