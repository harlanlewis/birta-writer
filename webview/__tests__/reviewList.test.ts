import { describe, it, expect, beforeEach } from "vitest";
import { initReviewList, type ReviewRowModel } from "../components/toc/reviewList";

/**
 * The shared review-list body (MAR-188 / MAR-192): it must rebuild the DOM only
 * when the visible rows CHANGE, and otherwise carry shifted navigation anchors
 * onto the surviving rows in place — the frugality that keeps the Proofreading
 * and Notes tabs cheap while the document is edited underneath them.
 */

function row(over: Partial<ReviewRowModel>): ReviewRowModel {
    return { tag: "TK", label: "a note", from: 1, to: 5, actions: [], ...over };
}

describe("initReviewList", () => {
    beforeEach(() => { document.body.innerHTML = ""; });

    it("rendering rows should create one .review-item per row with its anchor on the dataset", () => {
        const { element, render } = initReviewList("review-list", () => null);
        render({ rows: [row({ label: "one", from: 2, to: 6 }), row({ label: "two" })] });
        const items = element.querySelectorAll<HTMLElement>(".review-item");
        expect(items).toHaveLength(2);
        expect(items[0]!.dataset["from"]).toBe("2");
        expect(items[0]!.dataset["to"]).toBe("6");
    });

    it("re-rendering the SAME rows with shifted anchors should sync in place, not rebuild", () => {
        const { element, render } = initReviewList("review-list", () => null);
        render({ rows: [row({ label: "stable", from: 1, to: 5 })] });
        const first = element.querySelector(".review-item");
        render({ rows: [row({ label: "stable", from: 10, to: 14 })] }); // same display, moved
        const second = element.querySelector(".review-item");
        expect(second).toBe(first); // same element instance — no teardown
        expect((second as HTMLElement).dataset["from"]).toBe("10");
        expect((second as HTMLElement).dataset["to"]).toBe("14");
    });

    it("a changed label should rebuild the row", () => {
        const { element, render } = initReviewList("review-list", () => null);
        render({ rows: [row({ label: "before" })] });
        const first = element.querySelector(".review-item");
        render({ rows: [row({ label: "after" })] });
        expect(element.querySelector(".review-item")).not.toBe(first);
        expect(element.querySelector(".review-item__label")!.textContent).toBe("after");
    });

    it("a changed action set should rebuild the row (its signature includes action labels)", () => {
        const { element, render } = initReviewList("review-list", () => null);
        render({ rows: [row({ actions: [{ label: "Ignore", run: () => {} }] })] });
        const first = element.querySelector(".review-item");
        render({ rows: [row({ actions: [{ label: "Learn", run: () => {} }, { label: "Ignore", run: () => {} }] })] });
        expect(element.querySelector(".review-item")).not.toBe(first);
        expect(element.querySelectorAll(".review-item__action")).toHaveLength(2);
    });

    it("an empty result should show the empty row and switching to rows should replace it", () => {
        const { element, render } = initReviewList("review-list", () => null);
        render({ empty: "No notes" });
        expect(element.querySelector(".review-empty")!.textContent).toBe("No notes");
        render({ rows: [row({})] });
        expect(element.querySelector(".review-empty")).toBeNull();
        expect(element.querySelectorAll(".review-item")).toHaveLength(1);
    });

    it("a null result should clear the list", () => {
        const { element, render } = initReviewList("review-list", () => null);
        render({ rows: [row({}), row({})] });
        render(null);
        expect(element.children).toHaveLength(0);
    });

    it("clicking a row should not throw when there is no editor", () => {
        const { element, render } = initReviewList("review-list", () => null);
        render({ rows: [row({})] });
        const main = element.querySelector<HTMLElement>(".review-item__main")!;
        expect(() => main.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
    });
});
