/**
 * Typed list markers (plugins/listMarkerInput), against the REAL Milkdown
 * editor with the list plugins wired as webview/editor.ts wires them — so
 * listOrderSync, listAutoJoin and the spread normalizer all get their say on
 * every transaction, exactly as they would in the product.
 *
 * The contract:
 *   - a marker typed at the head of a list ITEM retypes that item and splits
 *     its list, which is what the same bytes mean in Markdown; the item's own
 *     subtree travels with it, so this is the surface that builds mixed nesting
 *     from the keyboard;
 *   - `[ ]`/`[x]` set the item's checkbox on either list type, and only from
 *     the item's own marker line;
 *   - a marker that would change nothing stays literal text;
 *   - in prose the rules behave as they always have, plus `1) ` and the typed
 *     marker character being recorded.
 *
 * The matrix asserts INVARIANTS the production code can answer — schema
 * validity and round-trip stability — over the combinatorial space, rather
 * than a hand-picked expected string per case (the pasteMatrix argument). A
 * corrupt document reparses into something else generically; that is what
 * catches a defect no per-case expectation was written for.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView, Node as ProseNode } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    listAutoJoinPlugin,
    listEnterPlugin,
    listLiftPlugin,
    listSpreadNormalizePlugin,
} from "../plugins";

let editors: Editor[] = [];

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
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(listAutoJoinPlugin)
        .use(listSpreadNormalizePlugin)
        .create();
    editors.push(editor);
    return editor;
}

afterEach(async () => {
    for (const editor of editors) await editor.destroy();
    editors = [];
    document.body.innerHTML = "";
});

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown());
}

/** Type text one character at a time, running input rules like a real user. */
function typeText(v: EditorView, text: string): void {
    for (const ch of text) {
        const { from, to } = v.state.selection;
        const handled = v.someProp("handleTextInput", (f) => f(v, from, to, ch));
        if (!handled) {
            v.dispatch(v.state.tr.insertText(ch, from, to));
        }
    }
}

/** `ctrlKey`, not `metaKey`: prosemirror-keymap resolves `Mod-` against
 * `navigator.platform`, which jsdom leaves empty, so `Mod-` is `Ctrl-` here
 * (the convention listBackspaceBehavior.test.ts already uses). */
function pressKey(v: EditorView, key: string, mods: { ctrlKey?: boolean } = {}): boolean {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, ...mods });
    return v.someProp("handleKeyDown", (f) => f(v, event)) ?? false;
}

/** Caret at the start of the first textblock whose text contains `needle`. */
function caretAtStartOf(v: EditorView, needle: string): void {
    let found = -1;
    v.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.isTextblock && node.textContent.includes(needle)) {
            found = pos + 1;
            return false;
        }
        return true;
    });
    if (found < 0) throw new Error(`no textblock containing ${JSON.stringify(needle)}`);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, found)));
}

/** Type `typed` at the head of the line holding `needle`; return the markdown. */
async function typeAtHeadOf(source: string, needle: string, typed: string): Promise<string> {
    const editor = await makeEditor(source);
    const v = view(editor);
    caretAtStartOf(v, needle);
    typeText(v, typed);
    v.state.doc.check();
    return markdown(editor);
}

/** Serialize → reparse → serialize. Equal means the bytes survive a reopen. */
async function roundTrips(md: string): Promise<boolean> {
    const reopened = await makeEditor(md);
    return markdown(reopened) === md;
}

/** Every list node as "type@depth", document order. */
function listShapes(v: EditorView): string[] {
    const shapes: string[] = [];
    v.state.doc.descendants((node: ProseNode, pos: number) => {
        if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
            shapes.push(`${node.type.name}@${v.state.doc.resolve(pos).depth}`);
        }
        return true;
    });
    return shapes;
}

