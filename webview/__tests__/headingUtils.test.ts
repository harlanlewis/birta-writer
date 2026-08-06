/**
 * headingUtils tests: getTopbarBottom must honor the toolbar-hidden contract
 * (body.toolbar-hidden ⇒ 0, mirroring --editor-topbar-height: 0px) and stay
 * immune to the topbar's slide transition — translateY moves the rect's
 * bottom while it animates, but never its height.
 *
 * The scroll-path suites below assert COST, not just answers: these functions
 * run on every scroll frame, and each of them used to re-derive from scratch
 * work that scales with the document (MAR-316). An answer-only test passes
 * equally well on the version that walks the whole document, so what is pinned
 * here is how many times each one asks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    getTopbarBottom,
    scrollElementBelowTopbar,
    getAllHeadings,
    getVisibleHeadings,
    findHeadingPos,
    findActiveHeading,
} from "../utils/headingUtils";

function addTopbar(rect: { height: number; bottom: number }): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    topbar.getBoundingClientRect = () =>
        ({ x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, ...rect }) as DOMRect;
    document.body.appendChild(topbar);
    return topbar;
}

describe("getTopbarBottom", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        document.body.className = "";
    });

    it("a visible topbar should report its measured height", () => {
        addTopbar({ height: 40, bottom: 40 });
        expect(getTopbarBottom()).toBe(40);
    });

    it("a topbar still sliding in (stale rect bottom) should still report its height", () => {
        // Mid show-transition the bar is translated up, so bottom reads ~0
        addTopbar({ height: 40, bottom: 0 });
        expect(getTopbarBottom()).toBe(40);
    });

    it("body.toolbar-hidden should return 0 even while the rect reports the old geometry", () => {
        addTopbar({ height: 40, bottom: 40 });
        document.body.classList.add("toolbar-hidden");
        expect(getTopbarBottom()).toBe(0);
    });

    it("no topbar in the DOM should fall back to 40", () => {
        expect(getTopbarBottom()).toBe(40);
    });
});

describe("scrollElementBelowTopbar", () => {
    const scrollTo = vi.fn();

    function elementAt(top: number): HTMLElement {
        const el = document.createElement("h2");
        el.getBoundingClientRect = () =>
            ({ x: 0, y: top, top, left: 0, right: 0, bottom: top + 30, width: 0, height: 30 }) as DOMRect;
        document.body.appendChild(el);
        return el;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        document.body.className = "";
        vi.stubGlobal("scrollTo", scrollTo);
        vi.stubGlobal("scrollY", 100);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("a visible toolbar should reserve the bar height plus the margin", () => {
        addTopbar({ height: 40, bottom: 40 });
        scrollElementBelowTopbar(elementAt(500));
        expect(scrollTo).toHaveBeenCalledWith({ top: 500 + 100 - 40 - 8, behavior: "smooth" });
    });

    it("a hidden toolbar should reserve only the margin", () => {
        addTopbar({ height: 40, bottom: 40 });
        document.body.classList.add("toolbar-hidden");
        scrollElementBelowTopbar(elementAt(500), 12);
        expect(scrollTo).toHaveBeenCalledWith({ top: 500 + 100 - 12, behavior: "smooth" });
    });

    it("a target above the document start should clamp to 0", () => {
        addTopbar({ height: 40, bottom: 40 });
        scrollElementBelowTopbar(elementAt(-500));
        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    });

    it("an explicit behavior should pass through to scrollTo", () => {
        addTopbar({ height: 40, bottom: 40 });
        scrollElementBelowTopbar(elementAt(500), 60, "auto");
        expect(scrollTo).toHaveBeenCalledWith({ top: 500 + 100 - 40 - 60, behavior: "auto" });
    });
});

// ── The scroll path ─────────────────────────────────────────
// A real Milkdown editor, because what is under test is the relationship
// between heading ELEMENTS and heading POSITIONS, and only a real view holds
// both. jsdom reports every rect as zero, so anything reading geometry stubs
// getBoundingClientRect per element.

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Place `el` at `top` in the viewport; jsdom otherwise reports 0×0, which the
 *  visibility filter reads as hidden. */
