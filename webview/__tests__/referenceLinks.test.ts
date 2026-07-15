/**
 * Reference-style links and HTML comments: visible in the editor, faithful
 * on disk. Drives the REAL Milkdown editor with the production serialization
 * config (which filters remark-inline-links and registers the
 * reference-link schemas) — no mocks.
 *
 * Before this feature, remark-inline-links rewrote `[text][ref]` into inline
 * links and deleted `[ref]: url` definitions before ProseMirror ever saw
 * them, and DOMPurify sanitized HTML comments into invisible empty spans.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, nodeViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { createHtmlView } from "../editor";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
            // Same html NodeView the production editor registers, so comment
            // chips are exercised in-document.
            ctx.set(nodeViewCtx, [
                ["html", (node: { attrs: Record<string, string> }) => createHtmlView(node)],
            ]);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

function docNodeNames(editor: Editor): string[] {
    return editor.action((ctx) => {
        const names: string[] = [];
        ctx.get(editorViewCtx).state.doc.descendants((node) => {
            names.push(node.type.name);
        });
        return names;
    });
}

describe("reference-link definitions should be visible and round-trip", () => {
    it("a full reference link and its definition should serialize back in reference form", async () => {
        const saved = "See [the docs][docs] here.\n\n[docs]: https://example.com\n";
        const editor = await makeEditor(saved);

        expect(docNodeNames(editor)).toContain("link_definition");
        expect(editor.action(getMarkdown())).toBe(saved);
        await editor.destroy();
    });

    it("a definition with a title should keep the title", async () => {
        const saved = 'Link [x][api].\n\n[api]: https://example.com/api "API Guide"\n';
        const editor = await makeEditor(saved);

        expect(editor.action(getMarkdown())).toBe(saved);
        await editor.destroy();
    });

    it("collapsed and shortcut references should keep their reference form", async () => {
        const saved =
            "Collapsed [docs][] and shortcut [docs] forms.\n\n[docs]: https://example.com\n";
        const editor = await makeEditor(saved);

        expect(editor.action(getMarkdown())).toBe(saved);
        await editor.destroy();
    });

    it("an image reference should round-trip and render as a chip", async () => {
        const saved = "Before ![logo][img] after.\n\n[img]: logo.png\n";
        const editor = await makeEditor(saved);

        expect(docNodeNames(editor)).toContain("image_ref");
        expect(editor.action(getMarkdown())).toBe(saved);
        await editor.destroy();
    });

    it("the definition should render as a visible read-only line in the editor DOM", async () => {
        const editor = await makeEditor("See [x][docs].\n\n[docs]: https://example.com\n");

        const el = editor.action((ctx) =>
            ctx.get(editorViewCtx).dom.querySelector('[data-type="link-definition"]'),
        );
        expect(el).not.toBeNull();
        expect(el!.textContent).toContain("[docs]: https://example.com");
        expect((el as HTMLElement).getAttribute("contenteditable")).toBe("false");
        await editor.destroy();
    });

    it("editing a paragraph next to a reference link should not inline it", async () => {
        const saved = "intro\n\nSee [the docs][docs] here.\n\n[docs]: https://example.com\n";
        const editor = await makeEditor(saved);
        const protection = computeRoundTripProtection(saved, editor.action(getMarkdown()));

        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(view.state.tr.insertText(" EDIT", 6));
        });
        const merged = applyMinimalChanges(saved, editor.action(getMarkdown()), protection);

        expect(merged).toContain("intro EDIT");
        expect(merged).toContain("See [the docs][docs] here.");
        expect(merged).toContain("[docs]: https://example.com");
        await editor.destroy();
    });
});

describe("HTML comments should be visible as chips", () => {
    it("a comment html node should render its raw text in a dimmed chip", () => {
        const view = createHtmlView({ attrs: { value: "<!-- editorial note -->" } });

        expect(view.dom.className).toContain("html-comment");
        expect(view.dom.textContent).toBe("<!-- editorial note -->");
    });

    it("a non-comment html node should keep the sanitized rendering path", () => {
        const view = createHtmlView({ attrs: { value: "<sub>x</sub>" } });

        expect(view.dom.className).not.toContain("html-comment");
        expect(view.dom.innerHTML).toContain("<sub>x</sub>");
    });

    it("a comment inside a document should be present and visible after load", async () => {
        const saved = "before\n\n<!-- keep me -->\n\nafter\n";
        const editor = await makeEditor(saved);

        const chip = editor.action((ctx) =>
            ctx.get(editorViewCtx).dom.querySelector(".html-comment"),
        );
        expect(chip).not.toBeNull();
        expect(chip!.textContent).toBe("<!-- keep me -->");
        expect(editor.action(getMarkdown())).toBe(saved);
        await editor.destroy();
    });
});