describe("typed list markers — the motivating shape", () => {
    it("indenting a fresh item and typing `1. ` should nest an ordered list in a bullet one", async () => {
        const editor = await makeEditor("- alpha\n  - one\n");
        const v = view(editor);
        caretAtStartOf(v, "one");
        typeText(v, "1. ");
        v.state.doc.check();
        expect(markdown(editor)).toBe("- alpha\n  1. one\n");
        expect(listShapes(v)).toEqual(["bullet_list@0", "ordered_list@2"]);
    });

    it("a nested ordered list typed one item at a time should merge into one list", async () => {
        const editor = await makeEditor("- alpha\n  - one\n  - two\n");
        const v = view(editor);
        caretAtStartOf(v, "one");
        typeText(v, "1. ");
        caretAtStartOf(v, "two");
        typeText(v, "2. ");
        v.state.doc.check();
        // The second retype makes two ordered lists adjacent, and adjacency an
        // edit created is exactly listAutoJoin's mandate.
        expect(markdown(editor)).toBe("- alpha\n  1. one\n  2. two\n");
        expect(listShapes(v)).toEqual(["bullet_list@0", "ordered_list@2"]);
    });

    it("a bullet list nested in an ordered one should be reachable the same way", async () => {
        expect(await typeAtHeadOf("1. alpha\n   1. one\n", "one", "- ")).toBe(
            "1. alpha\n   - one\n",
        );
    });

    it("an item's own subtree should travel with it, untouched", async () => {
        const md = await typeAtHeadOf("- alpha\n  - inner\n- beta\n", "alpha", "1. ");
        expect(md).toBe("1. alpha\n   - inner\n\n- beta\n");
        expect(await roundTrips(md)).toBe(true);
    });
});

describe("typed list markers — scope and splitting", () => {
    it("a marker on a middle item should split its list in three", async () => {
        const md = await typeAtHeadOf("- alpha\n- beta\n- gamma\n", "beta", "1. ");
        expect(md).toBe("- alpha\n\n1. beta\n\n- gamma\n");
        expect(await roundTrips(md)).toBe(true);
    });

    it("a marker on the FIRST item should not flip the whole list", async () => {
        // listOrderSync retypes any bullet_list whose first item still claims
        // `listType: "ordered"`, so a stale attr here would silently convert
        // the siblings too — the landmine convertListTreeAt records.
        const md = await typeAtHeadOf("- alpha\n- beta\n- gamma\n", "alpha", "1. ");
        expect(md).toBe("1. alpha\n\n- beta\n- gamma\n");
    });

    it("a marker on the only item should retype the list in place", async () => {
        expect(await typeAtHeadOf("- alpha\n", "alpha", "1. ")).toBe("1. alpha\n");
    });

    it("an ordered tail should keep the numbers it was already showing", async () => {
        const md = await typeAtHeadOf("1. a\n2. b\n3. c\n", "b", "- ");
        expect(md).toBe("1. a\n\n- b\n\n3. c\n");
        expect(await roundTrips(md)).toBe(true);
    });

    it("a retype that lands beside a same-type list should join it", async () => {
        const md = await typeAtHeadOf("1. a\n\n- b\n- c\n", "b", "2. ");
        expect(md).toBe("1. a\n2. b\n\n- c\n");
    });

    it("retyping an item back should restore the one list it came from", async () => {
        // The split is self-healing: the second retype makes the three lists
        // same-type siblings again, and edit-created adjacency is exactly what
        // listAutoJoin merges.
        const editor = await makeEditor("- alpha\n- beta\n- gamma\n");
        const v = view(editor);
        caretAtStartOf(v, "beta");
        typeText(v, "1. ");
        caretAtStartOf(v, "beta");
        typeText(v, "- ");
        v.state.doc.check();
        expect(markdown(editor)).toBe("- alpha\n- beta\n- gamma\n");
        expect(listShapes(v)).toEqual(["bullet_list@0"]);
    });

    it("the typed number should become the list's start", async () => {
        expect(await typeAtHeadOf("- alpha\n", "alpha", "7. ")).toBe("7. alpha\n");
    });

    it("the typed delimiter should be recorded", async () => {
        expect(await typeAtHeadOf("- alpha\n", "alpha", "1) ")).toBe("1) alpha\n");
    });

    it("the caret should land in the retyped item's text", async () => {
        const editor = await makeEditor("- alpha\n- beta\n");
        const v = view(editor);
        caretAtStartOf(v, "beta");
        typeText(v, "1. ");
        typeText(v, "X");
        expect(markdown(editor)).toBe("- alpha\n\n1. Xbeta\n");
    });
});

