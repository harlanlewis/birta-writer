/**
 * Link popup safety around reference links. Drives the REAL Milkdown editor
 * with the production serialization config (which registers the link_ref
 * mark) — no mocks.
 *
 * Regression under test: `[text][ref]` renders as `<a data-type="link-ref">`
 * with no `link` mark and no href. The popup used to fall back to paragraph
 * bounds when it found no `link` mark, so hover + Confirm applied/removed a
 * `link` mark across the ENTIRE paragraph, destroying every other link in it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { setupLinkPopup } from "../components/linkPopup";

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
        .use(gfm)
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

function getPopup(): HTMLElement {
    const popup = document.querySelector<HTMLElement>(".lp-root");
    expect(popup).toBeTruthy();
    return popup!;
}

function clickConfirm(): void {
    const btn = document.querySelector<HTMLElement>(".lp-btn-confirm")!;
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

// A paragraph containing both a real inline link and a reference link, plus
// the reference definition — the exact shape the old fallback corrupted.
const SAVED =
    "See [inline](https://example.com/a) and [the docs][docs] here.\n\n" +
    "[docs]: https://example.com/b\n";

describe("link popup with reference links", () => {
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

    it("hovering a link_ref anchor should not open the edit popup", async () => {
        const refAnchor = container.querySelector('a[data-type="link-ref"]');
        expect(refAnchor).not.toBeNull();

        await hover(refAnchor!);

        expect(getPopup().style.display).toBe("none");
    });

    it("hover + Confirm on a link_ref must not modify the document", async () => {
        const before = editor.action(getMarkdown());
        const refAnchor = container.querySelector('a[data-type="link-ref"]')!;

        await hover(refAnchor);
        clickConfirm();

        // The old paragraph-bounds fallback stripped/replaced marks across the
        // whole paragraph here, destroying the inline link and the ref form.
        expect(editor.action(getMarkdown())).toBe(before);
        expect(editor.action(getMarkdown())).toContain("[inline](https://example.com/a)");
        expect(editor.action(getMarkdown())).toContain("[the docs][docs]");
    });

    it("hovering a real inline link should still open the popup", async () => {
        const realAnchor = container.querySelector('a[href="https://example.com/a"]');
        expect(realAnchor).not.toBeNull();

        await hover(realAnchor!);

        expect(getPopup().style.display).toBe("flex");
    });

    it("Confirm on a real link should update only that link's href", async () => {
        const realAnchor = container.querySelector('a[href="https://example.com/a"]')!;
        await hover(realAnchor);
        expect(getPopup().style.display).toBe("flex");

        const inputUrl = document.querySelector<HTMLInputElement>(".lp-url-input")!;
        inputUrl.value = "https://new.example.com";
        clickConfirm();

        const after = editor.action(getMarkdown());
        expect(after).toContain("[inline](https://new.example.com)");
        expect(after).toContain("[the docs][docs]");
        expect(after).toContain("[docs]: https://example.com/b");
    });
});
