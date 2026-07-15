/**
 * Toolbar Insert/Edit Link tests: the openLinkPrompt controller method
 * (behind the toolbar link button and the routed insertLink editor command,
 * whose contributed Cmd/Ctrl+K keybinding is user-rebindable) opens the
 * single link editor (the hover popup) against the REAL Milkdown editor —
 * with a selection it pre-fills the link text and links the selected range,
 * without one it inserts new linked text at the caret.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { Mark } from "@milkdown/prose/model";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { initToolbar } from "../components/toolbar";
import { setupLinkPopup } from "../components/linkPopup";
import { runEditorCommand } from "../editorCommands";

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
        .create();
    // The toolbar's openLinkPrompt routes through the shared link editor (the
    // hover popup singleton); wire it to this editor's view.
    const v = editor.action((ctx) => ctx.get(editorViewCtx));
    setupLinkPopup(root, () => v);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** The currently-shown link editor popup (the latest open one). */
function linkPopup(): HTMLElement {
    const shown = Array.from(
        document.querySelectorAll<HTMLElement>(".lp-root"),
    ).find((p) => p.style.display !== "none");
    expect(shown).toBeTruthy();
    return shown!;
}

/** True when no link editor popup is visible. */
function popupClosed(): boolean {
    return !Array.from(
        document.querySelectorAll<HTMLElement>(".lp-root"),
    ).some((p) => p.style.display !== "none");
}

function promptInputs(): { text: HTMLInputElement; url: HTMLInputElement } {
    const popup = linkPopup();
    const text = popup.querySelector<HTMLInputElement>(".lp-text-input");
    const url = popup.querySelector<HTMLInputElement>(".lp-url-input");
    expect(text).not.toBeNull();
    expect(url).not.toBeNull();
    return { text: text!, url: url! };
}

function pressEnter(input: HTMLInputElement): void {
    input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
}

/** All [text, href] pairs of link-marked text nodes in the document. */
function linkedTexts(v: EditorView): Array<{ text: string; href: string }> {
    const found: Array<{ text: string; href: string }> = [];
    v.state.doc.descendants((node) => {
        if (!node.isText) return;
        const link = node.marks.find((m: Mark) => m.type.name === "link");
        if (link) {
            found.push({ text: node.text ?? "", href: link.attrs["href"] as string });
        }
    });
    return found;
}

