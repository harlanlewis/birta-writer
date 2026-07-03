/**
 * findBar component tests: match counting, navigation, and replace.
 *
 * Replace goes through ProseMirror transactions; the tests use a fake
 * EditorView whose posAtDOM maps DOM offsets to PM positions (offset + 1,
 * simulating a doc with a single paragraph) and whose dispatch applies the
 * recorded insertText ops to the underlying text node.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EditorView } from "@milkdown/prose/view";
import { initFindBar, type FindBarController } from "../components/findBar";

interface InsertTextOp {
    text: string;
    from: number;
    to: number;
}

function createFakeView(getTextNode: () => Text) {
    const ops: InsertTextOp[] = [];
    const makeTr = () => {
        const tr = {
            insertText(text: string, from: number, to: number) {
                ops.push({ text, from, to });
                return tr;
            },
        };
        return tr;
    };
    const view = {
        posAtDOM: (_node: Node, offset: number) => offset + 1,
        get state() {
            return { tr: makeTr() };
        },
        dispatch: () => {
            // Ops arrive in reverse document order, so sequential application
            // keeps earlier offsets valid
            const node = getTextNode();
            for (const op of ops.splice(0)) {
                node.data = node.data.slice(0, op.from - 1) + op.text + node.data.slice(op.to - 1);
            }
        },
    };
    return { view: view as unknown as EditorView, ops };
}

function setup(text: string, viewOverride?: EditorView | null) {
    document.body.innerHTML = "";
    const editor = document.createElement("div");
    editor.id = "editor";
    editor.textContent = text;
    document.body.appendChild(editor);

    const textNode = () => editor.firstChild as Text;
    const { view } = createFakeView(textNode);
    const findBar = initFindBar(
        () => editor,
        () => (viewOverride === undefined ? view : viewOverride),
    );

    const bar = document.querySelector(".find-bar") as HTMLElement;
    const findInput = bar.querySelector('input[aria-label="Find"]') as HTMLInputElement;
    const replaceInput = bar.querySelector('input[aria-label="Replace"]') as HTMLInputElement;
    const count = bar.querySelector(".find-bar__count") as HTMLElement;
    const btnReplace = bar.querySelector('button[aria-label="Replace"]') as HTMLButtonElement;
    const btnReplaceAll = bar.querySelector('button[aria-label="Replace All"]') as HTMLButtonElement;
    const btnToggle = bar.querySelector('button[aria-label="Toggle Replace"]') as HTMLButtonElement;
    const btnNext = bar.querySelector('button[aria-label="Next Match"]') as HTMLButtonElement;
    const btnPrev = bar.querySelector('button[aria-label="Previous Match"]') as HTMLButtonElement;

    return { editor, findBar, bar, findInput, replaceInput, count, btnReplace, btnReplaceAll, btnToggle, btnNext, btnPrev };
}

describe("initFindBar search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // jsdom does not implement scrolling
        window.scrollTo = vi.fn();
    });

    it("opening with a query should count all matches", () => {
        const { findBar, count } = setup("foo bar foo");
        findBar.open("foo");
        expect(count.textContent).toBe("1/2");
    });

    it("a query with no matches should show the no-results state", () => {
        const { findBar, bar, count } = setup("foo bar foo");
        findBar.open("nope");
        expect(count.textContent).toBe("No results");
        expect(bar.classList.contains("find-bar--no-results")).toBe(true);
    });

    it("overlapping occurrences should be counted as non-overlapping matches", () => {
        const { findBar, count } = setup("aaaa");
        findBar.open("aa");
        expect(count.textContent).toBe("1/2");
    });

    it("next/prev should cycle through matches", () => {
        const { findBar, count, btnNext, btnPrev } = setup("foo bar foo");
        findBar.open("foo");
        btnNext.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(count.textContent).toBe("2/2");
        btnNext.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(count.textContent).toBe("1/2");
        btnPrev.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(count.textContent).toBe("2/2");
    });

    it("close should hide the bar and clear state", () => {
        const { findBar, bar, count } = setup("foo bar foo");
        findBar.open("foo");
        findBar.close();
        expect(findBar.isOpen()).toBe(false);
        expect(bar.classList.contains("find-bar--visible")).toBe(false);
        expect(count.textContent).toBe("");
    });
});

describe("initFindBar replace", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.scrollTo = vi.fn();
    });

    it("toggle button should show and hide the replace row", () => {
        const { findBar, bar, btnToggle } = setup("foo bar foo");
        findBar.open("foo");
        expect(bar.classList.contains("find-bar--replace-visible")).toBe(false);
        btnToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(bar.classList.contains("find-bar--replace-visible")).toBe(true);
        expect(btnToggle.getAttribute("aria-expanded")).toBe("true");
        btnToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(bar.classList.contains("find-bar--replace-visible")).toBe(false);
    });

    it("open with showReplace should expand the replace row", () => {
        const { findBar, bar } = setup("foo bar foo");
        findBar.open("foo", { showReplace: true });
        expect(bar.classList.contains("find-bar--replace-visible")).toBe(true);
    });

    it("replace should substitute the current match and move to the next one", () => {
        const { editor, findBar, replaceInput, count, btnReplace } = setup("foo bar foo");
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "baz";
        btnReplace.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(editor.textContent).toBe("baz bar foo");
        expect(count.textContent).toBe("1/1");
    });

    it("replacement text containing the query should not be matched again", () => {
        const { editor, findBar, replaceInput, count, btnReplace } = setup("foo bar foo");
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "foofoo";
        btnReplace.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(editor.textContent).toBe("foofoo bar foo");
        // 3 matches now, but the current one advanced past the inserted text
        expect(count.textContent).toBe("3/3");
    });

    it("Enter in the replace input should replace the current match", () => {
        const { editor, findBar, replaceInput } = setup("foo bar foo");
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "qux";
        replaceInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        expect(editor.textContent).toBe("qux bar foo");
    });

    it("replace all should substitute every match in one pass", () => {
        const { editor, findBar, replaceInput, count, btnReplaceAll } = setup("foo bar foo");
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "baz";
        btnReplaceAll.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(editor.textContent).toBe("baz bar baz");
        expect(count.textContent).toBe("No results");
    });

    it("replace all with an empty replacement should delete all matches", () => {
        const { editor, findBar, replaceInput, btnReplaceAll } = setup("foo bar foo");
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "";
        btnReplaceAll.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(editor.textContent).toBe(" bar ");
    });

    it("replace without an editor view should leave the document unchanged", () => {
        const { editor, findBar, replaceInput, btnReplace } = setup("foo bar foo", null);
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "baz";
        btnReplace.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(editor.textContent).toBe("foo bar foo");
    });
});
