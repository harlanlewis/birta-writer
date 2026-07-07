/**
 * createButton tests: mouse and keyboard activation of the onClick handler.
 * The factory wires actions on mousedown (so the editor never loses focus
 * on a toolbar click) plus keyboard clicks (detail 0), which mousedown
 * never covers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createButton, setupInputKeyboard, onOutsideMousedown } from "../ui/dom";

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

describe("createButton accessible name", () => {
    it("an icon-only button should take its aria-label from the title", () => {
        const btn = createButton({ className: "x", icon: "<svg></svg>", title: "Open Find" });
        expect(btn.getAttribute("aria-label")).toBe("Open Find");
    });

    it("a trailing shortcut hint in the title should be stripped from the aria-label", () => {
        const btn = createButton({ className: "x", icon: "<svg></svg>", title: "Previous Match (⇧Enter)" });
        expect(btn.getAttribute("aria-label")).toBe("Previous Match");
    });

    it("an explicit ariaLabel should win over the derived one", () => {
        const btn = createButton({
            className: "x", icon: "<svg></svg>", title: "Replace (Enter)", ariaLabel: "Replace one match",
        });
        expect(btn.getAttribute("aria-label")).toBe("Replace one match");
    });

    it("a button with visible label text should not get an aria-label", () => {
        const btn = createButton({ className: "x", label: "Aa", title: "Match Case" });
        expect(btn.getAttribute("aria-label")).toBeNull();
    });

    it("parentheses inside the title should survive the shortcut stripping", () => {
        const btn = createButton({ className: "x", icon: "<svg></svg>", title: "Insert (fancy) table (⌘T)" });
        expect(btn.getAttribute("aria-label")).toBe("Insert (fancy) table");
    });
});

describe("setupInputKeyboard", () => {
    const press = (input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) => {
        const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
        input.dispatchEvent(e);
        return e;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("Enter should call onEnter and claim the event", () => {
        const input = document.createElement("input");
        const onEnter = vi.fn();
        const onEscape = vi.fn();
        setupInputKeyboard(input, onEnter, onEscape);
        const e = press(input, "Enter");
        expect(onEnter).toHaveBeenCalledTimes(1);
        expect(onEscape).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(true);
    });

    it("Escape should call onEscape", () => {
        const input = document.createElement("input");
        const onEnter = vi.fn();
        const onEscape = vi.fn();
        setupInputKeyboard(input, onEnter, onEscape);
        press(input, "Escape");
        expect(onEscape).toHaveBeenCalledTimes(1);
        expect(onEnter).not.toHaveBeenCalled();
    });

    it("Enter during IME composition should be ignored", () => {
        const input = document.createElement("input");
        const onEnter = vi.fn();
        setupInputKeyboard(input, onEnter, vi.fn());
        press(input, "Enter", { isComposing: true });
        expect(onEnter).not.toHaveBeenCalled();
    });

    it("other keys should not trigger either callback", () => {
        const input = document.createElement("input");
        const onEnter = vi.fn();
        const onEscape = vi.fn();
        setupInputKeyboard(input, onEnter, onEscape);
        const e = press(input, "a");
        expect(onEnter).not.toHaveBeenCalled();
        expect(onEscape).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(false);
    });
});

describe("onOutsideMousedown", () => {
    const mousedownOn = (el: Node) =>
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("a mousedown outside the targets should close once and detach", () => {
        const popup = document.createElement("div");
        const outside = document.createElement("div");
        document.body.append(popup, outside);
        const onClose = vi.fn();
        onOutsideMousedown([popup], onClose);
        mousedownOn(outside);
        mousedownOn(outside);
        expect(onClose).toHaveBeenCalledTimes(1); // listener removed after firing
    });

    it("a mousedown inside a target should not close", () => {
        const popup = document.createElement("div");
        const inner = document.createElement("button");
        popup.appendChild(inner);
        document.body.appendChild(popup);
        const onClose = vi.fn();
        onOutsideMousedown([popup], onClose);
        mousedownOn(inner);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("with delayMs the listener should not be active until the delay elapses", () => {
        vi.useFakeTimers();
        const popup = document.createElement("div");
        const outside = document.createElement("div");
        document.body.append(popup, outside);
        const onClose = vi.fn();
        onOutsideMousedown([popup], onClose, 10);
        mousedownOn(outside); // still inside the registration delay
        expect(onClose).not.toHaveBeenCalled();
        vi.advanceTimersByTime(10);
        mousedownOn(outside);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("the disposer should remove the listener", () => {
        const popup = document.createElement("div");
        const outside = document.createElement("div");
        document.body.append(popup, outside);
        const onClose = vi.fn();
        const dispose = onOutsideMousedown([popup], onClose);
        dispose();
        mousedownOn(outside);
        expect(onClose).not.toHaveBeenCalled();
    });
});
