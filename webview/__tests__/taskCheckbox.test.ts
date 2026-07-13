import { describe, it, expect, beforeEach } from "vitest";
import { isTaskCheckboxClick } from "../utils/taskCheckbox";

// The task item's left edge is placed at x=100 so we can express clicks as
// absolute clientX values: offset = clientX - 100.
const ITEM_LEFT = 100;

function makeTaskItem(): { li: HTMLElement; marker: HTMLElement } {
    const li = document.createElement("li");
    li.setAttribute("data-item-type", "task");
    li.getBoundingClientRect = () =>
        ({
            left: ITEM_LEFT,
            top: 0,
            right: ITEM_LEFT + 400,
            bottom: 40,
            width: 400,
            height: 40,
            x: ITEM_LEFT,
            y: 0,
            toJSON: () => ({}),
        }) as DOMRect;

    // The block handle: a marker button inside the gutter. It is a DOM
    // descendant of the <li> but renders out in the left margin.
    const gutter = document.createElement("div");
    gutter.className = "heading-fold-gutter";
    const marker = document.createElement("button");
    marker.className = "heading-fold-marker";
    gutter.appendChild(marker);
    li.appendChild(gutter);

    document.body.appendChild(li);
    return { li, marker };
}

describe("isTaskCheckboxClick", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    // Regression: clicking the block handle used to toggle the checkbox because
    // the handle sits in the left margin and the old hit-test only excluded
    // clicks to the *right* of the checkbox.
    it("a click on the block handle (gutter chrome) should not count as a checkbox click", () => {
        const { li, marker } = makeTaskItem();
        // clientX=60 is out in the left margin where the handle renders.
        expect(isTaskCheckboxClick(marker, li, 60)).toBe(false);
    });

    it("a click on the block handle should be inert even if its geometry falls in the checkbox column", () => {
        const { li, marker } = makeTaskItem();
        // Belt-and-suspenders: the gutter guard wins regardless of clientX.
        expect(isTaskCheckboxClick(marker, li, ITEM_LEFT + 10)).toBe(false);
    });

    it("a click in the left gutter margin (negative offset) should not count as a checkbox click", () => {
        const { li } = makeTaskItem();
        expect(isTaskCheckboxClick(li, li, 60)).toBe(false);
    });

    it("a click on the checkbox column should count as a checkbox click", () => {
        const { li } = makeTaskItem();
        expect(isTaskCheckboxClick(li, li, ITEM_LEFT + 10)).toBe(true);
    });

    it("a click at the item's left edge (offset 0) should count as a checkbox click", () => {
        const { li } = makeTaskItem();
        expect(isTaskCheckboxClick(li, li, ITEM_LEFT)).toBe(true);
    });

    it("a click at the checkbox column's right edge (offset 24) should count as a checkbox click", () => {
        const { li } = makeTaskItem();
        expect(isTaskCheckboxClick(li, li, ITEM_LEFT + 24)).toBe(true);
    });

    it("a click just past the checkbox column (offset 25) should not count as a checkbox click", () => {
        const { li } = makeTaskItem();
        expect(isTaskCheckboxClick(li, li, ITEM_LEFT + 25)).toBe(false);
    });

    it("a click in the item's text should not count as a checkbox click", () => {
        const { li } = makeTaskItem();
        expect(isTaskCheckboxClick(li, li, ITEM_LEFT + 200)).toBe(false);
    });
});
