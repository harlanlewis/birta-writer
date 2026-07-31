/**
 * Backtick-over-a-selection wraps in inline code (webview/plugins/backtickWrap.ts).
 *
 * Driven through the REAL editor's `handleTextInput` prop, which is the seam
 * the plugin registers on — the same shape as highlight.test.ts / wikiLinks.
 * The prop level cannot answer WHICH registered handler wins a real keystroke
 * (the input-rule runner shares this prop); that is pinned in
 * e2e/notesFeatures, dispatching real key events against the production bundle.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { backtickWrapPlugin } from "../plugins/backtickWrap";

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
        .use(backtickWrapPlugin)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));
const markdown = (editor: Editor): string =>
    editor.action((ctx) => ctx.get(serializerCtx)(view(editor).state.doc));

/** Selects [from, to) and feeds `ch` through the text-input prop, exactly as
 *  ProseMirror does when a character is typed over a selection. */
function typeOverSelection(v: EditorView, from: number, to: number, ch: string): boolean {
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));
    return v.someProp("handleTextInput", (f) => f(v, from, to, ch)) ?? false;
}

beforeEach(() => {
    document.body.innerHTML = "";
});

afterEach(async () => {
    for (const e of editors) { await e.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("backtick over a selection", () => {
    it("a selected word should be wrapped in inline code, not replaced", async () => {
        const editor = await makeEditor("run npm install now\n");
        const v = view(editor);
        // "npm install" — doc position 1 is the paragraph's first character.
        const from = 1 + "run ".length;
        const to = from + "npm install".length;

        expect(typeOverSelection(v, from, to, "`")).toBe(true);

        expect(v.state.doc.textContent).toBe("run npm install now");
        expect(markdown(editor).trim()).toBe("run `npm install` now");
    });

    it("applying it twice should toggle the mark back off", async () => {
        const editor = await makeEditor("run npm install now\n");
        const v = view(editor);
        const from = 1 + "run ".length;
        const to = from + "npm install".length;

        typeOverSelection(v, from, to, "`");
        expect(typeOverSelection(v, from, to, "`")).toBe(true);

        expect(markdown(editor).trim()).toBe("run npm install now");
    });

    it("an EMPTY selection should decline, so the `code` input rule still works", async () => {
        const editor = await makeEditor("run\n");
        const v = view(editor);

        expect(typeOverSelection(v, 4, 4, "`")).toBe(false);
        expect(v.state.doc.textContent).toBe("run");
    });

    it("any other character over a selection should decline", async () => {
        const editor = await makeEditor("run npm now\n");
        const v = view(editor);

        expect(typeOverSelection(v, 5, 8, "x")).toBe(false);
    });

    it("inside a code block a backtick should stay literal text", async () => {
        const editor = await makeEditor("```\nnpm install\n```\n");
        const v = view(editor);
        // Inside the fence: position 1 is the code block's first character.
        expect(typeOverSelection(v, 1, 1 + "npm".length, "`")).toBe(false);
    });

    it("a selection that already carries other marks should keep them", async () => {
        const editor = await makeEditor("run **npm install** now\n");
        const v = view(editor);
        const from = 1 + "run ".length;
        const to = from + "npm install".length;

        expect(typeOverSelection(v, from, to, "`")).toBe(true);
        // Strong survives; the code mark is added alongside it.
        expect(markdown(editor).trim()).toBe("run **`npm install`** now");
    });
});
