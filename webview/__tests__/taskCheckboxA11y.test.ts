/**
 * The task checkbox as assistive tech reads it (MAR-403).
 *
 * A task item draws its tick in `::before`/`::after` with `content: ""` and
 * marks completion with `text-decoration: line-through`, and neither reaches
 * the accessibility tree, so the drawing tells nothing that reads a page which
 * of two items is done. `plugins/list.ts` puts one real element per task item
 * inside it, carrying `role="checkbox"` and `aria-checked`; these hold that it
 * is there, that it says what the item says, and that it stays that way.
 *
 * Drives the REAL Milkdown editor — real parser, real schema, the production
 * serialization config — so these read the DOM a browser would get. What jsdom
 * cannot answer is the computed accessibility TREE: whether a role swallows the
 * item's text, whether a nested list survives. `e2e/taskToggle` asks a real
 * engine that with `ariaSnapshot`, in Chromium and, under
 * `BIRTA_E2E_BROWSER=webkit`, in WebKit.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { TextSelection } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { taskListItemsTouched } from "../plugins/list";

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
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Position of the list item whose own text starts with `text`, or -1. */
function itemPos(v: EditorView, text: string): number {
    let found = -1;
    v.state.doc.descendants((node: ProseNode, pos: number) => {
        if (found === -1 && node.type.name === "list_item"
            && (node.firstChild?.textContent ?? "") === text) {
            found = pos;
        }
        return found === -1;
    });
    return found;
}

/**
 * What the DOM says, per list item: its own first-line text, the `data-checked`
 * the CSS draws from, and the `aria-checked` on the control inside it (null
 * when there is no control at all).
 *
 * Read off `li` elements rather than off a list of expected texts, so an item
 * that lost its control shows up as a row with a null rather than as a row
 * nobody looked for.
 */
function itemStates(editor: Editor): Array<{ text: string; drawn: string | null; aria: string | null }> {
    const dom = view(editor).dom;
    return [...dom.querySelectorAll("li")].map((li) => {
        const box = li.querySelector(":scope > [role=checkbox]");
        return {
            text: (li.querySelector(":scope > p")?.textContent ?? "").trim(),
            drawn: li.getAttribute("data-checked"),
            aria: box?.getAttribute("aria-checked") ?? null,
        };
    });
}

/** Flip one item's `checked` attr the way `toggleTaskChecked` does. */
function toggle(editor: Editor, text: string): void {
    const v = view(editor);
    const pos = itemPos(v, text);
    expect(pos, `no list item whose first line is "${text}"`).toBeGreaterThanOrEqual(0);
    const node = v.state.doc.nodeAt(pos)!;
    v.dispatch(v.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        checked: !node.attrs["checked"],
    }));
}

const FIXTURE = [
    "- [ ] open task",
    "- [x] done task",
    "- [ ] parent",
    "  - [x] nested task",
    "- plain bullet",
    "",
].join("\n");

afterEach(() => {
    editors.forEach((editor) => editor.destroy());
    editors = [];
    document.body.innerHTML = "";
});

