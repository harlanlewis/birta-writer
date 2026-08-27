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
import { HOST_PROFILES } from "../../shared/hostProfile";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    agentPendingPlugin,
    agentRun,
    applyAgentResult,
    beginAgentRun,
    failAgentRun,
    AGENT_TOAST_SURFACE,
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

    /**
     * The toast is for a host with no notification surface of its own.
     *
     * A jsdom page declares nothing, which means the VS Code profile, and VS
     * Code raises its own error notification for a failed run. So the arms
     * below declare the Mac app's profile explicitly, and the last one puts the VS
     * Code profile back and checks the corner stays empty. That pair is what
     * makes any of this discriminate: without it a version that always spoke
     * and a version that never spoke would both pass one of them.
     */
    const asMac = (): void => {
        (globalThis as { __i18n?: unknown }).__i18n = {
            host: { capabilities: HOST_PROFILES.mac },
        };
    };

    afterEach(() => { delete (globalThis as { __i18n?: unknown }).__i18n; });

    it("a failed run on a host with its own notifications should say nothing in the corner", () => {
        // The VS Code profile, which is what declaring nothing means.
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id, "claude");

        failAgentRun(v, id, "exit 1", "claude");

        expect(markers()).toHaveLength(0, "the marker still goes: it is for a run that can be stopped");
        const toast = document.querySelector(`.${AGENT_TOAST_SURFACE}`);
        expect(toast?.classList.contains(`${AGENT_TOAST_SURFACE}--visible`) ?? false).toBe(false);
    });

    it("a failed run should leave no marker and say why in a toast", () => {
        asMac();
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id, "claude");
        // The instrument reached something: while it was running there WAS a
        // marker, so an empty gutter below is the failure clearing it rather
        // than a run that never showed one.
        expect(markers()).toHaveLength(1);

        failAgentRun(v, id, "exit 1");

        expect(markers()).toHaveLength(0);
        expect(agentRun(v, id)).toBeNull();
        const toast = document.querySelector(`.${AGENT_TOAST_SURFACE}`);
        expect(toast?.textContent).toContain("exit 1");
        // The tool is named, or the reason belongs to nothing the reader can
        // act on.
        expect(toast?.textContent).toContain("claude");
        expect(toast?.classList.contains("ui-notice--error")).toBe(true);
        expect(toast?.classList.contains(`${AGENT_TOAST_SURFACE}--visible`)).toBe(true);
    });

    /// A command that is not installed fails before anything reports what is
    /// running it, which is exactly the failure people meet first.
    it("a failure reported before the run was confirmed should still name the tool", () => {
        asMac();
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        // No markAgentRunning: the run is still `armed`, so nothing in state
        // knows the harness and only the report can say.
        expect(agentRun(v, id)?.harness).toBeUndefined();

        failAgentRun(v, id, "command not found", "claude");

        expect(document.querySelector(`.${AGENT_TOAST_SURFACE}`)?.textContent)
            .toContain("claude");
    });

    it("a failed run with no reason should still name the tool in the toast", () => {
        asMac();
        placeCaret(v, endOfBlock(v, 1));
        const id = beginAgentRun(v);
        markAgentRunning(v, id, "codex");

        failAgentRun(v, id, "   ");

        const toast = document.querySelector(`.${AGENT_TOAST_SURFACE}`);
        expect(toast?.textContent).toContain("codex");
        // Never a bare "codex: " with nothing after the colon.
        expect(toast?.textContent?.trim().endsWith(":")).toBe(false);
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
