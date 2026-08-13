/**
 * Directive NodeView behavior through the real editor + production NodeView
 * (nodeViewCtx). Mutations asserted via getMarkdown(), non-mutations via
 * document reference equality (see calloutView.test.ts for the rationale).
 */
import { describe, it, expect } from "vitest";
import {
    Editor,
    rootCtx,
    defaultValueCtx,
    editorViewCtx,
    nodeViewCtx,
} from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { createDirectiveView } from "../components/directive";
import { foldPluginKey, headingFoldPlugin } from "../plugins/headingFold";
import { openFenceWithTitle, sanitizeDirectiveTitle } from "../plugins/directives";

async function makeEditor(markdown: string): Promise<{
    editor: Editor;
    container: HTMLElement;
    view: EditorView;
}> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
            ctx.set(nodeViewCtx, [["container_directive", createDirectiveView]]);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    return { editor, container, view };
}

const q = (root: HTMLElement, sel: string): HTMLElement => {
    const el = root.querySelector(sel);
    expect(el, `expected element ${sel}`).not.toBeNull();
    return el as HTMLElement;
};

describe("sanitizeDirectiveTitle / openFenceWithTitle", () => {
    it("strips characters a fence line cannot carry, keeps plain words", () => {
        expect(sanitizeDirectiveTitle("Plain words 2.0")).toBe("Plain words 2.0");
        expect(sanitizeDirectiveTitle("a *b* [c] `d` \\e &f {g}")).toBe("a b c d e f g");
    });

    it("rewrites the title while preserving colons, name, and {attrs}", () => {
        expect(openFenceWithTitle(":::note", "Hello")).toBe(":::note Hello");
        expect(openFenceWithTitle("::::tip Old title", "New")).toBe("::::tip New");
        expect(openFenceWithTitle(':::info Old {title="x"}', "New *bold*")).toBe(
            ':::info New bold {title="x"}',
        );
        expect(openFenceWithTitle(":::tip Old", "")).toBe(":::tip");
        expect(openFenceWithTitle(':::info Old {title="x"}', "")).toBe(':::info {title="x"}');
    });
});

describe("directive NodeView chrome", () => {
    it("renders the name badge and an editable title", async () => {
        const { editor, container } = await makeEditor(":::tip My title\nBody.\n:::\n");
        expect(q(container, ".directive-name").textContent).toBe("tip");
        const title = q(container, ".directive-title");
        expect(title.textContent).toBe("My title");
        expect(title.getAttribute("role")).toBe("textbox");
        await editor.destroy();
    });
});

describe("directive fold chrome (MAR-116)", () => {
    /** The chrome factory above plus the fold plugin, so the `collapsed`
     * decoration class actually reaches the NodeView. */
    async function makeFoldableEditor(markdown: string): Promise<{
        editor: Editor;
        container: HTMLElement;
        view: EditorView;
    }> {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, container);
                ctx.set(defaultValueCtx, markdown);
                configureSerialization(ctx);
                ctx.set(nodeViewCtx, [["container_directive", createDirectiveView]]);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .use(headingFoldPlugin)
            .create();
        const view = editor.action((ctx) => ctx.get(editorViewCtx));
        return { editor, container, view };
    }

    function directivePos(view: EditorView): number {
        let pos = -1;
        view.state.doc.descendants((node, offset) => {
            if (pos === -1 && node.type.name === "container_directive") pos = offset;
            return pos === -1;
        });
        expect(pos).toBeGreaterThanOrEqual(0);
        return pos;
    }

    it("a collapsed directive keeps its header and offers the … chip that expands it", async () => {
        const { editor, container, view } = await makeFoldableEditor(
            ":::tip Kept title\nBody.\n:::\n",
        );
        const pos = directivePos(view);

        // Act: the shared fold toggle.
        view.dispatch(
            view.state.tr
                .setMeta(foldPluginKey, { type: "toggle", pos })
                .setMeta("addToHistory", false),
        );

        // Assert: the header row is chrome and survives; the chip is beside it.
        const host = q(container, ".container-directive");
        expect(host.classList.contains("collapsed")).toBe(true);
        expect(q(container, ".directive-name").textContent).toBe("tip");
        expect(q(container, ".directive-title").textContent).toBe("Kept title");
        const chip = q(container, ".directive-header .directive-fold-ellipsis");

        // Act: clicking the chip expands, with no document edit.
        const docBefore = view.state.doc;
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(foldPluginKey.getState(view.state)!.folded.size).toBe(0);
        expect(view.state.doc).toBe(docBefore);
        await editor.destroy();
    });
});

describe("directive title editing", () => {
    it("commits on blur, sanitized, with fences and body untouched", async () => {
        const { editor, container } = await makeEditor(":::tip Old\nBody.\n:::\n");
        const title = q(container, ".directive-title");
        title.textContent = "New *bold* title";
        title.dispatchEvent(new FocusEvent("blur"));
        expect(editor.action(getMarkdown())).toBe(":::tip New bold title\nBody.\n:::\n");
        await editor.destroy();
    });

    it("the committed title still parses as a directive on reload", async () => {
        const { editor, container } = await makeEditor(":::tip New bold title\nBody.\n:::\n");
        expect(container.querySelector(".container-directive")).not.toBeNull();
        expect(q(container, ".directive-title").textContent).toBe("New bold title");
        await editor.destroy();
    });

    it("preserves a trailing {attrs} block through a title edit", async () => {
        const { editor, container } = await makeEditor(
            ':::info Old {title="x"}\nBody.\n:::\n',
        );
        const title = q(container, ".directive-title");
        title.textContent = "Renamed";
        title.dispatchEvent(new FocusEvent("blur"));
        expect(editor.action(getMarkdown())).toBe(':::info Renamed {title="x"}\nBody.\n:::\n');
        await editor.destroy();
    });

    it("an untouched blur dispatches nothing", async () => {
        const { editor, container, view } = await makeEditor(":::tip Same\nBody.\n:::\n");
        const docBefore = view.state.doc;
        q(container, ".directive-title").dispatchEvent(new FocusEvent("blur"));
        expect(view.state.doc).toBe(docBefore);
        await editor.destroy();
    });

    it("Escape reverts the typed text and dispatches nothing", async () => {
        const { editor, container, view } = await makeEditor(":::tip Keep\nBody.\n:::\n");
        const docBefore = view.state.doc;
        const title = q(container, ".directive-title");
        title.textContent = "Discarded";
        title.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        title.dispatchEvent(new FocusEvent("blur"));
        expect(q(container, ".directive-title").textContent).toBe("Keep");
        expect(view.state.doc).toBe(docBefore);
        await editor.destroy();
    });
});