function placeAt(el: HTMLElement, top: number): void {
    el.getBoundingClientRect = () =>
        ({ x: 0, y: top, top, left: 0, right: 100, bottom: top + 30, width: 100, height: 30 }) as DOMRect;
}

const SIX_HEADINGS = "# One\n\ntext\n\n## Two\n\ntext\n\n## Three\n\ntext\n\n## Four\n\ntext\n\n## Five\n\ntext\n\n## Six\n\ntext\n";

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("findHeadingPos", () => {
    it("a heading the view renders should resolve without searching the document", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        const headings = getAllHeadings(view);
        expect(headings).toHaveLength(6);

        // The search this replaced visited every node in the document and called
        // view.nodeDOM once per heading it passed. Reverting the posAtDOM fast
        // path puts both back and fails here.
        const descendants = vi.spyOn(view.state.doc, "descendants");
        const positions = headings.map((h) => findHeadingPos(view, h));

        expect(descendants).not.toHaveBeenCalled();
        expect(positions.every((pos) => pos !== null)).toBe(true);
        for (const [i, pos] of positions.entries()) {
            expect(view.state.doc.nodeAt(pos!)?.type.name).toBe("heading");
            expect(view.nodeDOM(pos!)).toBe(headings[i]);
        }
    });

    it("a heading nested inside another block should resolve the same way", async () => {
        // The fast path reads a position out of the DOM, so it is the nesting
        // depth that could break it — and headings inside list items and
        // blockquotes are real enough that the fold plugin carries cases for
        // them.
        //
        // Comparing the answer against the document search is NOT enough on its
        // own, and the first version of this test did only that and could not
        // fail. findHeadingPos verifies its own candidate and falls through to
        // that same search when the check fails, so the two agree by
        // construction however wrong the fast path is: breaking it for depth > 1
        // headings specifically left the whole file green. What makes this bite
        // is asserting the search never RAN.
        const view = await makeEditor("> # Quoted\n>\n> text\n\n- # In a list\n\n  body\n\n# Top level\n");
        const headings = getAllHeadings(view);
        // Guard against a vacuous run: if the parser flattened the fixture,
        // every heading would sit at depth 1 and this would be the top-level
        // case again under a different name.
        const depths = headings.map((h) => findHeadingPos(view, h)).map((pos) => view.state.doc.resolve(pos!).depth);
        expect(Math.max(...depths)).toBeGreaterThan(1);
        expect(headings.length).toBeGreaterThanOrEqual(2);

        const descendants = vi.spyOn(view.state.doc, "descendants");
        const fastAnswers = headings.map((h) => findHeadingPos(view, h));
        expect(descendants).not.toHaveBeenCalled();
        descendants.mockRestore();

        for (const [i, heading] of headings.entries()) {
            const fast = fastAnswers[i];
            let search: number | null = null;
            view.state.doc.descendants((node, pos) => {
                if (node.type.name === "heading" && view.nodeDOM(pos) === heading) {
                    search = pos;
                    return false;
                }
                return true;
            });
            expect(fast).toBe(search);
            expect(fast).not.toBeNull();
        }
    });

    it("a heading element the view does not render should still resolve to null", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        const stray = document.createElement("h2");
        stray.textContent = "Not in this document";
        document.body.appendChild(stray);

        // posAtDOM throws for an element outside the view; the answer must be
        // the same null the document search gave, not the throw.
        expect(findHeadingPos(view, stray)).toBeNull();
    });
});

