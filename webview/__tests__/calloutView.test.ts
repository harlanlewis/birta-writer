/**
 * Callout NodeView behavior, driven through the REAL editor with the
 * production NodeView registered (nodeViewCtx) — not a mocked DOM. Every
 * mutation is asserted through getMarkdown() (the production serializer), and
 * every non-mutation through document REFERENCE equality, so a test can only
 * pass if the actual contract holds:
 *   - folding never touches the document;
 *   - kind switches rewrite ONLY the marker (case/fold/title preserved);
 *   - title edits commit escaped (so they survive reparse as callouts) and
 *     revert/no-op paths dispatch nothing.
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
import { createCalloutView, calloutLabel } from "../components/callout";
import { escapeCalloutTitle, markerWithFold, markerWithTitle, parseCalloutMarker } from "../plugins/callouts";
import { headingFoldPlugin } from "../plugins/headingFold";

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
            ctx.set(nodeViewCtx, [["callout", createCalloutView]]);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        // Fold state is owned by the fold plugin (MAR-110): it seeds the
        // `[!kind]-` default, renders the gutter chevron, and stamps the
        // `collapsed` class onto the NodeView as a decoration.
        .use(headingFoldPlugin)
        .create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    return { editor, container, view };
}

const q = (root: HTMLElement, sel: string): HTMLElement => {
    const el = root.querySelector(sel);
    expect(el, `expected element ${sel}`).not.toBeNull();
    return el as HTMLElement;
};

describe("escapeCalloutTitle / markerWithTitle", () => {
    it("escape and display-unescape are inverses for adversarial titles", () => {
        const titles = ["a *b*", "[x] and [[y]]", "==z==", "back\\slash", "<tag> & $x$"];
        for (const title of titles) {
            const marker = markerWithTitle("[!TIP]-", title);
            // The synthesized marker must still parse as a callout marker...
            const parts = parseCalloutMarker(marker);
            expect(parts, marker).not.toBeNull();
            // ...with kind/fold intact and the display title byte-equal to
            // what was typed (escape → unescape round trip).
            expect(parts!.rawType).toBe("TIP");
            expect(parts!.fold).toBe("-");
            expect(parts!.title).toBe(title);
        }
    });

    it("an empty title drops the title segment", () => {
        expect(markerWithTitle("[!note]+ Old title", "")).toBe("[!note]+");
        expect(markerWithTitle("[!note]+ Old title", "   ")).toBe("[!note]+");
    });

    it("escaped characters cover every inline trigger the parser bails on", () => {
        expect(escapeCalloutTitle("*_[]<>`~$=&\\")).toBe(
            "\\*\\_\\[\\]\\<\\>\\`\\~\\$\\=\\&\\\\",
        );
    });
});

describe("callout NodeView chrome", () => {
    it("renders the icon button (aria menu semantics) and the editable title", async () => {
        const { editor, container } = await makeEditor("> [!note] My title\n> Body.\n");
        const kindBtn = q(container, ".callout-kind");
        expect(kindBtn.getAttribute("aria-haspopup")).toBe("menu");
        expect(kindBtn.getAttribute("aria-expanded")).toBe("false");
        expect(kindBtn.querySelector("svg")).not.toBeNull();
        const title = q(container, ".callout-title-text");
        expect(title.textContent).toBe("My title");
        expect(title.getAttribute("role")).toBe("textbox");
        expect(title.isContentEditable || title.contentEditable !== "false").toBe(true);
        await editor.destroy();
    });

    it("the title falls back to the kind label and marks itself placeholder", async () => {
        const { editor, container } = await makeEditor("> [!FAQ]\n> Body.\n");
        const title = q(container, ".callout-title-text");
        expect(title.textContent).toBe("Faq");
        expect(title.classList.contains("placeholder")).toBe(true);
        await editor.destroy();
    });
});

describe("folding is visual only", () => {
    it("a [!kind]- marker should start collapsed, and gutter chevron clicks toggle without touching the document", async () => {
        // Arrange: the T1 default (syntax `-` marker) seeds the fold plugin.
        const { editor, container, view } = await makeEditor(
            "> [!tip]- Folded\n> Hidden.\n",
        );
        const callout = q(container, ".callout");
        const docBefore = view.state.doc;
        expect(callout.classList.contains("collapsed")).toBe(true);

        // Act + Assert: the chevron lives in the callout's GUTTER now
        // (MAR-110), not the title bar; each click flips only view state.
        const chevron = () => q(container, ".callout .heading-fold-toggle");
        chevron().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(q(container, ".callout").classList.contains("collapsed")).toBe(false);

        chevron().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(q(container, ".callout").classList.contains("collapsed")).toBe(true);

        // Reference equality: the doc was never touched (zero-step toggles).
        expect(view.state.doc).toBe(docBefore);
        expect(editor.action(getMarkdown())).toBe("> [!tip]- Folded\n> Hidden.\n");
        await editor.destroy();
    });

    it("the collapsed ellipsis should expand on click without touching the document", async () => {
        const { editor, container, view } = await makeEditor(
            "> [!tip]- Folded\n> Hidden.\n",
        );
        const docBefore = view.state.doc;
        expect(q(container, ".callout").classList.contains("collapsed")).toBe(true);

        q(container, ".callout-fold-ellipsis").dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        expect(q(container, ".callout").classList.contains("collapsed")).toBe(false);
        expect(view.state.doc).toBe(docBefore);
        await editor.destroy();
    });

    it("a marker-less callout with a body should still get a gutter chevron (expanded)", async () => {
        const { editor, container } = await makeEditor("> [!note] Title\n> Body.\n");
        expect(q(container, ".callout").classList.contains("collapsed")).toBe(false);
        expect(container.querySelector(".callout .heading-fold-toggle")).not.toBeNull();
        await editor.destroy();
    });

    it("an empty callout should not be foldable", async () => {
        const { editor, container } = await makeEditor("> [!note]\n");
        expect(container.querySelector(".callout .heading-fold-toggle")).toBeNull();
        await editor.destroy();
    });
});

describe("markerWithFold", () => {
    it("adds and removes the fold marker while preserving type case and title bytes", () => {
        expect(markerWithFold("[!TIP] My title", "-")).toBe("[!TIP]- My title");
        expect(markerWithFold("[!tip]- My title", "")).toBe("[!tip] My title");
        expect(markerWithFold("[!note]+", "-")).toBe("[!note]-");
    });
});

describe("kind picker", () => {
    it("opens on click, switches the kind, and rewrites ONLY the marker", async () => {
        const { editor, container } = await makeEditor(
            "> [!note]- Keep this title\n> And this body.\n",
        );
        q(container, ".callout-kind").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const menu = q(container, ".callout-menu");
        expect(q(container, ".callout-kind").getAttribute("aria-expanded")).toBe("true");
        expect(menu.getAttribute("role")).toBe("menu");

        q(menu, '[data-kind="danger"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // Lowercase original stays lowercase; fold and title bytes survive.
        expect(editor.action(getMarkdown())).toBe(
            "> [!danger]- Keep this title\n> And this body.\n",
        );
        expect(container.querySelector(".callout-menu")).toBeNull();
        expect(q(container, ".callout").dataset["kind"]).toBe("danger");
        await editor.destroy();
    });

    it("opens from the keyboard (ArrowDown) and closes on Escape without edits", async () => {
        const { editor, container, view } = await makeEditor("> [!NOTE]\n> Body.\n");
        const docBefore = view.state.doc;
        const kindBtn = q(container, ".callout-kind");

        kindBtn.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
        const menu = q(container, ".callout-menu");
        menu.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        expect(container.querySelector(".callout-menu")).toBeNull();
        expect(kindBtn.getAttribute("aria-expanded")).toBe("false");
        expect(view.state.doc).toBe(docBefore);
        await editor.destroy();
    });
});

describe("title editing", () => {
    it("commits on blur with markdown-trigger characters escaped", async () => {
        const { editor, container } = await makeEditor("> [!TIP] Old\n> Body.\n");
        const title = q(container, ".callout-title-text");
        title.textContent = "New *fancy* [title]";
        title.dispatchEvent(new FocusEvent("blur"));

        expect(editor.action(getMarkdown())).toBe(
            "> [!TIP] New \\*fancy\\* \\[title\\]\n> Body.\n",
        );
        // The display shows what was typed (unescaped), not the raw bytes.
        expect(q(container, ".callout-title-text").textContent).toBe("New *fancy* [title]");
        await editor.destroy();
    });

    it("the committed escaped title still parses as a callout on reload", async () => {
        // The reason escaping exists: unescaped `*x*` would downgrade the
        // callout to a plain blockquote on the next open.
        const { editor, container } = await makeEditor(
            "> [!TIP] New \\*fancy\\* \\[title\\]\n> Body.\n",
        );
        expect(container.querySelector(".callout")).not.toBeNull();
        expect(q(container, ".callout-title-text").textContent).toBe("New *fancy* [title]");
        await editor.destroy();
    });

    it("clearing the title drops the segment and restores the placeholder", async () => {
        const { editor, container } = await makeEditor("> [!TIP] Old\n> Body.\n");
        const title = q(container, ".callout-title-text");
        title.textContent = "";
        title.dispatchEvent(new FocusEvent("blur"));

        expect(editor.action(getMarkdown())).toBe("> [!TIP]\n> Body.\n");
        expect(q(container, ".callout-title-text").textContent).toBe("Tip");
        expect(q(container, ".callout-title-text").classList.contains("placeholder")).toBe(true);
        await editor.destroy();
    });

    it("an untouched blur dispatches nothing (zero churn)", async () => {
        const { editor, container, view } = await makeEditor("> [!TIP] Same\n> Body.\n");
        const docBefore = view.state.doc;
        const title = q(container, ".callout-title-text");
        title.dispatchEvent(new FocusEvent("blur"));
        expect(view.state.doc).toBe(docBefore);
        await editor.destroy();
    });

    it("Escape reverts the typed text and dispatches nothing", async () => {
        const { editor, container, view } = await makeEditor("> [!TIP] Keep\n> Body.\n");
        const docBefore = view.state.doc;
        const title = q(container, ".callout-title-text");
        title.textContent = "Discarded";
        title.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        title.dispatchEvent(new FocusEvent("blur"));
        expect(q(container, ".callout-title-text").textContent).toBe("Keep");
        expect(view.state.doc).toBe(docBefore);
        await editor.destroy();
    });
});

describe("calloutLabel", () => {
    it("prefers the title, else the capitalized raw type", () => {
        const fake = (attrs: Record<string, unknown>) => ({ attrs }) as never;
        expect(calloutLabel(fake({ title: "Custom", rawType: "NOTE" }))).toBe("Custom");
        expect(calloutLabel(fake({ title: "", rawType: "NOTE" }))).toBe("Note");
        expect(calloutLabel(fake({ title: "", rawType: "faq" }))).toBe("Faq");
    });
});
