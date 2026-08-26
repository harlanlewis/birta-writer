/**
 * Whether a dropdown trigger names itself, which is the surface's question
 * rather than the component's.
 *
 * Where the menu opens on hover, resting on the trigger already answers what
 * the button is, and a tooltip would open in the same spot a moment before the
 * menu and be covered by it. Under `barMenusOnClick` (Birta Writer for Mac,
 * where a window's menus open on a press) hovering promises nothing, so a
 * trigger with no tooltip is a glyph with no way to learn it short of pressing
 * it and finding out. Both arms are here, because a rule that only ever
 * applies is not a rule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMenuTrigger } from "../components/toolbar/menuPrimitives";
import { hideTooltip } from "../ui/tooltip";

type Declared = { __i18n?: { host?: { arrangements?: string[] } } };
const g = globalThis as Declared;

const tip = () => document.querySelector(".custom-tooltip") as HTMLElement | null;
const tipVisible = () => tip() !== null && tip()!.style.display !== "none";

/** Build a trigger, put it in the document, and rest on it. */
function hover(el: HTMLElement): void {
    document.body.appendChild(el);
    el.dispatchEvent(new MouseEvent("mouseenter"));
}

describe("createMenuTrigger", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hideTooltip();
    });
    afterEach(() => {
        delete g.__i18n;
        hideTooltip();
        document.body.innerHTML = "";
    });

    it("a surface whose menus open on a press should give the trigger its name as a tooltip", () => {
        g.__i18n = { host: { arrangements: ["barMenusOnClick"] } };
        hover(createMenuTrigger({ text: "S", ariaLabel: "Settings" }));
        expect(tipVisible()).toBe(true);
        expect(tip()!.textContent).toBe("Settings");
    });

    it("a surface whose menus open on hover should give the trigger none", () => {
        // No arrangement declared is the VS Code profile, where the menu itself
        // is what appears under the pointer.
        hover(createMenuTrigger({ text: "S", ariaLabel: "Settings" }));
        expect(tipVisible()).toBe(false);
    });

    it("a trigger with no accessible name should get no tooltip on either surface", () => {
        // The tooltip IS the accessible name, drawn. There is nothing to draw
        // when there is no name, and an empty chip under the pointer is worse
        // than none.
        g.__i18n = { host: { arrangements: ["barMenusOnClick"] } };
        hover(createMenuTrigger({ text: "S" }));
        expect(tipVisible()).toBe(false);
    });

    it("a trigger whose menu is open should show no tooltip", () => {
        // The overlap the old no-tooltip rule existed to avoid, now handled by
        // the anchor's own state rather than by withholding the tooltip.
        // `wireHoverMenu` writes both attributes; this asserts the trigger
        // honours them, which is what makes the tooltip safe to add at all.
        g.__i18n = { host: { arrangements: ["barMenusOnClick"] } };
        const el = createMenuTrigger({ text: "S", ariaLabel: "Settings" });
        el.setAttribute("aria-haspopup", "menu");
        el.setAttribute("aria-expanded", "true");
        hover(el);
        expect(tipVisible()).toBe(false);
    });
});
