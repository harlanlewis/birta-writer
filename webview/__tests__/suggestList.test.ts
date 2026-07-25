/**
 * suggestList tests: the shared anchored suggestion dropdown extracted by
 * MAR-220. The widget's placement and ARIA model are already exercised
 * through its consumers (linkTargetComplete.test.ts and friends); this file
 * covers the surface the extraction ADDED — `render`, `className`,
 * `initialActive`, the mouseover guard, and the pick index.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSuggestMenuFromRows } from "../ui/suggestList";

const ROWS = [{ text: "one" }, { text: "two" }, { text: "three" }];
const ANCHOR = { left: 10, top: 100 };

function menuEl(): HTMLElement | null {
    return document.querySelector(".fm-suggest-menu");
}

function rowEls(): HTMLElement[] {
    return Array.from(document.querySelectorAll(".fm-suggest-menu li"));
}

function focusedIndex(): number {
    return rowEls().findIndex((li) =>
        li.classList.contains("fm-suggest-item--focused"),
    );
}

describe("suggest list shell", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("zero rows should render no menu", () => {
        expect(createSuggestMenuFromRows([], ANCHOR, () => {})).toBeNull();
    });

    it("rows should carry the base menu, list, and row primitive classes", () => {
        createSuggestMenuFromRows(ROWS, ANCHOR, () => {});

        expect(menuEl()!.classList.contains("link-target-menu")).toBe(true);
        expect(document.querySelector(".fm-suggest-list")!.getAttribute("role"))
            .toBe("listbox");
        for (const li of rowEls()) {
            expect(li.classList.contains("ui-menu-row")).toBe(true);
            expect(li.classList.contains("fm-suggest-item")).toBe(true);
        }
    });

    // ── className ───────────────────────────────────────────────

    it("a className should be added alongside the base classes", () => {
        createSuggestMenuFromRows(ROWS, ANCHOR, () => {}, {
            className: "path-complete-menu",
        });

        const el = menuEl()!;
        expect(el.classList.contains("fm-suggest-menu")).toBe(true);
        expect(el.classList.contains("link-target-menu")).toBe(true);
        expect(el.classList.contains("path-complete-menu")).toBe(true);
    });

    it("no className should leave the menu with only the base classes", () => {
        createSuggestMenuFromRows(ROWS, ANCHOR, () => {});

        expect(menuEl()!.className).toBe("fm-suggest-menu link-target-menu");
    });

    // ── initialActive ───────────────────────────────────────────

    it("by default no row should be highlighted at open", () => {
        const menu = createSuggestMenuFromRows(ROWS, ANCHOR, () => {})!;

        expect(focusedIndex()).toBe(-1);
        // …and a bare pick is therefore a no-op, so Enter keeps its meaning.
        expect(menu.pickActive()).toBe(false);
    });

    it("initialActive 0 should highlight the first row at open", () => {
        const onPick = vi.fn();
        const menu = createSuggestMenuFromRows(ROWS, ANCHOR, onPick, {
            initialActive: 0,
        })!;

        expect(focusedIndex()).toBe(0);
        expect(rowEls()[0].getAttribute("aria-selected")).toBe("true");
        expect(rowEls()[1].getAttribute("aria-selected")).toBe("false");
        expect(menu.pickActive()).toBe(true);
        expect(onPick).toHaveBeenCalledWith("one", 0);
    });

    // ── render ──────────────────────────────────────────────────

    it("a render callback should own the row's content", () => {
        createSuggestMenuFromRows(
            [
                {
                    text: "img/cats.jpeg",
                    title: "img/cats.jpeg",
                    render: (li) => {
                        const icon = document.createElement("span");
                        icon.className = "test-icon";
                        const label = document.createElement("span");
                        label.textContent = "cats.jpeg";
                        li.append(icon, label);
                    },
                },
            ],
            ANCHOR,
            () => {},
        );

        const li = rowEls()[0];
        expect(li.querySelector(".test-icon")).not.toBeNull();
        // The displayed text is the render callback's, NOT the picked value.
        expect(li.textContent).toBe("cats.jpeg");
        expect(li.title).toBe("img/cats.jpeg");
    });

    it("a rendered row should still pick its full text value", () => {
        const onPick = vi.fn();
        createSuggestMenuFromRows(
            [{ text: "img/cats.jpeg", render: (li) => { li.textContent = "cats.jpeg"; } }],
            ANCHOR,
            onPick,
        );

        rowEls()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(onPick).toHaveBeenCalledWith("img/cats.jpeg", 0);
    });

    it("a hint row should keep its label and hint spans when no render is given", () => {
        createSuggestMenuFromRows(
            [{ text: "42", hint: "Tab" }],
            ANCHOR,
            () => {},
        );

        const li = rowEls()[0];
        expect(li.querySelector(".fm-suggest-item__label")!.textContent).toBe("42");
        expect(li.querySelector(".fm-suggest-item__hint")!.textContent).toBe("Tab");
    });

    // ── pick index (the disambiguator) ──────────────────────────

    it("two rows with the same text should pick by index", () => {
        const onPick = vi.fn();
        // A directory `foo/` and a file `foo` in the same listing both render
        // the segment "foo" — the reason onPick carries an index at all.
        const menu = createSuggestMenuFromRows(
            [
                { text: "foo", render: (li) => { li.textContent = "foo"; } },
                { text: "foo", render: (li) => { li.textContent = "foo"; } },
            ],
            ANCHOR,
            onPick,
        )!;

        menu.moveActive(1);
        menu.moveActive(1);
        menu.pickActive();

        expect(onPick).toHaveBeenCalledWith("foo", 1);
    });

    // ── mouseover guard ─────────────────────────────────────────

    it("a mouseover fired by keyboard scrolling should not move the highlight", () => {
        const menu = createSuggestMenuFromRows(ROWS, ANCHOR, () => {})!;

        menu.moveActive(1); // highlight row 0
        rowEls()[2].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

        expect(focusedIndex()).toBe(0);
    });

    it("a real pointer move should lift the guard and restore hover selection", () => {
        const menu = createSuggestMenuFromRows(ROWS, ANCHOR, () => {})!;

        menu.moveActive(1);
        rowEls()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        rowEls()[2].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

        expect(focusedIndex()).toBe(2);
    });

    it("hovering without prior keyboard navigation should select the row", () => {
        createSuggestMenuFromRows(ROWS, ANCHOR, () => {});

        rowEls()[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

        expect(focusedIndex()).toBe(1);
    });

    // ── highlight movement ──────────────────────────────────────

    it("moveActive should wrap in both directions", () => {
        const menu = createSuggestMenuFromRows(ROWS, ANCHOR, () => {})!;

        menu.moveActive(-1);
        expect(focusedIndex()).toBe(2);
        menu.moveActive(1);
        expect(focusedIndex()).toBe(0);
        menu.moveActive(-1);
        expect(focusedIndex()).toBe(2);
    });

    it("destroy should remove the menu from the document", () => {
        const menu = createSuggestMenuFromRows(ROWS, ANCHOR, () => {})!;

        menu.destroy();

        expect(menuEl()).toBeNull();
    });
});
