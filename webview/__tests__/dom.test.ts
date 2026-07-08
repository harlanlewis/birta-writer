/**
 * createButton tests: mouse and keyboard activation of the onClick handler.
 * The factory wires actions on mousedown (so the editor never loses focus
 * on a toolbar click) plus keyboard clicks (detail 0), which mousedown
 * never covers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createButton, setupApplyOnBlur } from "../ui/dom";

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

describe("setupApplyOnBlur", () => {
    const press = (input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) => {
        const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
        input.dispatchEvent(e);
        return e;
    };

    const setup = () => {
        const input = document.createElement("input");
        document.body.appendChild(input);
        const commit = vi.fn();
        const revert = vi.fn();
        const onClose = vi.fn();
        setupApplyOnBlur(input, { commit, revert, onClose });
        return { input, commit, revert, onClose };
    };

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("blur should commit", () => {
        const { input, commit, revert } = setup();
        input.dispatchEvent(new FocusEvent("blur"));
        expect(commit).toHaveBeenCalledTimes(1);
        expect(revert).not.toHaveBeenCalled();
    });

    it("Enter should commit, claim the event, and call onClose", () => {
        const { input, commit, onClose } = setup();
        const e = press(input, "Enter");
        expect(commit).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(e.defaultPrevented).toBe(true);
    });

    it("Escape should revert without committing, and call onClose", () => {
        const { input, commit, revert, onClose } = setup();
        press(input, "Escape");
        expect(revert).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Enter during IME composition should be ignored", () => {
        const { input, commit } = setup();
        press(input, "Enter", { isComposing: true });
        expect(commit).not.toHaveBeenCalled();
    });

    it("other keys should bubble untouched (VS Code clipboard relies on it)", () => {
        const { input, commit, revert } = setup();
        const e = press(input, "a");
        expect(commit).not.toHaveBeenCalled();
        expect(revert).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(false);
    });
});
