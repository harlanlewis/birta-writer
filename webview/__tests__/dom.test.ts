/**
 * createButton tests: mouse and keyboard activation of the onClick handler.
 * The factory wires actions on mousedown (so the editor never loses focus
 * on a toolbar click) plus keyboard clicks (detail 0), which mousedown
 * never covers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createButton } from "../ui/dom";

describe("createButton onClick", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("mousedown should run the handler and claim the event", () => {
        const onClick = vi.fn();
        const btn = createButton({ className: "x", label: "b", onClick });
        document.body.appendChild(btn);
        const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        btn.dispatchEvent(e);
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(e.defaultPrevented).toBe(true);
    });

    it("a keyboard click (detail 0) should run the handler", () => {
        const onClick = vi.fn();
        const btn = createButton({ className: "x", label: "b", onClick });
        document.body.appendChild(btn);
        btn.dispatchEvent(new MouseEvent("click", { detail: 0, bubbles: true, cancelable: true }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("a mouse click sequence should run the handler exactly once", () => {
        const onClick = vi.fn();
        const btn = createButton({ className: "x", label: "b", onClick });
        document.body.appendChild(btn);
        // real mouse interaction: mousedown fires the action, the trailing
        // click arrives with detail 1 and must not re-fire it
        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("a button without onClick should ignore clicks entirely", () => {
        const btn = createButton({ className: "x", label: "b" });
        document.body.appendChild(btn);
        const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        btn.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(false);
    });
});
