import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { insertionIndexFromX, enterEditMode, type EditModeDeps } from "../components/toolbar/dnd";

/** A div whose getBoundingClientRect is stubbed (jsdom performs no layout). */
function itemAt(left: number, width: number): HTMLElement {
    const el = document.createElement("div");
    el.getBoundingClientRect = () =>
        ({
            left,
            width,
            right: left + width,
            top: 0,
            bottom: 0,
            height: 0,
            x: left,
            y: 0,
            toJSON() {},
        }) as DOMRect;
    return el;
}

describe("insertionIndexFromX", () => {
    // Three 20px-wide items at x=0,20,40 → midpoints at 10, 30, 50.
    const items = [itemAt(0, 20), itemAt(20, 20), itemAt(40, 20)];

    it("a pointer before the first midpoint should insert at index 0", () => {
        expect(insertionIndexFromX(items, 5)).toBe(0);
    });

    it("a pointer between the first and second midpoints should insert at index 1", () => {
        expect(insertionIndexFromX(items, 25)).toBe(1);
    });

    it("a pointer between the second and third midpoints should insert at index 2", () => {
        expect(insertionIndexFromX(items, 45)).toBe(2);
    });

    it("a pointer past the last midpoint should append (index = length)", () => {
        expect(insertionIndexFromX(items, 100)).toBe(3);
    });

    it("a pointer exactly at a midpoint should insert after that item", () => {
        // clientX < midpoint is strict, so x == 10 is not before item 0
        expect(insertionIndexFromX(items, 10)).toBe(1);
    });

    it("an empty list should insert at index 0", () => {
        expect(insertionIndexFromX([], 50)).toBe(0);
    });
});

/**
 * The pointer-drag lifecycle is the riskiest part of dnd.ts (capture, ghost
 * teardown, cancel paths). jsdom does no layout and has no PointerEvent, so we
 * drive it with typed MouseEvents carrying a pointerId, stub pointer-capture,
 * and route zone hit-testing through a controllable elementFromPoint.
 */
