/**
 * Link popup display for Notion-export targets. Drives the REAL Milkdown
 * editor and dispatches a real `mouseover` at the rendered anchor, so what is
 * asserted is the text the popup actually paints.
 *
 * The contract: a Notion export's `Room%201%207a6f…4370.md` reads as
 * `Room 1.md` in the header, the raw target stays on the element's `title`,
 * and NOTHING else in the popup sees the cleaned form. That last half is the
 * one with teeth: the URL field is what an edit writes back, so a cleaned
 * value there would rewrite a working link into a name the vault may not have.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { setupLinkPopup } from "../components/linkPopup";

const ID = "7a6f70896bfc4e5e976d588412b74370";
const FOLDER_ID = "19b8ecd8a5b3800c8c19c98b45c56de8";

// What a Notion markdown export writes: percent-encoded, id on the file and
// on the folder above it, plus an ordinary link as the control.
const EXPORTED = `Room%201%20${ID}.md`;
const NESTED = `Private%20%26%20Shared%20${FOLDER_ID}/Room%202%20${ID}.md`;
const SAVED =
    `See [Room 1](${EXPORTED}) and [Room 2](${NESTED}).\n\n` +
    `Also [plain](my%20notes.md) and [ext](https://example.com/a).\n`;

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
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    setupLinkPopup(container, () => view);
    return { editor, container, view };
}

/** Hovers an anchor and waits out the popup's 200ms hover delay. */
async function hover(el: Element): Promise<void> {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
}

function anchorWithText(container: HTMLElement, text: string): Element {
    const el = [...container.querySelectorAll("a")].find(
        (a) => a.textContent === text,
    );
    expect(el, `no anchor labelled ${text}`).toBeTruthy();
    return el!;
}

function urlEl(): HTMLElement {
    return document.querySelector<HTMLElement>(".lp-url")!;
}

describe("link popup: Notion export targets", () => {
    let editor: Editor;
    let container: HTMLElement;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        ({ editor, container } = await makeEditor(SAVED));
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("hovering an export link should show the cleaned name in the header", async () => {
        await hover(anchorWithText(container, "Room 1"));
        expect(urlEl().textContent).toBe("Room 1.md");
    });

    it("hovering an export link should keep the raw target on hover", async () => {
        await hover(anchorWithText(container, "Room 1"));
        expect(urlEl().title).toBe(EXPORTED);
    });

    it("an export link through a folder should lose the folder's id too", async () => {
        await hover(anchorWithText(container, "Room 2"));
        expect(urlEl().textContent).toBe("Private & Shared/Room 2.md");
        expect(urlEl().title).toBe(NESTED);
    });

    it("the URL field should hold the raw target, never the cleaned name", async () => {
        await hover(anchorWithText(container, "Room 1"));
        const input = document.querySelector<HTMLInputElement>(".lp-url-input")!;
        expect(input.value).toBe(EXPORTED);
    });

    it("hovering an export link and committing untouched fields should not rewrite it", async () => {
        // The no-op guard compares the URL field against what was loaded. If
        // the cleaned name ever reached either, an idle hover plus a focus
        // trip would silently rewrite a link the user never edited.
        const before = editor.action(getMarkdown());
        await hover(anchorWithText(container, "Room 1"));
        document
            .querySelector<HTMLInputElement>(".lp-url-input")!
            .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(editor.action(getMarkdown())).toBe(before);
        expect(editor.action(getMarkdown())).toContain(EXPORTED);
    });

    it("an ordinary percent-encoded link should still show verbatim", async () => {
        // Cleaning is for Notion's shape only: decoding every `%20` link would
        // change the header for documents that have nothing to do with Notion.
        await hover(anchorWithText(container, "plain"));
        expect(urlEl().textContent).toBe("my%20notes.md");
        expect(urlEl().title).toBe("my%20notes.md");
    });

    it("an external URL should still show verbatim", async () => {
        await hover(anchorWithText(container, "ext"));
        expect(urlEl().textContent).toBe("https://example.com/a");
    });
});
