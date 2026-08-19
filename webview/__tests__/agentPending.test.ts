/**
 * The `/ai` run marker and its two policies (plugins/agentPending.ts), driven
 * on the real Milkdown editor: the marker shows only once the extension
 * confirms a background run and rides the document as the user types; an
 * inbound external change enters the undo history only while a run is live;
 * and a dirty-document result merges around the user's edits through the
 * position mapping the run accumulated, refusing where they collide.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx } from "@milkdown/core";
import { history, undo } from "../pm";
import { TextSelection } from "../pm";
import type { EditorView, Node as ProseNode } from "../pm";
import { $prose } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    agentPendingPlugin,
    agentRun,
    applyAgentResult,
    beginAgentRun,
    failAgentRun,
    markAgentRunning,
    recordsExternalInHistory,
    settleAgentRun,
} from "../plugins/agentPending";
import { applyExternalSync } from "../externalSync";
import { mockVscodeApi } from "./setup";
import { editorView, loadCorpusFixtures, makeCorpusEditor } from "./helpers/moveFuzz";

const historyPlugin = $prose(() => history());

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
        .use(historyPlugin)
        .use(agentPendingPlugin)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function endOfBlock(v: EditorView, n: number): number {
    let pos = 0;
    for (let i = 0; i < n; i++) pos += v.state.doc.child(i).nodeSize;
    return pos + v.state.doc.child(n).nodeSize - 1;
}

function placeCaret(v: EditorView, pos: number): void {
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
}

function typeText(v: EditorView, text: string): void {
    const { from, to } = v.state.selection;
    v.dispatch(v.state.tr.insertText(text, from, to));
}

function markers(): HTMLElement[] {
    return Array.from(document.querySelectorAll(".ProseMirror .agent-pending"));
}

function merge(editor: Editor, id: string, text: string) {
    return editor.action((ctx) => applyAgentResult(
        ctx.get(editorViewCtx),
        id,
        text,
        (md) => ctx.get(parserCtx)(md) as ProseNode | null,
    ));
}

describe("agent run marker", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("First paragraph.\n\nSecond paragraph.\n\nThird.");
        v = view(editor);
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("a begun run should show no marker until the extension confirms it is running", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);

        expect(markers()).toHaveLength(0);
        markAgentRunning(v, id);
        expect(markers()).toHaveLength(1);
        expect(markers()[0].closest("p")?.textContent).toBe("Second paragraph.");
    });

    // The pill stands in the block marker's own column, so the block it is
    // anchored to has to stand its gutter down for the run's duration or a
    // grab handle appears over it on hover. The class is how that reaches the
    // stylesheet, and WHICH node carries it is the part worth pinning: the
    // gutter belongs to the innermost block, and the CSS suppresses a direct
    // child, so marking an outer ancestor would silently miss every nested
    // case while passing every top-level one.
    it("a running run should mark its own block as the pill's host", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);

        const hosts = [...document.querySelectorAll(".agent-pending-host")];
        expect(hosts).toHaveLength(1);
        expect(hosts[0].textContent).toBe("Second paragraph.");
        // The marker is inside the block that carries the class. That is all
        // this file can say: the editor here composes no gutter plugin, so
        // there is no `.heading-fold-gutter` to stand in the right or wrong
        // relationship to. Whether the stylesheet's rule actually reaches a
        // gutter from this class is a DOM question with a different answer per
        // block type, and it is answered in e2e/slashMenu against a real one.
        expect(hosts[0].contains(markers()[0])).toBe(true);

        settleAgentRun(v, id);
        expect(document.querySelectorAll(".agent-pending-host")).toHaveLength(0);
    });

    it("a run inside a nested block should mark that block, not its container", async () => {
        await editor.destroy();
        // A nested list, because it is the construct where the inner block and
        // its container hold visibly different text. The first draft of this
        // used a callout and did not discriminate: marking the container
        // passed it too, which a mutation run caught and reading the tree
        // explained. The assertion below is written so that cannot recur.
        editor = await makeEditor("- Item\n  - Child line.\n");
        v = view(editor);

        let inner = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (inner < 0 && node.isTextblock && node.textContent === "Child line.") { inner = pos + 1; }
            return true;
        });
        expect(inner, "the fixture has no nested paragraph to test with").toBeGreaterThan(0);
        // The container really does read differently from the inner block, or
        // the two assertions below could not tell them apart.
        expect(v.state.doc.firstChild?.textContent).toBe("ItemChild line.");

        placeCaret(v, inner);
        markAgentRunning(v, beginAgentRun(v));

        const hosts = [...document.querySelectorAll(".agent-pending-host")];
        expect(hosts).toHaveLength(1);
        expect(hosts[0].textContent).toBe("Child line.");
        expect(hosts[0].textContent).not.toBe("ItemChild line.");
        expect(hosts[0].querySelector(".agent-pending")).not.toBeNull();
    });

    it("the marker should ride its block as the user types above it, and settle away", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);

        placeCaret(v, endOfBlock(v, 0));
        typeText(v, " More words up here.");

        expect(markers()[0].closest("p")?.textContent).toBe("Second paragraph.");
        settleAgentRun(v, id);
        expect(markers()).toHaveLength(0);
    });

    it("clicking a running marker should ask the extension to cancel that run", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);

        markers()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "agentCancel", requestId: id });
    });

    it("a failed run should show an error marker that a click dismisses", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);

        failAgentRun(v, id, "exit 1");

        const el = markers()[0];
        expect(el.classList.contains("agent-pending--error")).toBe(true);
        expect(el.title).toContain("exit 1");
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(markers()).toHaveLength(0);
        expect(agentRun(v, id)).toBeNull();
    });

    it("deleting the marker's block should drop the marker", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        const start = endOfBlock(v, 0) + 1;
        const end = endOfBlock(v, 1) + 1;

        v.dispatch(v.state.tr.delete(start, end));

        expect(v.state.doc.childCount).toBe(2);
        expect(markers().filter((m) => m.closest("p")?.textContent === "Second paragraph.")).toHaveLength(0);
    });
});

describe("undo policy for an agent's external write", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("First paragraph.\n\nSecond paragraph.");
        v = view(editor);
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("with no run live, an external change should stay out of the undo history", () => {
        expect(recordsExternalInHistory(v)).toBe(false);
        expect(applyExternalSync(editor, "First paragraph.\n\nSecond paragraph.\n\nAgent line.", { intoHistory: recordsExternalInHistory(v) })).toBe(true);
        expect(v.state.doc.childCount).toBe(3);

        undo(v.state, v.dispatch);

        expect(v.state.doc.childCount).toBe(3);
    });

    it("with a run live, two external changes should be two undo steps, not one", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        expect(applyExternalSync(editor, "First paragraph.\n\nSecond paragraph.\n\nAgent line.", { intoHistory: true })).toBe(true);
        expect(applyExternalSync(editor, "First paragraph.\n\nSecond paragraph.\n\nAgent line.\n\nCheckout line.", { intoHistory: true })).toBe(true);
        expect(v.state.doc.childCount).toBe(4);

        undo(v.state, v.dispatch);

        expect(v.state.doc.childCount).toBe(3);
        expect(v.state.doc.child(2).textContent).toBe("Agent line.");
    });

    it("with a run live, an external change should undo in one step like a paste", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        expect(recordsExternalInHistory(v)).toBe(true);

        expect(applyExternalSync(editor, "First paragraph.\n\nSecond paragraph.\n\nAgent line.", { intoHistory: recordsExternalInHistory(v) })).toBe(true);
        expect(v.state.doc.childCount).toBe(3);
        undo(v.state, v.dispatch);

        expect(v.state.doc.childCount).toBe(2);
        expect(v.state.doc.textContent).toBe("First paragraph.Second paragraph.");
    });

    it("a run that failed should not keep recording external changes", () => {
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        failAgentRun(v, id, "boom");
        expect(recordsExternalInHistory(v)).toBe(false);
    });
});

describe("applyAgentResult (the dirty-document merge)", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("First paragraph.\n\nSecond paragraph.\n\nThird.");
        v = view(editor);
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("with nothing typed since hand-off, the agent's text should replace the document and undo in one step", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);

        const outcome = merge(editor, id, "First paragraph.\n\nSecond paragraph.\n\nAgent added this.\n\nThird.");

        expect(outcome).toBe("applied");
        expect(v.state.doc.childCount).toBe(4);
        undo(v.state, v.dispatch);
        expect(v.state.doc.childCount).toBe(3);
    });

    it("the agent's insertion should land after the request's block even when the user typed above it", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        // The user keeps writing in the first paragraph while the agent works.
        placeCaret(v, endOfBlock(v, 0));
        typeText(v, " And more, typed while waiting.");

        const outcome = merge(editor, id, "First paragraph.\n\nSecond paragraph.\n\nAgent added this.\n\nThird.");

        expect(outcome).toBe("applied");
        const texts = Array.from({ length: v.state.doc.childCount }, (_, i) => v.state.doc.child(i).textContent);
        expect(texts).toEqual([
            "First paragraph. And more, typed while waiting.",
            "Second paragraph.",
            "Agent added this.",
            "Third.",
        ]);
    });

    it("an agent change to a range the user deleted meanwhile should be refused, not guessed", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        // The user deletes the very paragraph the agent rewrites.
        const start = endOfBlock(v, 1) + 1;
        const end = endOfBlock(v, 2) + 1;
        v.dispatch(v.state.tr.delete(start, end));
        expect(v.state.doc.childCount).toBe(2);

        const outcome = merge(editor, id, "First paragraph.\n\nSecond paragraph.\n\nThird, rewritten by the agent.");

        expect(outcome).toBe("conflict");
        expect(v.state.doc.childCount).toBe(2);
    });

    it("a document with a heading (whose id a plugin stamps after parsing) should still merge", async () => {
        // The live heading carries an `id` no fresh parse has; a merge that
        // compared docs raw refused every document with a heading.
        await editor.destroy();
        editor = await makeEditor("# Title\n\nFirst paragraph.\n\nSecond.");
        v = view(editor);
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        placeCaret(v, endOfBlock(v, 2));
        typeText(v, " Typed meanwhile.");

        const outcome = merge(editor, id, "# Title\n\nFirst paragraph.\n\nAgent added this.\n\nSecond.");

        expect(outcome).toBe("applied");
        const texts = Array.from({ length: v.state.doc.childCount }, (_, i) => v.state.doc.child(i).textContent);
        expect(texts).toEqual(["Title", "First paragraph.", "Agent added this.", "Second. Typed meanwhile."]);
    });

    it("typing INSIDE the range the agent rewrote should be a conflict, never silently overwritten", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        // The user types into the very word the agent rewrites.
        const secondStart = endOfBlock(v, 0) + 2;
        placeCaret(v, secondStart + 3);
        typeText(v, "XX");
        expect(v.state.doc.child(1).textContent).toBe("SecXXond paragraph.");

        const outcome = merge(editor, id, "First paragraph.\n\nSECOND paragraph.\n\nThird.");

        expect(outcome).toBe("conflict");
        expect(v.state.doc.child(1).textContent).toBe("SecXXond paragraph.");
    });

    it("the agent's merged edit should be its own undo step, not grouped with the keystroke before it", () => {
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        placeCaret(v, endOfBlock(v, 0));
        typeText(v, " Typed.");

        expect(merge(editor, id, "First paragraph.\n\nSecond paragraph.\n\nAgent added this.\n\nThird.")).toBe("applied");
        undo(v.state, v.dispatch);

        // The agent's paragraph is gone, the user's keystroke stays.
        expect(v.state.doc.childCount).toBe(3);
        expect(v.state.doc.child(0).textContent).toBe("First paragraph. Typed.");
    });

    it("an unchanged file should report unchanged and touch nothing", () => {
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        expect(merge(editor, id, "First paragraph.\n\nSecond paragraph.\n\nThird.")).toBe("unchanged");
    });

    it("an unknown run id should report conflict", () => {
        expect(merge(editor, "nope", "x")).toBe("conflict");
    });
});

/**
 * The corpus sweep the heading defect would have failed: on every fixture the
 * editor opens with the production presets, a run begins at the end of the
 * first block, the user types after it, and the agent's result is the file
 * with a paragraph appended. Every one must merge as `applied` (a
 * `partial` or `conflict` here means a construct the merge cannot see past),
 * and the sweep asserts its own size.
 */
