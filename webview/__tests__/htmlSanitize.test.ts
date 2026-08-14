/**
 * The rendered face of an html atom is output, not a surface (MAR-366).
 *
 * Three contracts: a document's `<style>` never applies, a `style` attribute
 * cannot leave the atom's box, and nothing rendered can take focus. The first
 * two are asserted against the REAL sanitize path (the production config and
 * the hook installed with the module), because the defect they close was the
 * config's behavior differing from what its call site assumed.
 *
 * What jsdom cannot answer is whether a surviving `<style>` would actually
 * have applied, or a fixed div actually escaped: that needs a layout engine,
 * and `e2e/inlineHtml` asserts it there.
 */
import { describe, it, expect, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, nodeViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { createHtmlView } from "../components/htmlView";
import { filterStyleAttribute } from "../utils/sanitizeLoader";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
            ctx.set(nodeViewCtx, [
                ["html", (node, view, getPos) => createHtmlView(node, view, getPos)],
            ]);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

function getView(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** The DOM of the first html atom, once its (async) sanitize has landed. */
async function paintedHtmlDom(view: EditorView): Promise<HTMLElement> {
    let found: HTMLElement | null = null;
    view.state.doc.descendants((node, pos) => {
        if (!found && node.type.name === "html") {
            found = view.nodeDOM(pos) as HTMLElement;
            return false;
        }
        return true;
    });
    if (!found) {
        throw new Error("no html atom in document");
    }
    const dom = found as HTMLElement;
    // The sanitizer is behind a dynamic import, so the face lands a task or
    // two after mount. Wait for the CONTENT, not for the class: paint() sets
    // the class synchronously, so a class-based wait returns before the face
    // exists and every "nothing dangerous is here" assertion then passes
    // against an empty node.
    await vi.waitFor(() => expect(dom.childElementCount).toBeGreaterThan(0));
    return dom;
}

describe("filterStyleAttribute", () => {
    it("presentational declarations should survive verbatim", () => {
        expect(filterStyleAttribute("text-align:center; color:red")).toBe("text-align:center; color:red");
        expect(filterStyleAttribute("width: 60%")).toBe("width: 60%");
    });

    it("a declaration that leaves the flow should be dropped, keeping its neighbours", () => {
        expect(filterStyleAttribute("position:fixed;inset:0;background:red")).toBe("inset:0; background:red");
        expect(filterStyleAttribute("z-index: 99; color: blue")).toBe("color: blue");
    });

    it("a value sized against the viewport should be dropped", () => {
        expect(filterStyleAttribute("height:100vh")).toBe("");
        expect(filterStyleAttribute("width:50dvw; color:red")).toBe("color:red");
        expect(filterStyleAttribute("margin:1vmin")).toBe("");
    });

    it("a semicolon inside a url should not be read as a separator", () => {
        const decl = "background:url(data:image/gif;base64,R0lGOD)";
        expect(filterStyleAttribute(decl)).toBe(decl);
        expect(filterStyleAttribute(`${decl};position:fixed`)).toBe(decl);
    });

    it("a value with no surviving declaration should come back empty", () => {
        expect(filterStyleAttribute("position:absolute")).toBe("");
        expect(filterStyleAttribute("garbage")).toBe("");
        expect(filterStyleAttribute("")).toBe("");
    });
});

describe("a document's style element", () => {
    it("a nested <style> should reach the document as neither a rule nor text", async () => {
        const editor = await makeEditor("<div><style>.ProseMirror{display:none}</style>text</div>\n");
        const dom = await paintedHtmlDom(getView(editor));

        expect(dom.querySelector("style")).toBeNull();
        expect(dom.textContent).not.toContain("display:none");
        expect(dom.textContent).toContain("text");
        await editor.destroy();
    });

    it("a <style> block on its own should render as the chip, not as nothing", async () => {
        const editor = await makeEditor("<style>\n.ProseMirror { display: none }\n</style>\n");
        const dom = await paintedHtmlDom(getView(editor));

        expect(dom.classList.contains("html-css-source")).toBe(true);
        expect(dom.querySelector("style")).toBeNull();
        // The chip shows the source it is refusing to apply.
        expect(dom.textContent).toContain(".ProseMirror { display: none }");
        await editor.destroy();
    });

    it("a refused <style> should still round-trip to the file byte for byte", async () => {
        const source = "<style>\n.ProseMirror { display: none }\n</style>\n";
        const editor = await makeEditor(source);
        await paintedHtmlDom(getView(editor));

        expect(editor.action(getMarkdown())).toBe(source);
        await editor.destroy();
    });
});

describe("filtering is a rendering decision, never a file one", () => {
    it("a dropped declaration should still be in the file, byte for byte", async () => {
        const source = '<div style="position: fixed; inset: 0; height: 100vh">x</div>\n';
        const editor = await makeEditor(source);
        const dom = await paintedHtmlDom(getView(editor));

        // Filtered where it is drawn...
        expect(dom.querySelector("div")?.getAttribute("style")).toBe("inset: 0");
        // ...and untouched where it is saved. This is the whole contract: the
        // sanitizer decides what the editor DRAWS and never what the file says.
        expect(editor.action(getMarkdown())).toBe(source);
        await editor.destroy();
    });

    it("a style attribute with nothing left should leave no empty attribute behind", async () => {
        const editor = await makeEditor('<div style="position: absolute">x</div>\n');
        const dom = await paintedHtmlDom(getView(editor));

        expect(dom.querySelector("div")?.hasAttribute("style")).toBe(false);
        await editor.destroy();
    });
});

describe("the rendered face and focus", () => {
    it("a rendered control should be taken out of the tab order", async () => {
        const editor = await makeEditor("Press <button>go</button> now.\n");
        const dom = await paintedHtmlDom(getView(editor));

        const button = dom.querySelector("button");
        expect(button).not.toBeNull();
        expect(button?.getAttribute("tabindex")).toBe("-1");
        await editor.destroy();
    });

    it("an authored tabindex should not survive as a stop", async () => {
        const editor = await makeEditor('<div tabindex="3">x</div>\n');
        const dom = await paintedHtmlDom(getView(editor));

        expect(dom.querySelector("[tabindex]")?.getAttribute("tabindex")).toBe("-1");
        await editor.destroy();
    });

    it("a summary should keep its native focus, since its toggle is the one interaction kept", async () => {
        const editor = await makeEditor("<details><summary>s</summary>body</details>\n");
        const dom = await paintedHtmlDom(getView(editor));

        const summary = dom.querySelector("summary");
        expect(summary).not.toBeNull();
        expect(summary?.hasAttribute("tabindex")).toBe(false);
        await editor.destroy();
    });
});
