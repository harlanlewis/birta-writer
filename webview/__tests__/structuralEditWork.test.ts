/**
 * What a STRUCTURAL edit costs, held as counts (MAR-438).
 *
 * The sibling of perKeystrokeWork.test.ts, and it asks the same question of a
 * different gesture. A keystroke inside one textblock has fast paths all over
 * this editor; a paste, a block split, or Mod+A is what defeats them, and the
 * passes that then fall back to a whole-document walk are what a long document
 * feels. Each case here is a DIFFERENTIAL between two fixtures whose only
 * difference is size, so it needs no stored figure and cannot go stale, and
 * each asserts its own reach first: an instrument that measured nothing would
 * satisfy every "did not grow" comparison by having no numbers to compare.
 *
 * Counts, never durations. The machine these run on is shared, and what a pass
 * VISITS does not depend on machine load.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView, Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { foldPluginKey, headingFoldPlugin, foldRevealKeymapPlugin } from "../plugins/headingFold";
import { blockKeysPlugin, handleBlockKeydown } from "../plugins/blockKeys";
import { cachedScanNotes, scanNotes, incrementalScanNotes } from "../notes/scan";

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
        .use(foldRevealKeymapPlugin)
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(blockKeysPlugin)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

afterEach(async () => {
    vi.restoreAllMocks();
    for (const e of editors) { await e.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

beforeAll(() => {
    if (typeof globalThis.ResizeObserver === "undefined") {
        globalThis.ResizeObserver = class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        } as unknown as typeof ResizeObserver;
    }
});

type Counter = { name: string; amounts: Record<string, number> };

/** Counters stamped while `fn` runs, captured at the call (see perKeystrokeWork.test.ts). */
function counting(fn: () => void): Counter[] {
    const seen: Counter[] = [];
    const original = performance.mark;
    performance.mark = ((name: string, options?: { detail?: unknown }) => {
        const detail = options?.detail;
        if (typeof name === "string" && detail && typeof detail === "object") {
            seen.push({ name, amounts: detail as Record<string, number> });
        }
        return original?.call(performance, name);
    }) as typeof performance.mark;
    try { fn(); } finally { performance.mark = original; }
    return seen;
}

function total(counters: Counter[], name: string, key: string): number {
    return counters.filter((c) => c.name.endsWith(name)).reduce((n, c) => n + (c.amounts[key] ?? 0), 0);
}

/** Start offset of the Nth top-level block. */
function blockPos(view: EditorView, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) { pos += view.state.doc.child(i).nodeSize; }
    return pos;
}

/**
 * A working note of `sections` sections. Two sizes of the same shape is the
 * whole instrument: anything else different between them would give a count
 * that grew a second explanation.
 */
function note(sections: number): string {
    let acc = "";
    for (let i = 1; i <= sections; i++) {
        acc += `## Section ${i}\n\nParagraph ${i} carries prose with a [TK] in it.\n\n`
            + `- [ ] task a${i}\n- [x] task b${i}\n- plain c${i}\n\n`;
    }
    return acc;
}

const SMALL = note(4);
const LARGE = note(40);

it("the larger fixture should be the larger fixture", () => {
    // The instrument's other half: if the two were not actually different
    // sizes, "the work did not grow" would hold for a reason that has nothing
    // to do with the code.
    expect(LARGE.length).toBeGreaterThan(SMALL.length * 5);
});

describe("Mod+A over the whole document", () => {
    /**
     * Counts the DOM reads the selection cover makes: one `blockMarkerElements`
     * lookup per top-level block it decides to read. Independent of this
     * editor's own counters on purpose, so the claim does not rest on the
     * instrument the change added.
     */
    function markerLookups() {
        const spy = vi.spyOn(Element.prototype, "querySelectorAll");
        return {
            count: () => spy.mock.calls.filter(([selector]) => selector === ".heading-fold-marker").length,
            reset: () => spy.mockClear(),
        };
    }

    /** Escalate to the whole document: the Notion ladder's third press. */
    function selectAll(view: EditorView): void {
        // ctrlKey, not metaKey: jsdom reports a non-mac platform, so Mod is Ctrl.
        const press = (): boolean => handleBlockKeydown(
            view,
            new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
        );
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, blockPos(view, 1) + 2)));
        expect(press()).toBe(true);
        expect(press()).toBe(true);
        expect(press()).toBe(true);
    }

    /**
     * Drive the ladder with the gutter chrome windowed to the same six blocks
     * in both documents, and report what the cover read.
     */
    async function coverWork(markdown: string): Promise<{ reads: number; blocks: number; span: number }> {
        const view = await makeEditor(markdown);
        // The window a reader parked near the top of the document would have.
        view.dispatch(view.state.tr.setMeta(foldPluginKey, {
            type: "window",
            window: { from: 0, to: blockPos(view, 6) },
        }));
        const lookups = markerLookups();
        lookups.reset();
        const counters = counting(() => { selectAll(view); });
        // The cover really is the whole document: without this the numbers
        // below could be small because nothing was selected.
        expect(view.state.selection.from).toBe(0);
        expect(view.state.selection.to).toBe(view.state.doc.content.size);
        return {
            reads: lookups.count(),
            // The LAST stamp, not the sum: the ladder's second press covers
            // the caret's own block and stamps one of its own.
            blocks: counters.filter((c) => c.name.endsWith("fold-cover")).at(-1)?.amounts["blocks"] ?? 0,
            span: view.state.doc.childCount,
        };
    }

    it("should read the gutter chrome it materialized, not every block it selected", async () => {
        const small = await coverWork(SMALL);
        const large = await coverWork(LARGE);

        // Reach, before anything leans on it: the cover walked both documents
        // whole, and read something in each.
        expect(large.blocks).toBeGreaterThan(small.blocks);
        expect(small.blocks).toBe(small.span);
        expect(large.blocks).toBe(large.span);
        expect(small.reads).toBeGreaterThan(0);

        // And then the claim. A block outside the chrome window carries no
        // marker, so reading its DOM asks `view.nodeDOM` to walk the view-desc
        // tree from the root for a known-empty answer — the cost that made
        // Mod+A quadratic in the block count.
        expect(large.reads).toBe(small.reads);
    });
});

