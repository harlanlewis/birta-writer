/**
 * Editable HTML (MAR-14): the source panel on the html NodeView, and the
 * live inline-pair decorations. Drives the REAL Milkdown editor with the
 * production serialization config, NodeView, and plugin — no mocks — so a
 * commit's bytes are asserted where they matter: in the serialized markdown.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, nodeViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { NodeSelection } from "../pm";
import { createHtmlView, HTML_EDIT_EVENT } from "../components/htmlView";
import { htmlEditKeymapPlugin, htmlLivePairsPlugin, pairsInBlock } from "../plugins/htmlLivePairs";
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
        .use(htmlLivePairsPlugin)
        .use(htmlEditKeymapPlugin)
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

function getView(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** The DOM of the first html atom in the document. */
function firstHtmlDom(view: EditorView): { dom: HTMLElement; pos: number } {
    let found: { dom: HTMLElement; pos: number } | null = null;
    view.state.doc.descendants((node, pos) => {
        if (!found && node.type.name === "html") {
            found = { dom: view.nodeDOM(pos) as HTMLElement, pos };
            return false;
        }
        return true;
    });
    if (!found) {
        throw new Error("no html atom in document");
    }
    return found;
}

describe("html source panel", () => {
    it("opening via the edit event should show a textarea holding the raw bytes", async () => {
        const editor = await makeEditor("Before <sub>x</sub> after.\n");
        const view = getView(editor);
        const { dom } = firstHtmlDom(view);

        dom.dispatchEvent(new CustomEvent(HTML_EDIT_EVENT));

        const area = dom.querySelector("textarea.html-src") as HTMLTextAreaElement;
        expect(area).not.toBeNull();
        expect(area.value).toBe("<sub>");
        expect(dom.classList.contains("html-inline--editing")).toBe(true);
        await editor.destroy();
    });

    it("committing an edited value should serialize the new bytes verbatim", async () => {
        const editor = await makeEditor("Note <!-- old note --> here.\n");
        const view = getView(editor);
        const { dom } = firstHtmlDom(view);

        dom.dispatchEvent(new CustomEvent(HTML_EDIT_EVENT));
        const area = dom.querySelector("textarea.html-src") as HTMLTextAreaElement;
        area.value = "<!-- new note -->";
        area.dispatchEvent(new Event("blur"));

        expect(editor.action(getMarkdown())).toBe("Note <!-- new note --> here.\n");
        await editor.destroy();
    });

    it("escape should cancel without touching the document", async () => {
        const saved = "Note <!-- keep me --> here.\n";
        const editor = await makeEditor(saved);
        const view = getView(editor);
        const { dom } = firstHtmlDom(view);

        dom.dispatchEvent(new CustomEvent(HTML_EDIT_EVENT));
        const area = dom.querySelector("textarea.html-src") as HTMLTextAreaElement;
        area.value = "<!-- discarded -->";
        area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

        expect(dom.querySelector("textarea.html-src")).toBeNull();
        expect(editor.action(getMarkdown())).toBe(saved);
        await editor.destroy();
    });

    it("committing an emptied value should delete the node", async () => {
        const editor = await makeEditor("Note <!-- goner --> here.\n");
        const view = getView(editor);
        const { dom } = firstHtmlDom(view);

        dom.dispatchEvent(new CustomEvent(HTML_EDIT_EVENT));
        const area = dom.querySelector("textarea.html-src") as HTMLTextAreaElement;
        area.value = "";
        area.dispatchEvent(new Event("blur"));

        let htmlCount = 0;
        view.state.doc.descendants((node) => {
            if (node.type.name === "html") {
                htmlCount += 1;
            }
        });
        expect(htmlCount).toBe(0);
        await editor.destroy();
    });

    it("a comment chip should open the same panel on click", async () => {
        const editor = await makeEditor("<!-- editorial -->\n");
        const view = getView(editor);
        const { dom } = firstHtmlDom(view);

        dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(dom.querySelector("textarea.html-src")).not.toBeNull();
        await editor.destroy();
    });

    it("Mod+Enter on a NodeSelection'd html atom should open the panel", async () => {
        const editor = await makeEditor("Before <sub>x</sub> after.\n");
        const view = getView(editor);
        const { dom, pos } = firstHtmlDom(view);

        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
        // jsdom's navigator is not a Mac to prosemirror-keymap, so Mod = Ctrl.
        view.someProp("handleKeyDown", (f) =>
            f(view, new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true })));

        expect(dom.querySelector("textarea.html-src")).not.toBeNull();
        await editor.destroy();
    });
});

