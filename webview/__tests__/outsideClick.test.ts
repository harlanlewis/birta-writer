import { describe, it, expect, vi, beforeEach } from "vitest";
import { onOutsideClick } from "../ui/outsideClick";

function mousedownOn(target: Node): void {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

describe("onOutsideClick", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("a mousedown outside every inside element should dismiss", () => {
        const menu = document.createElement("div");
        const outside = document.createElement("div");
        document.body.append(menu, outside);
        const dismiss = vi.fn();
        const off = onOutsideClick([menu], dismiss);

        mousedownOn(outside);

        expect(dismiss).toHaveBeenCalledTimes(1);
        off();
    });

    it("a mousedown inside any inside element (self or descendant) should not dismiss", () => {
        const menu = document.createElement("div");
        const child = document.createElement("span");
        menu.appendChild(child);
        const anchor = document.createElement("button");
        document.body.append(menu, anchor);
        const dismiss = vi.fn();
        const off = onOutsideClick([menu, anchor], dismiss);

        mousedownOn(menu);
        mousedownOn(child);
        mousedownOn(anchor);

        expect(dismiss).not.toHaveBeenCalled();
        off();
    });

    it("null/undefined inside entries should be skipped, not dismiss-everything", () => {
        const input = document.createElement("input");
        document.body.append(input);
        const dismiss = vi.fn();
        const off = onOutsideClick([null, input, undefined], dismiss);

        mousedownOn(input);
        expect(dismiss).not.toHaveBeenCalled();

        mousedownOn(document.body);
        expect(dismiss).toHaveBeenCalledTimes(1);
        off();
    });

    it("an inside getter should be re-resolved per event (recreated dropdowns)", () => {
        let dropdown: HTMLElement | null = null;
        const outside = document.createElement("div");
        document.body.append(outside);
        const dismiss = vi.fn();
        const off = onOutsideClick(() => [dropdown], dismiss);

        // Dropdown created after attach: clicks inside it must not dismiss.
        dropdown = document.createElement("ul");
        document.body.append(dropdown);
        mousedownOn(dropdown);
        expect(dismiss).not.toHaveBeenCalled();

        mousedownOn(outside);
        expect(dismiss).toHaveBeenCalledTimes(1);
        off();
    });

    it("the capture-phase default should see a mousedown whose propagation is stopped", () => {
        const menu = document.createElement("div");
        const swallower = document.createElement("div");
        swallower.addEventListener("mousedown", (e) => e.stopPropagation());
        document.body.append(menu, swallower);
        const dismiss = vi.fn();
        const off = onOutsideClick([menu], dismiss);

        mousedownOn(swallower);

        expect(dismiss).toHaveBeenCalledTimes(1);
        off();
    });

    it("capture: false should listen in the bubble phase and miss stopped propagation", () => {
        const menu = document.createElement("div");
        const swallower = document.createElement("div");
        swallower.addEventListener("mousedown", (e) => e.stopPropagation());
        document.body.append(menu, swallower);
        const dismiss = vi.fn();
        const off = onOutsideClick([menu], dismiss, { capture: false });

        mousedownOn(swallower);
        expect(dismiss).not.toHaveBeenCalled();

        mousedownOn(document.body);
        expect(dismiss).toHaveBeenCalledTimes(1);
        off();
    });

    it("the returned detach should remove the listener and be safe to call twice", () => {
        const menu = document.createElement("div");
        document.body.append(menu);
        const dismiss = vi.fn();
        const off = onOutsideClick([menu], dismiss);

        off();
        off();
        mousedownOn(document.body);

        expect(dismiss).not.toHaveBeenCalled();
    });
});