describe("typed list markers — a marker that changes nothing stays text", () => {
    it("`- ` at the head of a bullet item should stay literal", async () => {
        expect(await typeAtHeadOf("- alpha\n- beta\n", "beta", "- ")).toBe(
            "- alpha\n- \\- beta\n",
        );
    });

    it("`1. ` at the head of an ordered item should stay literal", async () => {
        expect(await typeAtHeadOf("1. alpha\n2. beta\n", "beta", "1. ")).toBe(
            "1. alpha\n2. 1\\. beta\n",
        );
    });

    it("a number typed before existing text should still fire, and be undoable", async () => {
        // The `1990. ` collision is real and deliberately NOT guarded against
        // (see the rule's header): it fires, and Backspace puts it back.
        const editor = await makeEditor("- x\n- The year we moved\n");
        const v = view(editor);
        caretAtStartOf(v, "The year");
        typeText(v, "1990. ");
        expect(markdown(editor)).toBe("- x\n\n1990. The year we moved\n");
        expect(pressKey(v, "Backspace")).toBe(true);
        expect(markdown(editor)).toBe("- x\n- 1990\\. The year we moved\n");
    });
});

describe("typed task markers", () => {
    it("`[ ] ` should make a bullet item a task", async () => {
        expect(await typeAtHeadOf("- alpha\n- beta\n", "beta", "[ ] ")).toBe(
            "- alpha\n- [ ] beta\n",
        );
    });

    it("`[ ] ` should make an ORDERED item a task without changing its type", async () => {
        expect(await typeAtHeadOf("1. alpha\n2. beta\n", "beta", "[ ] ")).toBe(
            "1. alpha\n2. [ ] beta\n",
        );
    });

    it("`[x] ` on an open task should tick it", async () => {
        expect(await typeAtHeadOf("- [ ] alpha\n- [ ] beta\n", "beta", "[x] ")).toBe(
            "- [ ] alpha\n- [x] beta\n",
        );
    });

    it("`[ ] ` on an already-open task should stay literal", async () => {
        expect(await typeAtHeadOf("- [ ] alpha\n- [ ] beta\n", "beta", "[ ] ")).toBe(
            "- [ ] alpha\n- [ ] \\[ ] beta\n",
        );
    });

    it("a task marker on a CONTINUATION line should not check the item's first line", async () => {
        // Upstream climbed to the nearest list_item from anywhere, so the
        // marker was consumed on one line and the checkbox appeared on another.
        expect(await typeAtHeadOf("- alpha\n\n  second\n", "second", "[ ] ")).toBe(
            "- alpha\n\n  \\[ ] second\n",
        );
    });

    it("a task marker in prose should stay literal", async () => {
        expect(await typeAtHeadOf("hello\n\nworld\n", "world", "[ ] ")).toBe(
            "hello\n\n\\[ ] world\n",
        );
    });

    it("a list marker typed on a task item should keep the checkbox", async () => {
        // `1. [ ] step` is valid GFM: the marker changed, not the box.
        expect(await typeAtHeadOf("- [ ] alpha\n", "alpha", "1. ")).toBe("1. [ ] alpha\n");
    });
});

describe("typed list markers — prose is unchanged", () => {
    it("`- ` should still wrap a paragraph in a bullet list", async () => {
        expect(await typeAtHeadOf("hello\n\nworld\n", "world", "- ")).toBe("hello\n\n- world\n");
    });

    it("`1. ` should still wrap a paragraph in an ordered list", async () => {
        expect(await typeAtHeadOf("hello\n\nworld\n", "world", "1. ")).toBe("hello\n\n1. world\n");
    });

    it("`3. ` should still start an ordered list at 3", async () => {
        expect(await typeAtHeadOf("hello\n\nworld\n", "world", "3. ")).toBe("hello\n\n3. world\n");
    });

    it("`1) ` should now start a list instead of escaping", async () => {
        expect(await typeAtHeadOf("hello\n\nworld\n", "world", "1) ")).toBe("hello\n\n1) world\n");
    });

    it("the typed bullet character should be recorded", async () => {
        expect(await typeAtHeadOf("hello\n\nworld\n", "world", "* ")).toBe("hello\n\n* world\n");
        expect(await typeAtHeadOf("hello\n\nworld\n", "world", "+ ")).toBe("hello\n\n+ world\n");
    });

    it("a marker typed under a list should continue that list", async () => {
        const editor = await makeEditor("- alpha\n\nworld\n");
        const v = view(editor);
        caretAtStartOf(v, "world");
        typeText(v, "- ");
        v.state.doc.check();
        expect(markdown(editor)).toBe("- alpha\n- world\n");
    });

    it("`- ` on an item's continuation line should nest a sublist", async () => {
        const md = await typeAtHeadOf("- alpha\n\n  second\n", "second", "- ");
        expect(md).toBe("- alpha\n\n  - second\n");
        expect(await roundTrips(md)).toBe(true);
    });
});