describe("toolbar openLinkPrompt", () => {
    let editor: Editor;
    let v: EditorView;
    let tb: ReturnType<typeof initToolbar>;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("hello world\n");
        v = view(editor);
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        document.body.appendChild(topbar);
        tb = initToolbar(topbar, () => editor);
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("with a selection it should pre-fill the link text and link the selected range", () => {
        // Arrange — select "hello" (paragraph content starts at pos 1)
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));

        // Act
        tb.openLinkPrompt();
        const { text, url } = promptInputs();
        expect(text.value).toBe("hello");
        url.value = "https://example.com";
        pressEnter(url);

        // Assert — the selected text now carries the link
        expect(popupClosed()).toBe(true);
        expect(v.state.doc.textContent).toBe("hello world");
        expect(linkedTexts(v)).toEqual([
            { text: "hello", href: "https://example.com" },
        ]);
    });

    it("without a selection it should open with an empty text field and insert new linked text", () => {
        // Arrange — collapsed cursor at the end of the paragraph
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 12)));

        // Act
        tb.openLinkPrompt();
        const { text, url } = promptInputs();
        expect(text.value).toBe("");
        text.value = "docs";
        url.value = "./docs/index.md";
        pressEnter(url);

        // Assert — new linked text was inserted at the caret
        expect(v.state.doc.textContent).toBe("hello worlddocs");
        expect(linkedTexts(v)).toEqual([
            { text: "docs", href: "./docs/index.md" },
        ]);
    });

    it("editing an existing link should pre-fill its href", () => {
        // Arrange — link "world" first
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7, 12)));
        tb.openLinkPrompt();
        {
            const { url } = promptInputs();
            url.value = "https://old.example";
            pressEnter(url);
        }
        expect(linkedTexts(v)).toEqual([
            { text: "world", href: "https://old.example" },
        ]);

        // Act — re-open the prompt on the same selection
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 7, 12)));
        tb.openLinkPrompt();
        const { text, url } = promptInputs();

        // Assert — both fields reflect the existing link
        expect(text.value).toBe("world");
        expect(url.value).toBe("https://old.example");
        url.value = "https://new.example";
        pressEnter(url);
        expect(linkedTexts(v)).toEqual([
            { text: "world", href: "https://new.example" },
        ]);
    });

    it("a cross-paragraph selection should clamp to the first paragraph and not fuse blocks", async () => {
        // Arrange — two paragraphs; select from "two" across the paragraph
        // boundary into "three" (doc: p1 "one two" content 1..8, p2 "three
        // four" content 10..20 → selection 5..15 covers "two" + "three")
        await editor.destroy();
        editor = await makeEditor("one two\n\nthree four\n");
        v = view(editor);
        expect(v.state.doc.childCount).toBe(2);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 5, 15)));

        // Act — the prompt pre-fills only the first paragraph's portion
        tb.openLinkPrompt();
        const { text, url } = promptInputs();
        expect(text.value).toBe("two");
        url.value = "x";
        pressEnter(url);

        // Assert — both paragraphs survive, no "twothree" fusion, and the
        // link applies only within the first paragraph
        expect(v.state.doc.childCount).toBe(2);
        expect(v.state.doc.child(0).textContent).toBe("one two");
        expect(v.state.doc.child(1).textContent).toBe("three four");
        expect(linkedTexts(v)).toEqual([{ text: "two", href: "x" }]);
    });

    it("a selection starting at a paragraph end should behave like a caret insert", async () => {
        // Arrange — selection begins exactly at the end of p1 (pos 8) and
        // spans into p2: the clamped first-block portion is empty
        await editor.destroy();
        editor = await makeEditor("one two\n\nthree four\n");
        v = view(editor);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 8, 15)));

        // Act
        tb.openLinkPrompt();
        const { text, url } = promptInputs();
        expect(text.value).toBe("");
        text.value = "new";
        url.value = "y";
        pressEnter(url);

        // Assert — linked text inserted at the clamp point, blocks intact
        expect(v.state.doc.childCount).toBe(2);
        expect(v.state.doc.child(0).textContent).toBe("one twonew");
        expect(v.state.doc.child(1).textContent).toBe("three four");
        expect(linkedTexts(v)).toEqual([{ text: "new", href: "y" }]);
    });

    it("the routed insertLink editor command should open the same prompt and apply the link end to end", () => {
        // Arrange — Cmd/Ctrl+K is a contributed (user-rebindable) keybinding
        // now: the workbench resolves it to birta.editor.insertLink,
        // which reaches the webview as an editorCommand message dispatched
        // through runEditorCommand. initToolbar already registered the
        // toolbar's openLinkPrompt as the host hook, so this drives the full
        // production route. Select "hello" first.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));

        // Act — the exact call messageHandlers makes for the routed command
        runEditorCommand("insertLink", () => editor);
        const { text, url } = promptInputs();
        expect(text.value).toBe("hello");
        url.value = "https://kbd.example";
        pressEnter(url);

        // Assert — the command path produced the same doc change as the button
        expect(linkedTexts(v)).toEqual([
            { text: "hello", href: "https://kbd.example" },
        ]);
    });

    it("Escape should close the prompt without touching the document", () => {
        // Arrange
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
        tb.openLinkPrompt();
        const { text } = promptInputs();

        // Act
        text.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );

        // Assert
        expect(popupClosed()).toBe(true);
        expect(linkedTexts(v)).toEqual([]);
        expect(v.state.doc.textContent).toBe("hello world");
    });

    it("an outside-click landing on a link should still close the open editor (MAR-71)", () => {
        // Arrange — open the insert editor on "hello".
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)));
        tb.openLinkPrompt();
        expect(popupClosed()).toBe(false);

        // Act — click a link anchor OUTSIDE the popup. This is exactly the case
        // the e2e "blur-out" click hits once a line has been linked: the click
        // target is an <a>. The anchor is placed in the editor container (so the
        // popup's capture-phase click handler fires) but outside .ProseMirror,
        // so ProseMirror's own view handler — which needs layout jsdom lacks —
        // isn't invoked. The gesture is mousedown → click, as a real click fires.
        const container = document.querySelector(".milkdown")!.parentElement!;
        const link = document.createElement("a");
        link.setAttribute("href", "https://example.com"); // non-anchor: reaches the isEditMode branch
        link.textContent = "x";
        container.appendChild(link);
        link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        link.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        // Assert — while an editor is open, a click on a link applies-and-closes
        // instead of re-pointing. Before the fix mousedown skipped the dismiss
        // (link target) and the click re-pinned, leaving the editor stuck open.
        expect(popupClosed()).toBe(true);
    });
});
