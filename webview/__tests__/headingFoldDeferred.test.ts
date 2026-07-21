/**
 * MAR-189: the fold plugin keeps its pure-affordance decoration build OFF the
 * mount path when nothing is folded — `init` returns an empty DecorationSet and
 * `view()` rebuilds it after first paint via a `requestIdleCallback`.
 *
 * The other fold suites run jsdom's EAGER path: jsdom has no
 * `requestIdleCallback`, and the deferral is deliberately gated on its presence
 * so tests keep the synchronous "markers exist right after create" contract.
 * That means the production DEFERRED path had no coverage. This file installs a
 * controllable `requestIdleCallback` mock to exercise it, and asserts the eager
 * fallback still holds when it's absent.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin, headingFoldPluginKey } from "../plugins/headingFold";

let editors: Editor[] = [];
let idleCallbacks: Array<() => void> = [];

type IdleGlobal = { requestIdleCallback?: unknown; cancelIdleCallback?: unknown };

/** Install a `requestIdleCallback` that captures callbacks so the test fires them. */
function installIdleMock(): void {
    idleCallbacks = [];
    (globalThis as IdleGlobal).requestIdleCallback = vi.fn((cb: () => void) => {
        idleCallbacks.push(cb);
        return idleCallbacks.length;
    });
    (globalThis as IdleGlobal).cancelIdleCallback = vi.fn();
}
function removeIdleMock(): void {
    delete (globalThis as IdleGlobal).requestIdleCallback;
    delete (globalThis as IdleGlobal).cancelIdleCallback;
}
function flushIdle(): void {
    const pending = idleCallbacks;
    idleCallbacks = [];
    for (const cb of pending) { cb(); }
}

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
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));
const foldState = (editor: Editor) => headingFoldPluginKey.getState(view(editor).state)!;

const HEADING_DOC = "# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n";

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    removeIdleMock();
    document.body.innerHTML = "";
});

describe("MAR-189: fold affordance decoration deferral", () => {
    beforeEach(() => { installIdleMock(); });

    it("with nothing folded, defers the decoration build off create and materializes it on idle", async () => {
        const editor = await makeEditor(HEADING_DOC);

        // Deferred through create: empty decorations, no markers rendered yet,
        // and an idle callback scheduled for after first paint. (This is the
        // regression the flag-based scheduling missed — `view()` must schedule
        // the build despite Milkdown's setup transactions, or the markers would
        // never appear.)
        expect(foldState(editor).decorations.find().length).toBe(0);
        expect(document.querySelector(".heading-fold-marker")).toBeNull();
        expect(idleCallbacks.length).toBeGreaterThan(0);

        // After the post-paint idle callback fires, the affordance is built.
        flushIdle();
        expect(foldState(editor).decorations.find().length).toBeGreaterThan(0);
        expect(document.querySelector(".heading-fold-marker")).not.toBeNull();
    });

    it("does not schedule a second build once materialized", async () => {
        const editor = await makeEditor(HEADING_DOC);
        flushIdle();
        // The build ran; nothing re-arms the idle.
        expect(foldState(editor).decorations.find().length).toBeGreaterThan(0);
        expect(idleCallbacks.length).toBe(0);
    });
});

describe("MAR-189: eager fallback without requestIdleCallback (the jsdom/test contract)", () => {
    beforeEach(() => { removeIdleMock(); });

    it("builds the decorations synchronously at create — no deferral", async () => {
        const editor = await makeEditor(HEADING_DOC);
        // Without a post-paint scheduler we must not defer: markers exist the
        // moment create resolves, which is what every other fold suite relies on.
        expect(foldState(editor).affordanceDeferred).toBeFalsy();
        expect(foldState(editor).decorations.find().length).toBeGreaterThan(0);
        expect(document.querySelector(".heading-fold-marker")).not.toBeNull();
    });
});