describe("typed list markers — reversibility", () => {
    it("Backspace right after a retype should restore the typed characters", async () => {
        const editor = await makeEditor("- alpha\n- beta\n");
        const v = view(editor);
        caretAtStartOf(v, "beta");
        typeText(v, "1. ");
        expect(pressKey(v, "Backspace")).toBe(true);
        v.state.doc.check();
        expect(markdown(editor)).toBe("- alpha\n- 1\\. beta\n");
    });

    it("Backspace right after wrapping prose should restore the typed characters", async () => {
        const editor = await makeEditor("hello\n\nworld\n");
        const v = view(editor);
        caretAtStartOf(v, "world");
        typeText(v, "- ");
        expect(pressKey(v, "Backspace")).toBe(true);
        expect(markdown(editor)).toBe("hello\n\n\\- world\n");
    });

    it("Cmd+Backspace should delete rather than undo the rule", async () => {
        // Delete-to-line-start is a deletion the user asked for by name; only
        // Backspace carries the undo.
        const editor = await makeEditor("- alpha\n- beta\n");
        const v = view(editor);
        caretAtStartOf(v, "beta");
        typeText(v, "1. ");
        expect(pressKey(v, "Backspace", { ctrlKey: true })).toBe(true);
        expect(markdown(editor)).not.toContain("1\\.");
    });

    it("Backspace at an item start with no rule to undo should still lift", async () => {
        const editor = await makeEditor("- alpha\n- beta\n");
        const v = view(editor);
        caretAtStartOf(v, "beta");
        expect(pressKey(v, "Backspace")).toBe(true);
        expect(markdown(editor)).toBe("- alpha\n\nbeta\n");
    });
});

// ── The matrix ──────────────────────────────────────────────────────────────
//
// Every marker against every list flavor at every position, on documents that
// also carry a sublist and a second block, checked for the two invariants the
// production code can answer on its own.

const SOURCES: { name: string; md: string; targets: string[] }[] = [
    { name: "bullet", md: "- one\n- two\n- three\n", targets: ["one", "two", "three"] },
    { name: "ordered", md: "1. one\n2. two\n3. three\n", targets: ["one", "two", "three"] },
    { name: "task", md: "- [ ] one\n- [x] two\n- [ ] three\n", targets: ["one", "two", "three"] },
    {
        name: "nested",
        md: "- one\n  1. inner\n  2. deeper\n- two\n",
        targets: ["one", "inner", "deeper", "two"],
    },
    {
        name: "loose with a second block",
        md: "- one\n\n  body\n\n- two\n",
        targets: ["one", "two"],
    },
    { name: "in a quote", md: "> - one\n> - two\n", targets: ["one", "two"] },
    // A footnote definition is where the list-spread machinery's hardest cases
    // live (MAR-211/302: micromark reports item geometry differently inside
    // one), so a retype that splits a list there is worth enumerating.
    {
        name: "in a footnote",
        md: "text[^1]\n\n[^1]: note\n\n    - one\n\n    - two\n",
        targets: ["one", "two"],
    },
];

const MARKERS = ["- ", "* ", "+ ", "1. ", "1) ", "5. ", "[ ] ", "[x] "];

describe("typed list markers — matrix", () => {
    for (const source of SOURCES) {
        for (const target of source.targets) {
            for (const marker of MARKERS) {
                it(`${source.name} / ${JSON.stringify(marker)} at "${target}" should stay valid and round-trip`, async () => {
                    const md = await typeAtHeadOf(source.md, target, marker);
                    expect(await roundTrips(md)).toBe(true);
                });
            }
        }
    }
});