describe("findActiveHeading", () => {
    it("many headings above the threshold should still resolve exactly one position", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        const headings = getAllHeadings(view);
        headings.forEach((h, i) => placeAt(h, -500 + i * 10)); // all above the threshold

        const posAtDOM = vi.spyOn(view, "posAtDOM");
        const result = findActiveHeading(view, 0, false);

        // The old loop resolved a position per candidate, so scrolling deeper
        // into a document cost strictly more per frame.
        expect(posAtDOM).toHaveBeenCalledTimes(1);
        expect(result?.element).toBe(headings[5]);
    });

    it("the last candidate should yield to the one before it when the document cannot place it", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        // A heading element inside the editor that no document node backs —
        // the case the old code's "keep the last one that resolved" handled.
        // Appended before the first read: the cache is keyed on the document,
        // so an element that appears without an edit is invisible to it, which
        // is sound for real headings (a heading element exists only because a
        // heading node does) and is why this fixture has to be built first.
        const stray = document.createElement("h3");
        stray.textContent = "Orphan";
        view.dom.appendChild(stray);

        const headings = getAllHeadings(view);
        expect(headings).toHaveLength(7);
        expect(headings[6]).toBe(stray);
        headings.forEach((h, i) => placeAt(h, -500 + i * 10));

        const result = findActiveHeading(view, 0, false);
        expect(result?.element).toBe(headings[5]);
        expect(result?.pos).toBe(findHeadingPos(view, headings[5]));
    });
});

describe("the heading element cache", () => {
    it("a second read against the same document should not re-query the DOM", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        getAllHeadings(view);
        const query = vi.spyOn(view.dom, "querySelectorAll");

        expect(getAllHeadings(view)).toHaveLength(6);
        expect(getVisibleHeadings(view)).toHaveLength(0); // jsdom: every rect is 0×0
        expect(query).not.toHaveBeenCalled();
    });

    it("an edit should re-query, so a new heading is visible to the next read", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        expect(getAllHeadings(view)).toHaveLength(6);

        view.dispatch(view.state.tr.insert(view.state.doc.content.size, view.state.schema.nodes["heading"]!
            .create({ level: 2 }, view.state.schema.text("Seven"))));

        expect(getAllHeadings(view)).toHaveLength(7);
    });

    it("an inline edit in a paragraph should retain the cached elements without re-querying", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        const before = getAllHeadings(view);
        const query = vi.spyOn(view.dom, "querySelectorAll");

        // Locate the paragraph after the first heading and type into it — the
        // per-keystroke shape whose re-query cost this cache exists to remove
        // (MAR-137).
        view.dispatch(view.state.tr.insertText("X", view.state.doc.child(0).nodeSize + 2));

        const after = getAllHeadings(view);
        expect(query).not.toHaveBeenCalled();
        expect(after).toEqual(before);
    });

    it("splitting a paragraph should retain the cached elements without re-querying", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        const before = getAllHeadings(view);
        const query = vi.spyOn(view.dom, "querySelectorAll");

        // The Enter shape: a structural edit that still touches no heading.
        view.dispatch(view.state.tr.split(view.state.doc.child(0).nodeSize + 2));

        expect(getAllHeadings(view)).toEqual(before);
        expect(query).not.toHaveBeenCalled();
    });

    it("deleting a heading should shrink the set on the next read", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        expect(getAllHeadings(view)).toHaveLength(6);
        const { doc } = view.state;
        // Third child is the "## Two" heading (heading, p, heading, p, …).
        const pos = doc.child(0).nodeSize + doc.child(1).nodeSize;

        view.dispatch(view.state.tr.delete(pos, pos + doc.child(2).nodeSize));

        expect(getAllHeadings(view)).toHaveLength(5);
    });

    it("changing a heading's level should serve the rebuilt element, not the stale one", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        getAllHeadings(view);
        const pos = view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize;

        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { level: 4 }));

        expect(getAllHeadings(view).map((el) => el.tagName)).toContain("H4");
    });

    it("a heading element rebuilt without an edit should be dropped rather than served detached", async () => {
        const view = await makeEditor(SIX_HEADINGS);
        const before = getAllHeadings(view);

        // What a decoration-only re-render leaves behind: the cached element is
        // detached and a new one stands in its place, with the document
        // unchanged. Without the isConnected check the cache keeps serving the
        // detached one, and every position resolved from it is null.
        const replacement = document.createElement("h2");
        replacement.textContent = before[2].textContent;
        before[2].replaceWith(replacement);

        const after = getAllHeadings(view);
        expect(after).toHaveLength(6);
        expect(after[2]).toBe(replacement);
        expect(after.some((el) => !el.isConnected)).toBe(false);
    });
});
