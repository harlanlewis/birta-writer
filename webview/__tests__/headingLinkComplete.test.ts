/**
 * headingLinkComplete tests: the caret-anchored heading dropdown that opens
 * while typing `#` mid-prose (never at a line start, where `#` is heading
 * syntax — except via the section-link command's armed one-shot), filters as
 * the user types, and converts the construct into a plain `[title](#slug)`
 * link on pick. Drives the REAL Milkdown editor; suggestions are local
 * (document headings), so nothing is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    headingLinkCompletePlugin,
    armBlockStartHeadingComplete,
    PARTIAL_HEADING_REGEX,
} from "../plugins/headingLinkComplete";
import { pendingRangePlugin } from "../plugins/pendingRange";
import { collectHeadingSuggestions } from "../utils/headingSuggest";

const DOC = "# Living calculations\n\n## Overview\n\n## Overview\n\nx\n";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(pendingRangePlugin)
        .use(headingLinkCompletePlugin)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function placeCursorAtEnd(v: EditorView): void {
    const end = v.state.doc.content.size - 1;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)));
}

function typeText(v: EditorView, text: string): void {
    const { from, to } = v.state.selection;
    v.dispatch(v.state.tr.insertText(text, from, to));
}

function optionTexts(): string[] {
    return Array.from(
        document.querySelectorAll(".fm-suggest-menu .fm-suggest-item"),
    ).map((li) => li.textContent ?? "");
}

describe("PARTIAL_HEADING_REGEX", () => {
    it("should match a whitespace-preceded # construct only", () => {
        expect(PARTIAL_HEADING_REGEX.exec("see #over")?.[1]).toBe("over");
        expect(PARTIAL_HEADING_REGEX.exec("see #")?.[1]).toBe("");
        expect(PARTIAL_HEADING_REGEX.exec("#over")).toBeNull(); // line start
        expect(PARTIAL_HEADING_REGEX.exec("a#b")).toBeNull(); // glued to a word
        expect(PARTIAL_HEADING_REGEX.exec("see ##x")).toBeNull(); // double #
        expect(PARTIAL_HEADING_REGEX.exec("see #a b")).toBeNull(); // space ended it
    });
});

describe("caret heading autocompletion", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        delete window.__i18n;
        editor = await makeEditor(DOC);
        v = view(editor);
        placeCursorAtEnd(v);
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("collectHeadingSuggestions should enumerate the doc's addressable headings", () => {
        const got = collectHeadingSuggestions(v.state.doc);
        expect(got).toEqual([
            { title: "Living calculations", slug: "living-calculations", level: 1 },
            { title: "Overview", slug: "overview", level: 2 },
            { title: "Overview", slug: "overview-1", level: 2 },
        ]);
    });

    it("typing a whitespace-preceded # should list every heading (browse state)", async () => {
        typeText(v, " #");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([
            "Living calculations",
            "  Overview",
            "  Overview (2)",
        ]);
        // The teaching footer mirrors the slash menu.
        expect(document.querySelector(".fm-suggest-footer")?.textContent).toBe("Type to filter");
    });

    it("typing narrows the list (type-to-filter)", async () => {
        typeText(v, " #over");
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual(["  Overview", "  Overview (2)"]);
    });

    it("the open menu should chip-decorate the typed construct", async () => {
        typeText(v, " #over");
        await vi.advanceTimersByTimeAsync(250);

        const chip = document.querySelector(".ProseMirror .slash-query");
        expect(chip?.textContent).toBe("#over");
    });

    it("picking should replace the construct with a [title](#slug) link", async () => {
        typeText(v, " #over");
        await vi.advanceTimersByTimeAsync(250);

        const li = Array.from(
            document.querySelectorAll(".fm-suggest-menu .fm-suggest-item"),
        ).find((el) => el.textContent === "  Overview (2)")!;
        li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(editor.action(getMarkdown())).toContain("x [Overview](#overview-1)");
    });

    it("an open menu should hold its highlight and DOM through idle time (no rebuild churn)", async () => {
        typeText(v, " #");
        await vi.advanceTimersByTimeAsync(250);
        const menuBefore = document.querySelector(".fm-suggest-menu");
        expect(menuBefore).not.toBeNull();

        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        expect(
            document.querySelector(".fm-suggest-item--focused")?.textContent,
        ).toBe("Living calculations");

        // The chip decoration dispatches meta transactions; they must not
        // restart the fetch debounce and rebuild the menu — a rebuild resets
        // the arrow highlight and the list's scroll position (user-reported).
        await vi.advanceTimersByTimeAsync(1000);
        expect(document.querySelector(".fm-suggest-menu")).toBe(menuBefore);
        expect(
            document.querySelector(".fm-suggest-item--focused")?.textContent,
        ).toBe("Living calculations");
    });

    it("typing after a pick should continue OUTSIDE the link", async () => {
        typeText(v, " #over");
        await vi.advanceTimersByTimeAsync(250);
        const li = Array.from(
            document.querySelectorAll(".fm-suggest-menu .fm-suggest-item"),
        ).find((el) => el.textContent === "  Overview")!;
        li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(editor.action(getMarkdown())).toContain("x [Overview](#overview)");

        // Simulate typing at the caret (inherits marks the way real input
        // does): the next characters must be plain text, not link extension.
        v.dispatch(v.state.tr.insertText("etc"));

        expect(editor.action(getMarkdown())).toContain("[Overview](#overview)etc");
        expect(editor.action(getMarkdown())).not.toContain("[Overviewetc]");
    });

    it("a pick inside styled prose should keep the surrounding marks", async () => {
        typeText(v, " #over");
        // Embolden the construct's context, as if the user typed inside bold.
        const strong = v.state.schema.marks["strong"];
        const end = v.state.selection.from;
        v.dispatch(v.state.tr.addMark(end - 6, end, strong.create()));
        await vi.advanceTimersByTimeAsync(250);

        const li = Array.from(
            document.querySelectorAll(".fm-suggest-menu .fm-suggest-item"),
        ).find((el) => el.textContent === "\u00a0\u00a0Overview")!;
        li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        let marks: string[] = [];
        v.state.doc.descendants((node) => {
            if (node.isText && node.text === "Overview" && node.marks.length > 0) {
                marks = node.marks.map((m) => m.type.name).sort();
            }
        });
        expect(marks).toEqual(["link", "strong"]);
    });

    it("an exact query match should never force or auto-insert", async () => {
        typeText(v, " #living-calculations");
        await vi.advanceTimersByTimeAsync(250);

        // The menu is open with the exact match, but the document still holds
        // the user's own text and no link was created.
        expect(optionTexts()).toEqual(["Living calculations"]);
        expect(editor.action(getMarkdown())).toContain("x #living-calculations");
        expect(editor.action(getMarkdown())).not.toContain("](#living-calculations)");
    });

    it("a line-start # should not open the menu (heading syntax)", async () => {
        // Replace the trailing "x" paragraph's text with "#th" — the construct
        // then sits at the block start.
        const end = v.state.doc.content.size - 1;
        v.dispatch(v.state.tr.insertText("#th", end - 1, end));
        await vi.advanceTimersByTimeAsync(250);

        expect(document.querySelector(".fm-suggest-menu")).toBeNull();
    });

    it("the armed one-shot should allow the section-link command's block-start #", async () => {
        const end = v.state.doc.content.size - 1;
        armBlockStartHeadingComplete();
        v.dispatch(v.state.tr.insertText("#", end - 1, end));
        await vi.advanceTimersByTimeAsync(250);

        expect(optionTexts()).toEqual([
            "Living calculations",
            "  Overview",
            "  Overview (2)",
        ]);
    });

    it("Escape should dismiss without inserting and suppress until the caret leaves", async () => {
        typeText(v, " #over");
        await vi.advanceTimersByTimeAsync(250);
        expect(optionTexts().length).toBeGreaterThan(0);

        v.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(document.querySelector(".fm-suggest-menu")).toBeNull();

        // Typing on inside the same construct stays suppressed.
        typeText(v, "v");
        await vi.advanceTimersByTimeAsync(250);
        expect(document.querySelector(".fm-suggest-menu")).toBeNull();
        expect(editor.action(getMarkdown())).toContain("x #overv");
    });
});