describe("live inline pairs", () => {
    it("a matched pair should decorate the text between and dim both tags", async () => {
        const editor = await makeEditor("Press <kbd>Ctrl</kbd> to run.\n");
        const view = getView(editor);

        const live = view.dom.querySelector(".html-live-kbd");
        expect(live).not.toBeNull();
        expect(live!.textContent).toBe("Ctrl");
        expect(view.dom.querySelectorAll(".html-tag--paired").length).toBe(2);
        await editor.destroy();
    });

    it("an unclosed tag should decorate nothing", async () => {
        const editor = await makeEditor("An <u> alone here.\n");
        const view = getView(editor);

        expect(view.dom.querySelector(".html-live-u")).toBeNull();
        expect(view.dom.querySelectorAll(".html-tag--paired").length).toBe(0);
        await editor.destroy();
    });

    it("an attributed open tag should stay out of scope", async () => {
        const editor = await makeEditor('A <mark class="x">word</mark> here.\n');
        const view = getView(editor);

        expect(view.dom.querySelector(".html-live-mark")).toBeNull();
        await editor.destroy();
    });

    it("typing inside a pair should keep the decoration over the grown text", async () => {
        const editor = await makeEditor("A <u>word</u> here.\n");
        const view = getView(editor);
        const before = view.dom.querySelector(".html-live-u");
        expect(before?.textContent).toBe("word");

        // Insert text inside the pair (after "word"'s first character).
        let insertAt = -1;
        view.state.doc.descendants((node, pos) => {
            if (insertAt < 0 && node.isText && node.text?.includes("word")) {
                insertAt = pos + 2;
            }
        });
        view.dispatch(view.state.tr.insertText("XX", insertAt));

        const after = view.dom.querySelector(".html-live-u");
        expect(after?.textContent).toBe("woXXrd");
        await editor.destroy();
    });

    it("deleting the closing tag should withdraw the decoration", async () => {
        const editor = await makeEditor("A <u>word</u> here.\n");
        const view = getView(editor);
        expect(view.dom.querySelector(".html-live-u")).not.toBeNull();

        // Delete the closing </u> atom.
        let closePos = -1;
        view.state.doc.descendants((node, pos) => {
            if (node.type.name === "html" && node.attrs["value"] === "</u>") {
                closePos = pos;
            }
        });
        expect(closePos).toBeGreaterThan(0);
        view.dispatch(view.state.tr.delete(closePos, closePos + 1));

        expect(view.dom.querySelector(".html-live-u")).toBeNull();
        await editor.destroy();
    });

    it("pairsInBlock should match innermost-first for nested same-name tags", async () => {
        const editor = await makeEditor("A <u>x <u>y</u> z</u> end.\n");
        const view = getView(editor);
        let block: { node: import("../pm").Node; pos: number } | null = null;
        view.state.doc.descendants((node, pos) => {
            if (!block && node.isTextblock) {
                block = { node, pos };
            }
            return false;
        });
        const pairs = pairsInBlock(block!.node, block!.pos + 1);
        expect(pairs.length).toBe(2);
        // The first close pairs with the NEAREST open (innermost).
        expect(pairs[0]!.openFrom).toBeGreaterThan(pairs[1]!.openFrom);
        await editor.destroy();
    });

    it("decoration is presentation only: the document should serialize unchanged", async () => {
        const saved = "Press <kbd>Ctrl</kbd> and <u>hold</u>.\n";
        const editor = await makeEditor(saved);
        expect(editor.action(getMarkdown())).toBe(saved);
        await editor.destroy();
    });
});
