/**
 * The `/ai` run marker and its two policies (plugins/agentPending.ts), driven
 * on the real Milkdown editor: the marker shows only once the extension
 * confirms a background run and rides the document as the user types; an
 * inbound external change enters the undo history only while a run is live;
 * and a dirty-document result merges around the user's edits through the
 * position mapping the run accumulated, refusing where they collide.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, serializerCtx } from "@milkdown/core";
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
        (doc) => ctx.get(serializerCtx)(doc),
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

    it("an unchanged file should report unchanged and touch nothing", () => {
        const id = beginAgentRun(v);
        markAgentRunning(v, id);
        expect(merge(editor, id, "First paragraph.\n\nSecond paragraph.\n\nThird.")).toBe("unchanged");
    });

    it("an unknown run id should report conflict", () => {
        expect(merge(editor, "nope", "x")).toBe("conflict");
    });
});
