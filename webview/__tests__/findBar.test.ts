/**
 * findBar component tests: match counting, navigation, toggles and replace.
 *
 * Search runs over the ProseMirror document (not the rendered DOM), so the
 * tests build real prosemirror-model docs wrapped in a fake EditorView whose
 * dispatch applies real transactions. DOM-dependent paths (highlight ranges,
 * scrolling) are exercised through their guards: domAtPos throws and
 * nodeDOM returns null, as they would for unmapped decoration widgets.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EditorView } from "@milkdown/prose/view";
import { Schema, type Node as PmNode, type Mark } from "@milkdown/prose/model";
import { EditorState, TextSelection, type Transaction } from "@milkdown/prose/state";
import { initFindBar } from "../components/findBar";

// ── Test schema ──────────────────────────────────────────
const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        code_block: {
            group: "block",
            content: "text*",
            code: true,
            marks: "",
            attrs: { language: { default: "" } },
        },
        image: {
            group: "inline",
            inline: true,
            attrs: {
                src: { default: "" },
                alt: { default: "" },
                title: { default: "" },
            },
        },
        text: { group: "inline" },
    },
    marks: {
        link: { attrs: { href: { default: "" }, title: { default: null } } },
    },
});

const p = (...content: (PmNode | string)[]) =>
    schema.node("paragraph", null, content.map((c) => (typeof c === "string" ? schema.text(c) : c)));
const mkDoc = (...content: PmNode[]) => schema.node("doc", null, content);
const linked = (text: string, href: string) => schema.text(text, [schema.mark("link", { href })]);

interface FakeView {
    view: EditorView;
    getState: () => EditorState;
    getDispatchCount: () => number;
}

function createFakeView(doc: PmNode, selection?: { from: number; to: number }): FakeView {
    let state = EditorState.create({
        doc,
        selection: selection ? TextSelection.create(doc, selection.from, selection.to) : undefined,
    });
    let dispatchCount = 0;
    const view = {
        get state() {
            return state;
        },
        dispatch(tr: Transaction) {
            dispatchCount++;
            state = state.apply(tr);
        },
        domAtPos(): never {
            throw new Error("no DOM mapping in tests");
        },
        nodeDOM: () => null,
        dom: document.getElementById("editor") ?? document.createElement("div"),
    };
    return {
        view: view as unknown as EditorView,
        getState: () => state,
        getDispatchCount: () => dispatchCount,
    };
}

function setup(
    doc: PmNode,
    opts: { view?: EditorView | null; selection?: { from: number; to: number }; source?: string } = {},
) {
    document.body.innerHTML = "";
    const editor = document.createElement("div");
    editor.id = "editor";
    document.body.appendChild(editor);

    const fake = createFakeView(doc, opts.selection);
    const findBar = initFindBar(
        () => (opts.view === undefined ? fake.view : opts.view),
        () => opts.source ?? "",
    );

    const bar = document.querySelector(".find-bar") as HTMLElement;
    const findInput = bar.querySelector('input[aria-label="Find"]') as HTMLInputElement;
    const replaceInput = bar.querySelector('input[aria-label="Replace"]') as HTMLInputElement;
    const count = bar.querySelector(".find-bar__count") as HTMLElement;
    const hint = bar.querySelector(".find-bar__hint") as HTMLElement;
    const btnReplace = bar.querySelector('button[aria-label="Replace"]') as HTMLButtonElement;
    const btnReplaceAll = bar.querySelector('button[aria-label="Replace All"]') as HTMLButtonElement;
    const btnToggle = bar.querySelector('button[aria-label="Toggle Replace"]') as HTMLButtonElement;
    const btnNext = bar.querySelector('button[aria-label="Next Match"]') as HTMLButtonElement;
    const btnPrev = bar.querySelector('button[aria-label="Previous Match"]') as HTMLButtonElement;
    const btnCase = bar.querySelector('button[aria-label="Match Case"]') as HTMLButtonElement;
    const btnWord = bar.querySelector('button[aria-label="Match Whole Word"]') as HTMLButtonElement;
    const btnRegex = bar.querySelector('button[aria-label="Use Regular Expression"]') as HTMLButtonElement;

    const docText = () => {
        const d = fake.getState().doc;
        return d.textBetween(0, d.content.size, "\n");
    };

    return {
        editor, findBar, bar, findInput, replaceInput, count, hint,
        btnReplace, btnReplaceAll, btnToggle, btnNext, btnPrev,
        btnCase, btnWord, btnRegex,
        docText,
        getState: fake.getState,
        getDispatchCount: fake.getDispatchCount,
    };
}

const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

describe("initFindBar search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // jsdom does not implement scrolling
        window.scrollTo = vi.fn();
    });

    it("opening with a query should count all matches", () => {
        const { findBar, count } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo");
        expect(count.textContent).toBe("1/2");
    });

    it("a query with no matches should show the no-results state", () => {
        const { findBar, bar, count } = setup(mkDoc(p("foo bar foo")));
        findBar.open("nope");
        expect(count.textContent).toBe("No results");
        expect(bar.classList.contains("find-bar--no-results")).toBe(true);
    });

    it("overlapping occurrences should be counted as non-overlapping matches", () => {
        const { findBar, count } = setup(mkDoc(p("aaaa")));
        findBar.open("aa");
        expect(count.textContent).toBe("1/2");
    });

    it("matches across multiple blocks should all be found", () => {
        const code = schema.node("code_block", { language: "" }, [schema.text("foo()")]);
        const { findBar, count } = setup(mkDoc(p("foo bar"), p("foo"), code));
        findBar.open("foo");
        expect(count.textContent).toBe("1/3");
    });

    it("next/prev should cycle through matches", () => {
        const { findBar, count, btnNext, btnPrev } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo");
        click(btnNext);
        expect(count.textContent).toBe("2/2");
        click(btnNext);
        expect(count.textContent).toBe("1/2");
        click(btnPrev);
        expect(count.textContent).toBe("2/2");
    });

    it("Enter and Shift+Enter in the find input should navigate matches", () => {
        const { findBar, findInput, count } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo");
        findInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        expect(count.textContent).toBe("2/2");
        findInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
        );
        expect(count.textContent).toBe("1/2");
    });

    it("Escape in the find input should close the bar", () => {
        const { findBar, findInput } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo");
        findInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        expect(findBar.isOpen()).toBe(false);
    });

    it("typing in the find input should search after the debounce delay", () => {
        vi.useFakeTimers();
        try {
            const { findBar, findInput, count } = setup(mkDoc(p("foo bar foo")));
            findBar.open();
            findInput.value = "foo";
            findInput.dispatchEvent(new Event("input", { bubbles: true }));
            expect(count.textContent).toBe("");
            vi.advanceTimersByTime(150);
            expect(count.textContent).toBe("1/2");
        } finally {
            vi.useRealTimers();
        }
    });

    it("open without a query should pre-fill from the editor selection", () => {
        // "foo bar foo": "bar" spans positions 5..8
        const { findBar, findInput, count } = setup(mkDoc(p("foo bar foo")), {
            selection: { from: 5, to: 8 },
        });
        findBar.open();
        expect(findInput.value).toBe("bar");
        expect(count.textContent).toBe("1/1");
    });

    it("open without a query or selection should keep the previous query", () => {
        const { findBar, findInput, count } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo");
        findBar.close();
        findBar.open();
        expect(findInput.value).toBe("foo");
        expect(count.textContent).toBe("1/2");
    });

    it("close should hide the bar and clear state", () => {
        const { findBar, bar, count } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo");
        findBar.close();
        expect(findBar.isOpen()).toBe(false);
        expect(bar.classList.contains("find-bar--visible")).toBe(false);
        expect(count.textContent).toBe("");
    });
});

describe("initFindBar source-based matching", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.scrollTo = vi.fn();
    });

    it("a query matching a link URL should be found", () => {
        const { findBar, count } = setup(mkDoc(p("see ", linked("docs", "https://example.com/docs"))));
        findBar.open("example.com");
        expect(count.textContent).toBe("1/1");
    });

    it("a query matching image alt text and src should count both", () => {
        const img = schema.node("image", { src: "img/cat.png", alt: "a cat photo" });
        const { findBar, count } = setup(mkDoc(p(img)));
        findBar.open("cat");
        expect(count.textContent).toBe("1/2");
    });

    it("a query matching a code fence language should be found", () => {
        const code = schema.node("code_block", { language: "javascript" }, [schema.text("let x = 1")]);
        const { findBar, count } = setup(mkDoc(code));
        findBar.open("javascript");
        expect(count.textContent).toBe("1/1");
    });

    it("pure-syntax source matches should be counted and reported in the hint", () => {
        const { findBar, count, hint } = setup(mkDoc(p("bold text")), {
            source: "**bold** text",
        });
        findBar.open("**");
        expect(count.textContent).toBe("1/2");
        expect(hint.hidden).toBe(false);
        expect(hint.textContent).toContain("2");
    });

    it("source occurrences covered by document matches should not be double counted", () => {
        const { findBar, count, hint } = setup(mkDoc(p("bold text")), {
            source: "**bold** text",
        });
        findBar.open("bold");
        expect(count.textContent).toBe("1/1");
        expect(hint.hidden).toBe(true);
    });
});

describe("initFindBar toggles", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.scrollTo = vi.fn();
    });

    it("the case toggle should switch between insensitive and exact matching", () => {
        const { findBar, count, btnCase } = setup(mkDoc(p("Foo bar foo")));
        findBar.open("foo");
        expect(count.textContent).toBe("1/2");
        click(btnCase);
        expect(count.textContent).toBe("1/1");
        expect(btnCase.getAttribute("aria-pressed")).toBe("true");
    });

    it("the whole-word toggle should exclude matches inside larger words", () => {
        const { findBar, count, btnWord } = setup(mkDoc(p("cat concatenate cat")));
        findBar.open("cat");
        expect(count.textContent).toBe("1/3");
        click(btnWord);
        expect(count.textContent).toBe("1/2");
        expect(btnWord.getAttribute("aria-pressed")).toBe("true");
    });

    it("the regex toggle should switch the query to pattern matching", () => {
        const { findBar, count, btnRegex } = setup(mkDoc(p("foo123 bar456")));
        findBar.open("[a-z]+\\d+");
        expect(count.textContent).toBe("No results");
        click(btnRegex);
        expect(count.textContent).toBe("1/2");
        expect(btnRegex.getAttribute("aria-pressed")).toBe("true");
    });

    it("an invalid regex should show the invalid state instead of throwing", () => {
        const { findBar, bar, count, findInput, btnRegex } = setup(mkDoc(p("foo")));
        findBar.open("(");
        click(btnRegex);
        expect(count.textContent).toBe("Invalid pattern");
        expect(bar.classList.contains("find-bar--invalid")).toBe(true);
        expect(findInput.getAttribute("aria-invalid")).toBe("true");
        // toggling regex off restores literal matching
        click(btnRegex);
        expect(bar.classList.contains("find-bar--invalid")).toBe(false);
        expect(count.textContent).toBe("No results");
    });
});

describe("initFindBar replace", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.scrollTo = vi.fn();
    });

    it("toggle button should show and hide the replace row", () => {
        const { findBar, bar, btnToggle } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo");
        expect(bar.classList.contains("find-bar--replace-visible")).toBe(false);
        click(btnToggle);
        expect(bar.classList.contains("find-bar--replace-visible")).toBe(true);
        expect(btnToggle.getAttribute("aria-expanded")).toBe("true");
        click(btnToggle);
        expect(bar.classList.contains("find-bar--replace-visible")).toBe(false);
    });

    it("open with showReplace should expand the replace row", () => {
        const { findBar, bar } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo", { showReplace: true });
        expect(bar.classList.contains("find-bar--replace-visible")).toBe(true);
    });

    it("replace should substitute the current match and move to the next one", () => {
        const { findBar, replaceInput, count, btnReplace, docText } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "baz";
        click(btnReplace);
        expect(docText()).toBe("baz bar foo");
        expect(count.textContent).toBe("1/1");
    });

    it("replacement text containing the query should not be matched again", () => {
        const { findBar, replaceInput, count, btnReplace, docText } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "foofoo";
        click(btnReplace);
        expect(docText()).toBe("foofoo bar foo");
        // 3 matches now, but the current one advanced past the inserted text
        expect(count.textContent).toBe("3/3");
    });

    it("Enter in the replace input should replace the current match", () => {
        const { findBar, replaceInput, docText } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "qux";
        replaceInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        expect(docText()).toBe("qux bar foo");
    });

    it("Mod+Enter in the replace input should replace all matches", () => {
        const { findBar, replaceInput, docText } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "baz";
        replaceInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
        );
        expect(docText()).toBe("baz bar baz");
    });

    it("Escape in the replace input should close the bar", () => {
        const { findBar, replaceInput } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo", { showReplace: true });
        replaceInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        expect(findBar.isOpen()).toBe(false);
    });

    it("replace all should substitute every match in one dispatched transaction", () => {
        const { findBar, replaceInput, count, btnReplaceAll, docText, getDispatchCount } =
            setup(mkDoc(p("foo bar foo"), p("foo")));
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "baz";
        click(btnReplaceAll);
        expect(docText()).toBe("baz bar baz\nbaz");
        expect(getDispatchCount()).toBe(1);
        expect(count.textContent).toBe("No results");
    });

    it("replace all with an empty replacement should delete all matches", () => {
        const { findBar, replaceInput, btnReplaceAll, docText } = setup(mkDoc(p("foo bar foo")));
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "";
        click(btnReplaceAll);
        expect(docText()).toBe(" bar ");
    });

    it("replace without an editor view should leave the document unchanged", () => {
        const { findBar, replaceInput, btnReplace, docText } = setup(mkDoc(p("foo bar foo")), { view: null });
        findBar.open("foo", { showReplace: true });
        replaceInput.value = "baz";
        click(btnReplace);
        expect(docText()).toBe("foo bar foo");
    });

    it("replace on a link URL match should rewrite the href attribute", () => {
        const { findBar, replaceInput, btnReplace, getState } = setup(
            mkDoc(p(linked("click", "http://old.com/x"))),
        );
        findBar.open("old", { showReplace: true });
        replaceInput.value = "new";
        click(btnReplace);
        let href = "";
        getState().doc.descendants((node) => {
            const mark = node.marks.find((m: Mark) => m.type.name === "link");
            if (mark) {
                href = mark.attrs["href"] as string;
            }
        });
        expect(href).toBe("http://new.com/x");
    });

    it("replace all should rewrite text and attribute matches together", () => {
        const img = schema.node("image", { src: "img/cat.png", alt: "a cat photo" });
        const { findBar, replaceInput, btnReplaceAll, getState, getDispatchCount, docText } = setup(
            mkDoc(p("the cat sat"), p(img)),
        );
        findBar.open("cat", { showReplace: true });
        replaceInput.value = "dog";
        click(btnReplaceAll);
        expect(getDispatchCount()).toBe(1);
        expect(docText()).toContain("the dog sat");
        let attrs: Record<string, unknown> = {};
        getState().doc.descendants((node) => {
            if (node.type.name === "image") {
                attrs = node.attrs;
            }
        });
        expect(attrs["src"]).toBe("img/dog.png");
        expect(attrs["alt"]).toBe("a dog photo");
    });

    it("replace on a code fence language match should rewrite the language attribute", () => {
        const code = schema.node("code_block", { language: "javascript" }, [schema.text("let x")]);
        const { findBar, replaceInput, btnReplace, getState } = setup(mkDoc(code));
        findBar.open("javascript", { showReplace: true });
        replaceInput.value = "typescript";
        click(btnReplace);
        expect(getState().doc.firstChild?.attrs["language"]).toBe("typescript");
    });

    it("regex replace should expand $n group references", () => {
        const { findBar, replaceInput, btnRegex, btnReplaceAll, docText } = setup(
            mkDoc(p("foo123 bar456")),
        );
        findBar.open("([a-z]+)(\\d+)", { showReplace: true });
        click(btnRegex);
        replaceInput.value = "$2-$1";
        click(btnReplaceAll);
        expect(docText()).toBe("123-foo 456-bar");
    });

    it("replace all should skip syntax matches and keep the hint visible", () => {
        const { findBar, replaceInput, btnReplaceAll, hint, getDispatchCount, count } = setup(
            mkDoc(p("bold text")),
            { source: "**bold** text" },
        );
        findBar.open("**", { showReplace: true });
        expect(count.textContent).toBe("1/2");
        replaceInput.value = "__";
        click(btnReplaceAll);
        // nothing replaceable: no transaction dispatched, hint stays
        expect(getDispatchCount()).toBe(0);
        expect(hint.hidden).toBe(false);
    });

    it("replace on a syntax match should skip to the next match without dispatching", () => {
        const { findBar, replaceInput, btnReplace, count, getDispatchCount } = setup(
            mkDoc(p("bold text")),
            { source: "**bold** text" },
        );
        findBar.open("**", { showReplace: true });
        expect(count.textContent).toBe("1/2");
        replaceInput.value = "!!";
        click(btnReplace);
        // syntax matches only exist in the raw source: nothing is dispatched,
        // the cursor just moves on to the next match
        expect(getDispatchCount()).toBe(0);
        expect(count.textContent).toBe("2/2");
    });
});
