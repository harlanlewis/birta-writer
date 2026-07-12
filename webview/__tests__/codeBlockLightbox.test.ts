/**
 * Regression tests for the code-block lightbox's Escape-layer lifecycle:
 *
 *   - the layer entry and the document key listener must unregister
 *     SYNCHRONOUSLY when the close path starts, not on the close fade's
 *     animationend — a second Escape during the fade used to be swallowed
 *     by the still-registered entry and re-ran the close;
 *   - destroy() (NodeView dies with the lightbox open — external sync /
 *     revert) must run the dismiss cleanup, or a dead layer entry silently
 *     swallowed the next Escape and the document listener leaked.
 *
 * jsdom never fires animationend, which makes the synchronous behavior
 * directly observable: after one close the overlay is still in the DOM
 * (mid-"fade") but the stack and listener must already be gone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { createCodeBlockView } from "../components/codeBlock";
import { closeTopmostLayer } from "../ui/escapeLayers";

let editors: Editor[] = [];

type CodeBlockNodeView = ReturnType<typeof createCodeBlockView>;

async function makeCodeBlockView(md: string): Promise<CodeBlockNodeView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
        })
        .use(commonmark)
        .use(gfm)
        .create();
    editors.push(editor);

    let view!: EditorView;
    let node: PMNode | null = null;
    let pos = -1;
    editor.action((ctx) => {
        view = ctx.get(editorViewCtx);
        view.state.doc.descendants((n, p) => {
            if (n.type.name === "code_block") {
                node = n;
                pos = p;
                return false;
            }
            return true;
        });
    });
    expect(node).not.toBeNull();
    return createCodeBlockView(node!, view, () => pos);
}

function openLightbox(nv: CodeBlockNodeView): HTMLElement {
    const btn = nv.dom.querySelector<HTMLElement>(".code-block-fullscreen-btn");
    expect(btn).not.toBeNull();
    btn!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    const overlay = document.body.querySelector<HTMLElement>(".code-editor-lightbox");
    expect(overlay).not.toBeNull();
    return overlay!;
}

/** Dispatch a cancelable document-level Escape; returns defaultPrevented. */
function documentEscapeConsumed(): boolean {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented;
}

beforeEach(() => {
    // Drain layer entries left behind by other tests (module-level stack).
    while (closeTopmostLayer()) { /* drain */ }
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
    document.body.style.overflow = "";
});

describe("code lightbox Escape-layer lifecycle", () => {
    it("opening should register exactly one Escape layer", async () => {
        const nv = await makeCodeBlockView("```js\nconst a = 1;\n```\n");
        openLightbox(nv);
        expect(closeTopmostLayer()).toBe(true); // pops AND closes the lightbox
        expect(closeTopmostLayer()).toBe(false);
    });

    it("closing should unregister the layer and key listener synchronously, before the fade ends", async () => {
        const nv = await makeCodeBlockView("```js\nconst a = 1;\n```\n");
        const overlay = openLightbox(nv);

        // First Escape via the document fallback: consumed, close starts.
        expect(documentEscapeConsumed()).toBe(true);
        // The fade has NOT finished (jsdom fires no animationend): the
        // overlay is still up, mid-close...
        expect(document.body.contains(overlay)).toBe(true);
        expect(overlay.classList.contains("lb-closing")).toBe(true);
        // ...but the layer entry and the document listener are already gone,
        // so a second Escape falls through instead of re-running the close.
        expect(closeTopmostLayer()).toBe(false);
        expect(documentEscapeConsumed()).toBe(false);
    });

    it("closing via the layer stack (editor-focused Escape) should also tear down synchronously", async () => {
        const nv = await makeCodeBlockView("```js\nconst a = 1;\n```\n");
        const overlay = openLightbox(nv);

        expect(closeTopmostLayer()).toBe(true); // blockKeys' wiring path
        expect(document.body.contains(overlay)).toBe(true); // still fading
        expect(closeTopmostLayer()).toBe(false);
        expect(documentEscapeConsumed()).toBe(false); // doc listener gone too
    });

    it("destroy() with the lightbox open should clean the stack, listener, DOM, and scroll lock", async () => {
        const nv = await makeCodeBlockView("```js\nconst a = 1;\n```\n");
        const overlay = openLightbox(nv);
        expect(document.body.style.overflow).toBe("hidden"); // scroll locked

        nv.destroy();

        expect(document.body.contains(overlay)).toBe(false);
        expect(closeTopmostLayer()).toBe(false); // no dead layer entry
        expect(documentEscapeConsumed()).toBe(false); // no leaked doc listener
        expect(document.body.style.overflow).toBe(""); // scroll unlocked
    });

    it("destroy() after a normal close should be a clean no-op", async () => {
        const nv = await makeCodeBlockView("```js\nconst a = 1;\n```\n");
        openLightbox(nv);
        expect(closeTopmostLayer()).toBe(true);
        nv.destroy();
        expect(closeTopmostLayer()).toBe(false);
        expect(documentEscapeConsumed()).toBe(false);
    });
});
