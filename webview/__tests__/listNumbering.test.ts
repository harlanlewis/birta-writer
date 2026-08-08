/**
 * Ordered-list numbering LIFECYCLE (plugins/listNumbering.ts): the bridge
 * between the live `numbering` node attr and the state bag that outlives the
 * session, plus the fidelity guarantee that makes the whole design admissible —
 * a styled list still serializes as ordinary CommonMark `1.` markers.
 *
 * These drive a real editor with the production plugin stack, because the
 * claims are about what the parser, the serializer and the plugin agree on.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from "@milkdown/core";
import type { EditorView, Node as PmNode } from "../pm";
import { mockVscodeApi } from "./setup";

let editors: Editor[] = [];
let bag: Record<string, unknown> | null;

beforeEach(() => {
    vi.clearAllMocks();
    bag = null;
    mockVscodeApi.getState.mockImplementation(() => bag);
    mockVscodeApi.setState.mockImplementation((state: unknown) => {
        bag = state as Record<string, unknown>;
    });
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

/**
 * A fresh module graph per editor, because the preference store caches its map
 * at module scope: a statically imported stack would read the state bag once, on
 * the first test, and every later seeding would be invisible. This is the same
 * `vi.resetModules()` discipline blockWidth.test.ts uses, extended to the whole
 * plugin stack so the store the editor talks to is the one this test seeds.
 */
async function make(markdown: string): Promise<Editor> {
    vi.resetModules();
    const { configureSerialization, gfmFidelity, pureCommonmark } =
        await import("../serialization");
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
    return editor;
}

/** The production door (plugins/listNumbering.ts), from the same fresh graph. */
async function setNumberingAt(v: EditorView, pos: number, style: string | null): Promise<boolean> {
    const { setListNumberingAt } = await import("../plugins/listNumbering");
    return setListNumberingAt(v, pos, style as never);
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));
const markdown = (editor: Editor): string =>
    editor.action((ctx) => ctx.get(serializerCtx)(view(editor).state.doc));

/** The first ordered_list's position and node. */
function firstList(doc: PmNode): { pos: number; node: PmNode } {
    let found: { pos: number; node: PmNode } | null = null;
    doc.descendants((node: PmNode, pos: number) => {
        if (!found && node.type.name === "ordered_list") {
            found = { pos, node };
        }
        return !found;
    });
    if (!found) {
        throw new Error("no ordered_list in the document");
    }
    return found;
}

async function setNumbering(v: EditorView, style: string | null): Promise<void> {
    await setNumberingAt(v, firstList(v.state.doc).pos, style);
}

/**
 * Let a deferred reconcile run. An INCIDENTAL document edit schedules the bag
 * write on an idle window instead of doing it inline, because the reconcile's
 * cost scales with the document (plugins/listNumbering.ts), and in jsdom
 * `requestIdle` degrades to `setTimeout(0)`. An explicit numbering choice needs
 * none of this: it reconciles synchronously.
 */
const flushIdle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

const LIST = "1. one\n2. two\n3. three\n";

describe("numbering is presentation, never source", () => {
    it("a styled list should still serialize as ordinary CommonMark digits", async () => {
        // The whole design rests on this: CommonMark has no lettered marker, so
        // a numbering choice must not reach the file. If this ever fails, the
        // editor is writing documents other tools render as prose.
        const editor = await make(LIST);
        const v = view(editor);
        const before = markdown(editor);
        await setNumbering(v, "lower-alpha");
        expect(markdown(editor)).toBe(before);
        expect(markdown(editor)).toContain("1. one");
        expect(markdown(editor)).not.toContain("a. one");
    });

    it("every offered style should serialize identically", async () => {
        const editor = await make(LIST);
        const v = view(editor);
        const plain = markdown(editor);
        for (const style of ["lower-alpha", "upper-alpha", "lower-roman", "upper-roman"]) {
            await setNumbering(v, style);
            expect(markdown(editor)).toBe(plain);
        }
    });

    it("a parsed list should carry no numbering, so the cascade decides", async () => {
        const editor = await make(LIST);
        expect(firstList(view(editor).state.doc).node.attrs["numbering"]).toBeNull();
    });

    it("the style should reach the DOM as an inline list-style-type", async () => {
        // Inline, because it has to beat the by-depth cascade in style.css
        // without an !important.
        const editor = await make(LIST);
        const v = view(editor);
        await setNumbering(v, "lower-roman");
        const ol = v.dom.querySelector("ol");
        expect(ol?.getAttribute("style")).toContain("list-style-type: lower-roman");
    });
});