describe("a paste that lands a list mid-document", () => {
    /** Insert a heading, a paragraph and a task list after the 6th block. */
    async function pasteWork(markdown: string): Promise<{ nodes: number; span: number; view: EditorView }> {
        const view = await makeEditor(markdown);
        const slice = view.state.schema;
        const heading = slice.nodes["heading"]!.create({ level: 3 }, slice.text("Pasted"));
        const para = slice.nodes["paragraph"]!.create(null, slice.text("pasted body"));
        const item = (text: string, checked: boolean): ProseNode => slice.nodes["list_item"]!.create(
            { checked }, slice.nodes["paragraph"]!.create(null, slice.text(text)),
        );
        const list = slice.nodes["bullet_list"]!.create(null, [item("pasted open", false), item("pasted done", true)]);
        const counters = counting(() => {
            view.dispatch(view.state.tr.insert(blockPos(view, 6), [heading, para, list]));
        });
        return {
            nodes: total(counters, "task-marks", "nodes"),
            span: view.state.doc.nodeSize,
            view,
        };
    }

    it("should re-read the blocks it landed in, not the whole document", async () => {
        const small = await pasteWork(SMALL);
        const large = await pasteWork(LARGE);

        // Reach: the rebuild ran at all. A paste that stopped stamping this
        // counter would pass the comparison below by measuring nothing.
        expect(small.nodes).toBeGreaterThan(0);
        expect(large.span).toBeGreaterThan(small.span * 5);

        expect(large.nodes).toBe(small.nodes);
    });

    it("should leave every task item's control saying what the item draws", async () => {
        // The differential above says the walk got smaller; this says it did
        // not get smaller by skipping work that mattered. Read off the `li`
        // elements rather than a list of expected texts, so an item that lost
        // its control shows up as a row with a null.
        const { view } = await pasteWork(LARGE);
        const rows = [...view.dom.querySelectorAll("li")].map((li) => ({
            text: (li.querySelector(":scope > p")?.textContent ?? "").trim(),
            drawn: li.getAttribute("data-checked"),
            aria: li.querySelector(":scope > [role=checkbox]")?.getAttribute("aria-checked") ?? null,
        }));
        expect(rows.length).toBeGreaterThan(100);
        expect(rows.some((r) => r.text === "pasted open")).toBe(true);
        // A control on exactly the task items, saying exactly what they draw.
        for (const row of rows) {
            expect(row.aria, row.text).toBe(row.drawn === null ? null : row.drawn);
        }
    });
});

describe("the notes scan two readers share", () => {
    it("should walk a document once however many readers ask about it", async () => {
        // The in-text highlight plugin and the review panel each keep their own
        // incremental cache, and a structural edit defeats both; before MAR-438
        // that meant the document was walked once per reader for one answer.
        const view = await makeEditor(LARGE);
        const doc = view.state.doc;
        const counters = counting(() => {
            const a = cachedScanNotes(doc, []);
            const b = cachedScanNotes(doc, []);
            expect(b).toEqual(a);
        });
        const walks = counters.filter((c) => c.name.endsWith("note-scan"));
        expect(walks).toHaveLength(1);
        // Reach: the one walk was a whole-document one and found the markers.
        expect(walks[0]!.amounts["blocks"]).toBeGreaterThan(doc.childCount);
        expect(cachedScanNotes(doc, []).length).toBeGreaterThan(0);
    });

    it("should not serve one marker set's answer to a reader asking with another", async () => {
        const view = await makeEditor("Paragraph with REVIEW in it.\n");
        const doc = view.state.doc;
        expect(cachedScanNotes(doc, [])).toHaveLength(0);
        expect(cachedScanNotes(doc, ["REVIEW"])).toHaveLength(1);
        expect(cachedScanNotes(doc, [])).toHaveLength(0);
    });

    it("should hand back what the uncached scan would have", async () => {
        const view = await makeEditor(SMALL);
        const doc = view.state.doc;
        expect(cachedScanNotes(doc, ["c1"])).toEqual(scanNotes(doc, ["c1"]));
    });

    it("should not poison the cache with an incremental answer", async () => {
        // `incrementalScanNotes` returns a partial-basis answer for the
        // document it was handed; the memo must still be the full scan's.
        const view = await makeEditor(SMALL);
        const before = view.state.doc;
        const beforeItems = cachedScanNotes(before, []);
        view.dispatch(view.state.tr.insertText("x", blockPos(view, 1) + 2));
        const after = view.state.doc;
        expect(incrementalScanNotes(before, beforeItems, after, [])).not.toBeNull();
        expect(cachedScanNotes(after, [])).toEqual(scanNotes(after, []));
    });
});