describe("task checkbox accessibility", () => {
    it("a parsed task list should carry one checkbox control per task item, none on a plain bullet", async () => {
        const editor = await makeEditor(FIXTURE);
        const states = itemStates(editor);

        // The instrument first: a query that reached no list item would report
        // every assertion below as a pass.
        expect(states.map((s) => s.text)).toEqual([
            "open task", "done task", "parent", "nested task", "plain bullet",
        ]);

        const tasks = states.filter((s) => s.drawn !== null);
        const plain = states.filter((s) => s.drawn === null);
        expect(tasks).toHaveLength(4);
        expect(plain).toHaveLength(1);
        // A control on every task, and on nothing else. The second half is what
        // catches a decoration applied to list items in general.
        expect(tasks.every((s) => s.aria !== null)).toBe(true);
        expect(plain.every((s) => s.aria === null)).toBe(true);
    });

    it("a task's accessible state should be the state it draws, not a fixed value", async () => {
        const editor = await makeEditor(FIXTURE);
        const states = itemStates(editor);

        // The invariant, not the expected output: whatever the CSS draws from
        // is what the control reports. An `aria-checked` frozen at either value
        // fails on one of the four items.
        for (const state of states.filter((s) => s.drawn !== null)) {
            expect(state.aria, state.text).toBe(state.drawn);
        }
        // …and the fixture really does contain both states, or the loop above
        // agrees with a constant.
        expect(new Set(states.filter((s) => s.drawn !== null).map((s) => s.drawn)))
            .toEqual(new Set(["true", "false"]));
    });

    it("toggling an item should move its accessible state with it, in both directions", async () => {
        const editor = await makeEditor(FIXTURE);

        toggle(editor, "open task");
        toggle(editor, "done task");
        let states = itemStates(editor);
        expect(states.map((s) => [s.text, s.drawn, s.aria])).toEqual([
            ["open task", "true", "true"],
            ["done task", "false", "false"],
            ["parent", "false", "false"],
            ["nested task", "true", "true"],
            ["plain bullet", null, null],
        ]);

        // Back again. A control whose DOM was reused across the first toggle
        // could still read correctly by luck; it cannot survive both.
        toggle(editor, "open task");
        toggle(editor, "done task");
        states = itemStates(editor);
        expect(states.map((s) => [s.text, s.drawn, s.aria])).toEqual([
            ["open task", "false", "false"],
            ["done task", "true", "true"],
            ["parent", "false", "false"],
            ["nested task", "true", "true"],
            ["plain bullet", null, null],
        ]);
    });

    it("typing into a task item should leave the item's control alone", async () => {
        const editor = await makeEditor(FIXTURE);
        const v = view(editor);
        const pos = itemPos(v, "done task");
        // Inside the item's paragraph: item start + 1 (into the item) + 1 (into
        // the paragraph).
        v.dispatch(v.state.tr.insertText("ZZ", pos + 2));

        const states = itemStates(editor);
        expect(states.map((s) => [s.text, s.drawn, s.aria])).toEqual([
            ["open task", "false", "false"],
            ["ZZdone task", "true", "true"],
            ["parent", "false", "false"],
            ["nested task", "true", "true"],
            ["plain bullet", null, null],
        ]);
    });

    it("an edit above the list should carry every control along with its own item", async () => {
        const editor = await makeEditor(`intro\n\n${FIXTURE}`);
        const v = view(editor);
        // Inside the leading paragraph, so every task item below it shifts.
        v.dispatch(v.state.tr.insertText("ZZZZ", 1));

        expect(itemStates(editor).map((s) => [s.text, s.drawn, s.aria])).toEqual([
            ["open task", "false", "false"],
            ["done task", "true", "true"],
            ["parent", "false", "false"],
            ["nested task", "true", "true"],
            ["plain bullet", null, null],
        ]);
    });

    it("replacing an item with another of the same tick should give the new one a control", async () => {
        const editor = await makeEditor(FIXTURE);
        const v = view(editor);
        const pos = itemPos(v, "done task");
        const node = v.state.doc.nodeAt(pos)!;
        // One transaction that deletes a ticked item and inserts a different
        // ticked item: the sequence of ticks is unchanged, so anything that
        // decides by ticks alone leaves the new item with no control.
        const replacement = node.type.create(
            node.attrs,
            v.state.schema.nodes["paragraph"]!.create(null, v.state.schema.text("swapped in")),
        );
        v.dispatch(v.state.tr.replaceWith(pos, pos + node.nodeSize, replacement));

        expect(itemStates(editor).map((s) => [s.text, s.drawn, s.aria])).toEqual([
            ["open task", "false", "false"],
            ["swapped in", "true", "true"],
            ["parent", "false", "false"],
            ["nested task", "true", "true"],
            ["plain bullet", null, null],
        ]);
    });

    it("the control should be a child of the item, never the item itself", async () => {
        const editor = await makeEditor(FIXTURE);
        const items = [...view(editor).dom.querySelectorAll("li")];

        // The design decision this pins: `role="checkbox"` on the `li` is
        // name-from-contents and children-presentational, so the item stops
        // being a listitem, its name absorbs the block-options button's own
        // label, and a parent task's nested sub-list is folded into that name
        // instead of being a list (measured in Chromium and WebKit both).
        expect(items.some((li) => li.getAttribute("role") !== null)).toBe(false);

        const parent = items.find((li) => li.querySelector(":scope > p")?.textContent === "parent")!;
        expect(parent.querySelector(":scope > [role=checkbox]")).not.toBeNull();
        // The sub-list is still a list inside the item, not something inside a
        // control.
        expect(parent.querySelector(":scope > ul > li")).not.toBeNull();
    });

    /**
     * The per-keystroke decision, asked directly.
     *
     * It cannot be asked any other way: a mapped set and a rebuilt one render
     * the same controls in the same places, so every assertion above holds
     * whichever branch ran, and a change that quietly went back to walking the
     * whole document on every keystroke would leave all of them green. That is
     * exactly what happened once (`pnpm perf:typing:ab` on `xlarge` is what
     * caught it), so the cheap answer is pinned here rather than left to a gate
     * that runs on a different machine.
     */
    describe("the per-transaction decision", () => {
        /** Run `edit`, and report what the resulting transaction was judged to be. */
        async function verdictOf(
            markdown: string,
            edit: (v: EditorView) => void,
        ): Promise<boolean> {
            const editor = await makeEditor(markdown);
            const v = view(editor);
            let seen: boolean | null = null;
            const original = v.dispatch.bind(v);
            v.dispatch = (tr) => {
                if (seen === null) { seen = taskListItemsTouched(tr); }
                original(tr);
            };
            edit(v);
            expect(seen, "the edit dispatched no transaction").not.toBeNull();
            return seen!;
        }

        it("typing inside a task item should not ask the document anything", async () => {
            const verdict = await verdictOf(FIXTURE, (v) => {
                const pos = itemPos(v, "done task");
                v.dispatch(v.state.tr.insertText("Z", pos + 2));
            });
            expect(verdict).toBe(false);
        });

        it("typing in a paragraph outside every list should not either", async () => {
            const verdict = await verdictOf(`intro\n\n${FIXTURE}`, (v) => {
                v.dispatch(v.state.tr.insertText("Z", 1));
            });
            expect(verdict).toBe(false);
        });

        it("ticking an item should be seen", async () => {
            const verdict = await verdictOf(FIXTURE, (v) => {
                const pos = itemPos(v, "open task");
                const node = v.state.doc.nodeAt(pos)!;
                v.dispatch(v.state.tr.setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    checked: true,
                }));
            });
            expect(verdict).toBe(true);
        });

        it("a task item ceasing to be one should be seen", async () => {
            // The tick going to `null` is a plain bullet again. Asking about
            // ticks rather than about items would leave its control behind.
            const verdict = await verdictOf(FIXTURE, (v) => {
                const pos = itemPos(v, "done task");
                const node = v.state.doc.nodeAt(pos)!;
                v.dispatch(v.state.tr.setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    checked: null,
                }));
            });
            expect(verdict).toBe(true);
        });

        it("splitting a task item into two should be seen", async () => {
            const verdict = await verdictOf(FIXTURE, (v) => {
                const pos = itemPos(v, "open task");
                v.dispatch(v.state.tr
                    .setSelection(TextSelection.create(v.state.doc, pos + 4))
                    .split(pos + 4, 2));
            });
            expect(verdict).toBe(true);
        });

        it("replacing an item with another of the same tick should be seen", async () => {
            const verdict = await verdictOf(FIXTURE, (v) => {
                const pos = itemPos(v, "done task");
                const node = v.state.doc.nodeAt(pos)!;
                const replacement = node.type.create(
                    node.attrs,
                    v.state.schema.nodes["paragraph"]!.create(
                        null, v.state.schema.text("swapped in")),
                );
                v.dispatch(v.state.tr.replaceWith(pos, pos + node.nodeSize, replacement));
            });
            expect(verdict).toBe(true);
        });
    });

    it("the control should be view-only, never reaching the saved markdown", async () => {
        const editor = await makeEditor(FIXTURE);
        expect(view(editor).dom.querySelectorAll("[role=checkbox]").length).toBe(4);
        expect(editor.action(getMarkdown()).trim()).toBe(FIXTURE.trim());
    });
});