describe("the state bag mirrors the document", () => {
    it("setting a numbering should persist it under the list's content anchor", async () => {
        const editor = await make(LIST);
        await setNumbering(view(editor), "upper-alpha");
        expect(bag?.["listNumbering"]).toEqual({ "list:one": "upper-alpha" });
    });

    it("clearing a numbering should drop the stored entry, not leave a default", async () => {
        const editor = await make(LIST);
        const v = view(editor);
        await setNumbering(v, "upper-alpha");
        await setNumbering(v, null);
        expect(bag?.["listNumbering"]).toEqual({});
    });

    it("a stored style should be restored on load, WITHOUT changing the markdown", async () => {
        bag = { listNumbering: { "list:one": "lower-roman" } };
        const editor = await make(LIST);
        const v = view(editor);
        expect(firstList(v.state.doc).node.attrs["numbering"]).toBe("lower-roman");
        // Hydration must not be an edit: a file merely opened cannot come back
        // spelled differently.
        expect(markdown(editor)).toBe(LIST);
    });

    it("a stored style for a list that no longer exists should be left unapplied", async () => {
        bag = { listNumbering: { "list:absent": "lower-roman" } };
        const editor = await make(LIST);
        expect(firstList(view(editor).state.doc).node.attrs["numbering"]).toBeNull();
    });

    it("an unrecognized stored value should be dropped, never guessed", async () => {
        bag = { listNumbering: { "list:one": "lower-greek" } };
        const editor = await make(LIST);
        expect(firstList(view(editor).state.doc).node.attrs["numbering"]).toBeNull();
    });

    it("editing the first item should re-key the entry rather than accumulate one per keystroke", async () => {
        // The reconcile RESTATES the mapping instead of migrating it, which is
        // what makes a first-item edit need no rename path.
        const editor = await make(LIST);
        const v = view(editor);
        await setNumbering(v, "lower-alpha");
        expect(bag?.["listNumbering"]).toEqual({ "list:one": "lower-alpha" });
        // Append to the first item's text: "one" → "oneX". Computed from the
        // item's own paragraph rather than counted by hand.
        const { pos, node } = firstList(v.state.doc);
        const firstItem = node.firstChild!;
        const textEnd = pos + 1 + 1 + 1 + firstItem.firstChild!.content.size;
        v.dispatch(v.state.tr.insertText("X", textEnd));
        await flushIdle();
        expect(bag?.["listNumbering"]).toEqual({ "list:oneX": "lower-alpha" });
    });

    it("deleting a styled list should drop its entry", async () => {
        const editor = await make(`${LIST}\ntail\n`);
        const v = view(editor);
        await setNumbering(v, "lower-alpha");
        expect(Object.keys(bag?.["listNumbering"] as object)).toHaveLength(1);
        const { pos, node } = firstList(v.state.doc);
        v.dispatch(v.state.tr.delete(pos, pos + node.nodeSize));
        await flushIdle();
        expect(bag?.["listNumbering"]).toEqual({});
    });

    it("two lists opening on the same item text should get their own keys", async () => {
        // The occurrence rule (blockWidth.ts) applies here too: identical
        // content is not an identity.
        const editor = await make(`1. same\n\ntext\n\n1. same\n`);
        const v = view(editor);
        const lists: { pos: number; node: PmNode }[] = [];
        v.state.doc.descendants((node: PmNode, pos: number) => {
            if (node.type.name === "ordered_list") {
                lists.push({ pos, node });
            }
            return true;
        });
        expect(lists).toHaveLength(2);
        await setNumberingAt(v, lists[1]!.pos, "upper-roman");
        expect(bag?.["listNumbering"]).toEqual({ "list:same#2": "upper-roman" });
    });
});

describe("the reconcile stays off the keystroke path", () => {
    it("an incidental edit should NOT write the bag inline, only after an idle window", async () => {
        // What this pins: the reconcile walks every list and builds the anchor
        // index, so inline it would put a document-sized cost on each keystroke.
        const editor = await make(LIST);
        const v = view(editor);
        await setNumbering(v, "lower-alpha");
        const { pos, node } = firstList(v.state.doc);
        const textEnd = pos + 1 + 1 + 1 + node.firstChild!.firstChild!.content.size;
        v.dispatch(v.state.tr.insertText("X", textEnd));
        // Still the OLD key: nothing ran inline.
        expect(bag?.["listNumbering"]).toEqual({ "list:one": "lower-alpha" });
        await flushIdle();
        expect(bag?.["listNumbering"]).toEqual({ "list:oneX": "lower-alpha" });
    });

    it("an explicit choice should persist synchronously, not wait for idle", async () => {
        // The webview can be disposed (a switch to the raw editor) before an
        // idle callback would ever run, so the user's own choice cannot wait.
        const editor = await make(LIST);
        await setNumbering(view(editor), "upper-roman");
        expect(bag?.["listNumbering"]).toEqual({ "list:one": "upper-roman" });
    });
});

describe("cost when unused", () => {
    it("a document with no numbering and an empty bag should write nothing to the bag", async () => {
        const editor = await make(`${LIST}\nprose\n`);
        const v = view(editor);
        v.dispatch(v.state.tr.insertText("more", v.state.doc.content.size - 1));
        expect(bag?.["listNumbering"]).toBeUndefined();
    });
});
