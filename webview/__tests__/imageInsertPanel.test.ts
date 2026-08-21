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
const tabs = () => [...document.querySelectorAll<HTMLButtonElement>(".img-insert-tab")];
const projectTab = () => tabs().find((b) => b.textContent === "Browse Project") ?? null;
const ACTIVE = "img-insert-tab--active";

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

    it("Escape and Enter in the URL field should reach the dialog past the path completer", () => {
        // The completer's capture listener stops propagation on both keys, so
        // the dialog hands it callbacks rather than listening behind it.
        const onConfirm = vi.fn();
        showImageInsertPanel(onConfirm);
        const src = () => document.querySelector(".img-insert-panel input[placeholder^='Image URL']") as HTMLInputElement;
        src().value = "https://example.com/a.png";
        key(src(), { key: "Enter" });
        expect(onConfirm).toHaveBeenCalledWith("", "https://example.com/a.png");
        expect(panel()).toBeNull();

        showImageInsertPanel(vi.fn());
        key(src(), { key: "Escape", shiftKey: true });
        expect(panel()).not.toBeNull();
        key(src(), { key: "Escape" });
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

/**
 * A host with no project to enumerate (MAR-401). The panel is handed no
 * loader, which is the state `webview/index.ts` leaves it in when the host
 * declines `projectImages`, and a tab it cannot fill must not be the one it
 * opens on.
 *
 * The second case is what stops the first from passing on a panel that had
 * simply stopped asking anybody.
 */
describe("image insert panel project tab against the host", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        while (closeTopmostLayer()) { /* drain */ }
        document.body.innerHTML = "";
    });
    afterEach(() => {
        while (closeTopmostLayer()) { /* drain */ }
        document.body.innerHTML = "";
    });

    it("no project-image loader should hide the Project tab and leave it unselected", async () => {
        showImageInsertPanel(vi.fn());
        await flush();

        const project = projectTab();
        expect(project, "the tab is still built, only hidden").not.toBeNull();
        expect(project!.style.display).toBe("none");
        expect(project!.classList.contains(ACTIVE)).toBe(false);
    });

    it("a project-image loader should show the Project tab, select it, and ask it for images", async () => {
        const load = vi.fn().mockResolvedValue([]);

        showImageInsertPanel(vi.fn(), undefined, load);
        await flush();

        const project = projectTab();
        expect(project!.style.display).not.toBe("none");
        expect(project!.classList.contains(ACTIVE)).toBe(true);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("no project-image loader should mean the panel asks nothing and waits on nothing", async () => {
        const load = vi.fn().mockResolvedValue([]);

        showImageInsertPanel(vi.fn(), undefined, undefined);
        await flush();

        expect(load).not.toHaveBeenCalled();
    });

    it("every tab should compose the button primitive its skin needs", () => {
        showImageInsertPanel(vi.fn(), vi.fn(), vi.fn().mockResolvedValue([]));

        const all = tabs();
        expect(all.length).toBeGreaterThan(0);
        for (const tab of all) {
            expect(tab.classList.contains("ui-btn"), tab.textContent ?? "").toBe(true);
        }
    });
});