describe("enterEditMode drag lifecycle", () => {
    let toolbar: HTMLElement;
    let zones: Record<string, HTMLElement>;
    let moreWrap: HTMLElement;
    let onChange: ReturnType<typeof vi.fn>;
    let onExit: ReturnType<typeof vi.fn>;
    let exit: () => void;
    /** The zone elementFromPoint should report the pointer is over (null = off-bar). */
    let hitZone: HTMLElement | null;

    function zone(name: string): HTMLElement {
        const z = document.createElement("div");
        z.dataset["zone"] = name;
        return z;
    }
    function addItem(id: string, into: HTMLElement): HTMLElement {
        const el = document.createElement("div");
        el.className = "tb-item";
        el.dataset["itemId"] = id;
        into.appendChild(el);
        return el;
    }
    function pev(type: string, x: number, y: number, target: EventTarget = document, pointerId = 1): void {
        const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
        Object.defineProperty(e, "pointerId", { value: pointerId, configurable: true });
        target.dispatchEvent(e);
    }
    const ghostEl = () => document.querySelector(".tb-drag-ghost");

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        // jsdom lacks these; stub so capture calls are observable and don't throw.
        (HTMLElement.prototype as unknown as { setPointerCapture: unknown }).setPointerCapture = vi.fn();
        (HTMLElement.prototype as unknown as { releasePointerCapture: unknown }).releasePointerCapture = vi.fn();
        hitZone = null;
        document.elementFromPoint = vi.fn(() => hitZone) as typeof document.elementFromPoint;

        toolbar = document.createElement("div");
        const left = zone("left"), center = zone("center"), right = zone("right"), hidden = zone("hidden");
        moreWrap = document.createElement("div");
        center.appendChild(moreWrap); // the ⋯ wrapper, pinned at the end of center
        toolbar.append(left, center, right, hidden);
        document.body.appendChild(toolbar);
        zones = { left, center, right, hidden };

        onChange = vi.fn();
        onExit = vi.fn();
        const deps: EditModeDeps = {
            toolbar,
            zones: zones as unknown as EditModeDeps["zones"],
            moreWrap,
            expandOverflow: vi.fn(),
            onChange,
            onExit,
        };
        exit = enterEditMode(deps);
    });

    afterEach(() => {
        exit(); // idempotent-enough; removes document listeners so tests don't bleed
    });

    it("a drag into another zone should move the item and report the new placement", () => {
        const a = addItem("a", zones.left);
        addItem("b", zones.center);
        hitZone = zones.center;

        pev("pointerdown", 0, 0, a);
        pev("pointermove", 20, 0); // past the 4px threshold → begins the drag
        expect(ghostEl()).not.toBeNull();
        pev("pointerup", 20, 0);

        expect(onChange).toHaveBeenCalledTimes(1);
        const change = onChange.mock.calls[0]![0];
        expect(change.item).toEqual({ id: "a", placement: "center" });
        expect(a.parentElement).toBe(zones.center);
        expect(ghostEl()).toBeNull(); // ghost torn down on drop
    });

    it("a sub-threshold press should be treated as a click, not a drag", () => {
        const a = addItem("a", zones.left);
        hitZone = zones.center;

        pev("pointerdown", 0, 0, a);
        pev("pointerup", 2, 0); // 2px < 4px threshold

        expect(onChange).not.toHaveBeenCalled();
        expect(a.parentElement).toBe(zones.left);
        expect(ghostEl()).toBeNull();
    });

    it("a below-threshold move should not start a drag (still a click)", () => {
        const a = addItem("a", zones.left);
        hitZone = zones.center;

        pev("pointerdown", 0, 0, a);
        pev("pointermove", 3, 0); // 3px < 4px threshold → moved stays false
        expect(ghostEl()).toBeNull(); // no ghost: the drag never began
        pev("pointerup", 3, 0);

        expect(onChange).not.toHaveBeenCalled();
        expect(a.parentElement).toBe(zones.left);
    });

    it("pointercancel mid-drag should remove the ghost and leave the item in place", () => {
        const a = addItem("a", zones.left);
        hitZone = zones.center;

        pev("pointerdown", 0, 0, a);
        pev("pointermove", 20, 0);
        expect(ghostEl()).not.toBeNull();
        pev("pointercancel", 20, 0);

        expect(onChange).not.toHaveBeenCalled();
        expect(a.parentElement).toBe(zones.left);
        expect(ghostEl()).toBeNull();
    });

    it("Escape mid-drag should cancel the drag without exiting edit mode", () => {
        const a = addItem("a", zones.left);
        hitZone = zones.center;

        pev("pointerdown", 0, 0, a);
        pev("pointermove", 20, 0);
        const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        document.dispatchEvent(esc);

        expect(ghostEl()).toBeNull();
        expect(a.parentElement).toBe(zones.left);
        expect(onExit).not.toHaveBeenCalled(); // drag cancelled, mode still active
    });

    it("Escape with no drag in flight should exit edit mode", () => {
        const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        document.dispatchEvent(esc);
        expect(onExit).toHaveBeenCalledTimes(1);
    });

    it("a second pointer while a drag is in flight should be ignored", () => {
        const a = addItem("a", zones.left);
        const b = addItem("b", zones.right);
        const capture = (HTMLElement.prototype as unknown as { setPointerCapture: ReturnType<typeof vi.fn> }).setPointerCapture;

        pev("pointerdown", 0, 0, a, 1);
        expect(capture).toHaveBeenCalledTimes(1);
        pev("pointerdown", 0, 0, b, 2); // second pointer — guarded out
        expect(capture).toHaveBeenCalledTimes(1);
    });

    it("exiting should remove the document listeners so later pointers do nothing", () => {
        exit();
        const a = addItem("a", zones.left);
        pev("pointerdown", 0, 0, a);
        pev("pointermove", 20, 0);
        expect(ghostEl()).toBeNull(); // no drag started after teardown
        expect(onChange).not.toHaveBeenCalled();
    });
});
