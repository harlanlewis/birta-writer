import { describe, it, expect } from "vitest";
import { insertionIndexFromX } from "../components/toolbar/dnd";

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
