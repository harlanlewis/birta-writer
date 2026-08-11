/**
 * Tests for the sticky heading's gutter DOM contract (plugins/headingSticky):
 * the H-badge is a functional block handle — a real button that opens the
 * block menu for the live heading position — not a display-only span. The
 * scroll-driven positioning itself needs real layout and is covered by the
 * e2e harness, not jsdom.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin, headingFoldPluginKey } from "../plugins/headingFold";
import { setStickyContent, headingStickyPlugin, stickyHeadingFoldable } from "../plugins/headingSticky";
import { setBlockMenuContext, closeBlockMenu } from "../components/blockMenu";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

setBlockMenuContext({ getEditor: () => activeEditor });

async function makeEditor(markdown: string): Promise<Editor> {
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
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** First heading's node position in a doc that starts with a heading. */
const FIRST_HEADING_POS = 0;

function makeSticky(editorView: EditorView, headingPos: number): HTMLElement {
    const sticky = document.createElement("div");
    sticky.className = "heading-sticky-title";
    sticky.dataset["headingPos"] = String(headingPos);
    document.body.appendChild(sticky);
    const heading = editorView.nodeDOM(headingPos) as HTMLElement;
    setStickyContent(sticky, editorView, heading, headingPos, false, true);
    return sticky;
}

afterEach(() => {
    vi.unstubAllGlobals();
    closeBlockMenu();
    for (const editor of editors) {
        void editor.destroy();
    }
    editors = [];
    activeEditor = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("sticky heading gutter", () => {
    it("a sticky heading should render its badge as a block-handle button", async () => {
        const editor = await makeEditor("## Section\n\nBody text.");
        const sticky = makeSticky(view(editor), FIRST_HEADING_POS);

        const marker = sticky.querySelector(".heading-sticky-marker");
        expect(marker).toBeInstanceOf(HTMLButtonElement);
        expect(marker?.textContent).toBe("H2");
        expect(marker?.getAttribute("aria-haspopup")).toBe("menu");
        expect(marker?.getAttribute("aria-label")).toContain("Block options");
        expect(marker?.getAttribute("aria-expanded")).toBe("false");
    });

    it("clicking the sticky badge should open the block menu anchored to it", async () => {
        const editor = await makeEditor("## Section\n\nBody text.");
        const sticky = makeSticky(view(editor), FIRST_HEADING_POS);
        const marker = sticky.querySelector<HTMLButtonElement>(".heading-sticky-marker");

        marker?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));

        expect(document.querySelector(".block-menu")).not.toBeNull();
        expect(marker?.classList.contains("heading-fold-marker--menu-open")).toBe(true);
        expect(marker?.getAttribute("aria-expanded")).toBe("true");
    });

    it("clicking the sticky title text should scroll to the heading and place the caret in it", async () => {
        const editor = await makeEditor("## Section\n\nBody text.");
        const editorView = view(editor);
        // Park the selection away from the heading so the click's caret move is observable.
        const paragraphPos = FIRST_HEADING_POS + editorView.state.doc.child(0).nodeSize;
        editorView.dispatch(editorView.state.tr.setSelection(
            TextSelection.create(editorView.state.doc, paragraphPos + 1),
        ));
        const sticky = makeSticky(editorView, FIRST_HEADING_POS);
        // Run the post-scroll caret placement synchronously, and absorb the
        // window scroll jsdom can't perform.
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            cb(0);
            return 0;
        });
        const scrollTo = vi.fn();
        vi.stubGlobal("scrollTo", scrollTo);
        const label = sticky.querySelector<HTMLElement>(".heading-sticky-text");

        label?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 40 }));

        // The heading is scrolled below the topbar…
        expect(scrollTo).toHaveBeenCalled();
        // …and the caret lands inside the heading (jsdom has no layout, so
        // coordinate resolution falls back to the heading's start).
        expect(editorView.state.selection.from).toBe(FIRST_HEADING_POS + 1);
        expect(editorView.state.selection.empty).toBe(true);
    });

    it("the sticky badge click should derive the heading position from data-heading-pos at click time", async () => {
        const editor = await makeEditor("## Section\n\nBody text.");
        const editorView = view(editor);
        // Simulate the captured pos going stale: point data-heading-pos at a
        // paragraph so a stale-captured-pos menu (heading rows) and a live-pos
        // menu (no heading conversion for itself) would differ; the menu must
        // open without throwing on the refreshed position.
        const sticky = makeSticky(editorView, FIRST_HEADING_POS);
        const paragraphPos = FIRST_HEADING_POS + editorView.state.doc.child(0).nodeSize;
        sticky.dataset["headingPos"] = String(paragraphPos);
        const marker = sticky.querySelector<HTMLButtonElement>(".heading-sticky-marker");

        marker?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));

        expect(document.querySelector(".block-menu")).not.toBeNull();
    });
});

/**
 * The sticky chevron's foldability question. The bar must offer the fold
 * toggle only where the fold plugin would honor it: a heading nested inside
 * a blockquote or callout cannot fold (heading folds are keyed by top-level
 * offset), so a chevron there would dispatch a toggle the plugin refuses —
 * a control that always reads "Collapse content" and never does anything.
 */
