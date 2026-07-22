import { describe, it, expect, beforeEach, vi } from "vitest";
import { initReviewList, type ReviewRowModel } from "../components/toc/reviewList";

/**
 * The shared review-list body (MAR-188 / MAR-192): rebuild the DOM only when the
 * visible rows CHANGE, otherwise carry shifted anchors onto surviving rows in
 * place; plus the By-type / In-order view modes (grouped headers vs a flat list)
 * and collapsible groups.
 */

function row(over: Partial<ReviewRowModel>): ReviewRowModel {
    return { tag: "TK", label: "a note", from: 1, to: 5, actions: [], ...over };
}

/** A list in a given mode; onToggle is a spy so persistence can be asserted. */
function mk(grouped: boolean) {
    const onToggle = vi.fn();
    const view = initReviewList("review-list", () => null, {
        initialGroupByType: grouped,
        onToggleGroupByType: onToggle,
    });
    return { ...view, onToggle };
}

const items = (el: HTMLElement) => el.querySelectorAll<HTMLElement>(".review-item");
const groups = (el: HTMLElement) => el.querySelectorAll<HTMLElement>(".review-group");

describe("initReviewList — flat (In order) mode", () => {
    beforeEach(() => { document.body.innerHTML = ""; });

    it("renders one .review-item per row with its anchor on the dataset", () => {
        const { element, render } = mk(false);
        render({ rows: [row({ label: "one", from: 2, to: 6 }), row({ label: "two" })] });
        expect(items(element)).toHaveLength(2);
        expect(items(element)[0]!.dataset["from"]).toBe("2");
    });

    it("re-rendering the SAME rows with shifted anchors syncs in place, not rebuild", () => {
        const { element, render } = mk(false);
        render({ rows: [row({ label: "stable", from: 1, to: 5 })] });
        const first = items(element)[0];
        render({ rows: [row({ label: "stable", from: 10, to: 14 })] });
        expect(items(element)[0]).toBe(first); // same element, no teardown
        expect(items(element)[0]!.dataset["from"]).toBe("10");
    });

    it("a changed label rebuilds the row", () => {
        const { element, render } = mk(false);
        render({ rows: [row({ label: "before" })] });
        const first = items(element)[0];
        render({ rows: [row({ label: "after" })] });
        expect(items(element)[0]).not.toBe(first);
    });

    it("an empty result shows the empty row; switching to rows replaces it", () => {
        const { element, render } = mk(false);
        render({ empty: "No notes" });
        expect(element.querySelector(".review-empty")!.textContent).toBe("No notes");
        render({ rows: [row({})] });
        expect(element.querySelector(".review-empty")).toBeNull();
        expect(items(element)).toHaveLength(1);
    });

    it("clicking a row does not throw with no editor", () => {
        const { element, render } = mk(false);
        render({ rows: [row({})] });
        const main = element.querySelector<HTMLElement>(".review-item__main")!;
        expect(() => main.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
    });

    it("renders the flagged span within a context label", () => {
        const { element, render } = mk(false);
        render({ rows: [row({ label: "ab—cd", emphasis: { start: 2, end: 3 } })] });
        expect(element.querySelector(".review-item__flag")?.textContent).toBe("—");
        expect(element.querySelector(".review-item__label")?.textContent).toBe("ab—cd");
    });

    it("ignores an out-of-range emphasis and renders plain text", () => {
        const { element, render } = mk(false);
        render({ rows: [row({ label: "abc", emphasis: { start: 5, end: 9 } })] });
        expect(element.querySelector(".review-item__flag")).toBeNull();
        expect(element.querySelector(".review-item__label")?.textContent).toBe("abc");
    });
});

describe("initReviewList — By-type (grouped) mode", () => {
    beforeEach(() => { document.body.innerHTML = ""; });

    it("groups rows under one header per type, in first-appearance order", () => {
        const { element, render } = mk(true);
        render({ rows: [
            row({ tag: "EM DASH", label: "—", from: 1, to: 2 }),
            row({ tag: "SPELLING", label: "recieve", from: 5, to: 12 }),
            row({ tag: "EM DASH", label: "—", from: 20, to: 21 }),
        ] });
        const names = [...groups(element)].map((g) => g.querySelector(".review-group__name")?.textContent);
        expect(names).toEqual(["EM DASH", "SPELLING"]);
        // The EM DASH group's count is 2.
        expect(groups(element)[0]!.querySelector(".review-group__count")?.textContent).toBe("2");
        expect(items(element)).toHaveLength(3);
    });

    it("hides the per-row chip in grouped mode (the header carries the type)", () => {
        const { element, render } = mk(true);
        render({ rows: [row({ tag: "TK" })] });
        expect(element.classList.contains("review-list--grouped")).toBe(true);
    });

    it("orders groups by rank (correctness-first), not first appearance", () => {
        const { element, render } = mk(true);
        render({ rows: [
            row({ tag: "EM DASH", rank: 2, from: 1, to: 2 }),   // appears first, low priority
            row({ tag: "SPELLING", rank: 0, from: 9, to: 16 }), // appears later, high priority
        ] });
        const names = [...groups(element)].map((g) => g.querySelector(".review-group__name")?.textContent);
        expect(names).toEqual(["SPELLING", "EM DASH"]);
    });

    it("clicking a group header collapses it (its rows leave the DOM)", () => {
        const { element, render } = mk(true);
        render({ rows: [
            row({ tag: "TK", label: "a", from: 1, to: 2 }),
            row({ tag: "TODO", label: "b", from: 5, to: 6 }),
        ] });
        expect(items(element)).toHaveLength(2);
        (groups(element)[0] as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(groups(element)[0]!.classList.contains("review-group--collapsed")).toBe(true);
        expect(items(element)).toHaveLength(1); // only TODO's row remains
    });
});

describe("initReviewList — view-mode toggle", () => {
    beforeEach(() => { document.body.innerHTML = ""; });

    it("clicking a segment switches mode and persists via the callback", () => {
        const { element, render, onToggle } = mk(true);
        render({ rows: [row({ tag: "TK" })] });
        expect(groups(element)).toHaveLength(1); // grouped
        const inOrder = element.querySelectorAll<HTMLElement>(".review-seg")[1]!;
        inOrder.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(onToggle).toHaveBeenCalledWith(false);
        expect(groups(element)).toHaveLength(0); // flat now
        expect(items(element)).toHaveLength(1);
    });

    it("an external setGroupByType change re-renders WITHOUT re-persisting", () => {
        const { element, render, setGroupByType, onToggle } = mk(false);
        render({ rows: [row({ tag: "TK" })] });
        expect(groups(element)).toHaveLength(0); // flat
        setGroupByType(true);
        expect(onToggle).not.toHaveBeenCalled();
        expect(groups(element)).toHaveLength(1); // grouped now
    });

    it("the toolbar is hidden when there are no rows", () => {
        const { element, render } = mk(true);
        render({ empty: "No suggestions" });
        expect(element.querySelector<HTMLElement>(".review-toolbar")!.hidden).toBe(true);
        render({ rows: [row({})] });
        expect(element.querySelector<HTMLElement>(".review-toolbar")!.hidden).toBe(false);
    });
});