describe("applyAgentResult over the corpus", () => {
    const fixtures = loadCorpusFixtures();

    it("should have a corpus to sweep", () => {
        expect(fixtures.length).toBeGreaterThan(20);
    });

    it("a trailing insertion should apply on every fixture after the user typed elsewhere", async () => {
        const refused: string[] = [];
        for (const fixture of fixtures) {
            const ed = await makeCorpusEditor(fixture.content, [historyPlugin, agentPendingPlugin]);
            const ev = editorView(ed);
            try {
                placeCaret(ev, endOfBlock(ev, 0));
                const id = beginAgentRun(ev);
                markAgentRunning(ev, id);
                // A keystroke that lands inside the first block, whatever kind
                // it is; a block that refuses text (a rule) is left alone.
                try { typeText(ev, " x"); } catch { /* not a textblock */ }
                const outcome = ed.action((ctx) => applyAgentResult(
                    ev, id, fixture.content.replace(/\s*$/, "") + "\n\nAgent added this paragraph.\n",
                    (md) => ctx.get(parserCtx)(md) as ProseNode | null,
                ));
                if (outcome !== "applied") { refused.push(`${fixture.name}: ${outcome}`); }
            } finally {
                await ed.destroy();
            }
        }
        expect(refused).toEqual([]);
    }, 120_000);
});