describe("sticky heading foldability", () => {
    it("a top-level heading with a body should offer the fold chevron", async () => {
        const editor = await makeEditor("## Section\n\nBody text.");
        const v = view(editor);

        expect(stickyHeadingFoldable(v.state, FIRST_HEADING_POS)).toBe(true);
    });

    it("a heading nested inside a blockquote should offer no chevron", async () => {
        const editor = await makeEditor("> ## Quoted\n\nBody after the quote.");
        const v = view(editor);
        const headingPos = FIRST_HEADING_POS + 1; // inside the blockquote
        expect(v.state.doc.nodeAt(headingPos)?.type.name).toBe("heading");

        expect(stickyHeadingFoldable(v.state, headingPos)).toBe(false);
    });
});

/**
 * When the sticky plugin RESCANS (MAR-266).
 *
 * updateSticky is O(headings in the document) and forces a layout on each one,
 * so what schedules it is a performance contract, not an implementation detail.
 * Running it on every view update, or on every body-class mutation, puts that
 * whole cost on every caret move and every keystroke — the fold plugin writes
 * `handles-quiet` on every keydown.
 *
 * These assert the SCHEDULING, because that is what regresses. The positioning
 * itself needs real layout and lives in the e2e harness.
 */
describe("sticky heading rescan scheduling", () => {
    /** Deterministic rAF: the plugin coalesces on a pending frame, so a test
     *  that let jsdom's timer-backed rAF fire on its own would race it. */
    function stubRaf(): { pending: () => number; flush: () => void } {
        let queue: FrameRequestCallback[] = [];
        let id = 0;
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            queue.push(cb);
            return ++id;
        });
        vi.stubGlobal("cancelAnimationFrame", () => {});
        return {
            pending: () => queue.length,
            flush: () => {
                const due = queue;
                queue = [];
                for (const cb of due) {
                    cb(0);
                }
            },
        };
    }

    /**
     * `withFold: false` is not tidiness — it is what makes the doc-change
     * assertion mean anything. The fold plugin hands out a fresh `folded` set
     * on every doc change, so with it installed the fold branch fires on a doc
     * edit too and a test asserting "a doc change schedules a rescan" passes
     * with the doc branch deleted. Dropping the plugin leaves both fold reads
     * undefined, so only the doc branch can answer.
     */
    async function mountSticky(markdown: string, withFold = true) {
        const raf = stubRaf();
        const root = document.createElement("div");
        document.body.appendChild(root);
        let make = Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, markdown);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity);
        if (withFold) {
            make = make.use(headingFoldPlugin);
        }
        const editor = await make
            .use(headingStickyPlugin)
            .create();
        editors.push(editor);
        activeEditor = editor;
        const editorView = view(editor);
        raf.flush(); // drain the mount-time scan
        return { editorView, raf };
    }

    const DOC = "# One\n\nAlpha.\n\n## Two\n\nBeta.\n";

    it("a selection-only transaction should schedule no rescan", async () => {
        const { editorView, raf } = await mountSticky(DOC);

        editorView.dispatch(
            editorView.state.tr.setSelection(
                TextSelection.near(editorView.state.doc.resolve(3)),
            ),
        );

        expect(raf.pending()).toBe(0);
    });

    it("a doc change should schedule a rescan with no fold plugin to mask it", async () => {
        const { editorView, raf } = await mountSticky(DOC, false);

        editorView.dispatch(editorView.state.tr.insertText("x", 3));

        expect(raf.pending()).toBe(1);
    });

    it("a selection-only transaction should schedule no rescan without the fold plugin either", async () => {
        const { editorView, raf } = await mountSticky(DOC, false);

        editorView.dispatch(
            editorView.state.tr.setSelection(
                TextSelection.near(editorView.state.doc.resolve(3)),
            ),
        );

        expect(raf.pending()).toBe(0);
    });

    it("a fold toggle should schedule a rescan even though the doc is unchanged", async () => {
        const { editorView, raf } = await mountSticky(DOC);
        const docBefore = editorView.state.doc;

        editorView.dispatch(
            editorView.state.tr.setMeta(headingFoldPluginKey, { type: "toggle", pos: 0 }),
        );

        // The branch this pins exists precisely because collapsing a section
        // changes the VISIBLE heading set without touching the document.
        expect(editorView.state.doc).toBe(docBefore);
        expect(raf.pending()).toBeGreaterThan(0);
    });

    it("re-writing a body class that leaves the topbar in place should schedule no rescan", async () => {
        const { raf } = await mountSticky(DOC);

        // Exactly what the fold plugin does on every keydown — and classList.add
        // re-writes the attribute (firing the observer) even when the class is
        // already there, which is why the observer cannot simply trust the event.
        document.body.classList.add("handles-quiet");
        await Promise.resolve();
        document.body.classList.add("handles-quiet");
        await Promise.resolve();

        expect(raf.pending()).toBe(0);
    });

    it("a body class that moves the topbar should schedule a rescan", async () => {
        const { raf } = await mountSticky(DOC);

        // getTopbarBottom returns 0 for a hidden toolbar and the bar's height
        // otherwise, so this is the one body-class change the sticky depends on.
        document.body.classList.add("toolbar-hidden");
        await Promise.resolve();

        expect(raf.pending()).toBeGreaterThan(0);
    });
});
