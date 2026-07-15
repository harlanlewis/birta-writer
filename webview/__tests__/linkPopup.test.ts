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
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { setupLinkPopup, openLinkEditor } from "../components/linkPopup";

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

function getPopup(): HTMLElement {
    const popup = document.querySelector<HTMLElement>(".lp-root");
    expect(popup).toBeTruthy();
    return popup!;
}

/** Commits the edit fields via Enter on the URL input (no confirm button —
 * edits apply on Enter and on input blur). */
function commitEdit(): void {
    const input = document.querySelector<HTMLInputElement>(".lp-url-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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

    it("hovering a link_ref anchor should open a read-only popup (no edit button)", async () => {
        const refAnchor = container.querySelector('a[data-type="link-ref"]');
        expect(refAnchor).not.toBeNull();

        await hover(refAnchor!);

        // The popup opens (so the reference is openable) but its edit affordance
        // is hidden, and it shows the resolved definition URL.
        expect(getPopup().style.display).toBe("flex");
        const btnEdit = document.querySelector<HTMLElement>(".lp-btn-edit");
        expect(btnEdit?.style.display).toBe("none");
        const url = document.querySelector(".lp-url")?.textContent;
        expect(url).toBe("https://example.com/b");
    });

    it("hover + commit on a link_ref must not modify the document", async () => {
        const before = editor.action(getMarkdown());
        const refAnchor = container.querySelector('a[data-type="link-ref"]')!;

        await hover(refAnchor);
        commitEdit();

        // Read-only guard: a commit must never apply a `link` mark to a reference,
        // which would strip marks across the paragraph and destroy the ref form.
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
        commitEdit();

        const after = editor.action(getMarkdown());
        expect(after).toContain("[inline](https://new.example.com)");
        expect(after).toContain("[the docs][docs]");
        expect(after).toContain("[docs]: https://example.com/b");
    });
});

// ─── Fragment routing on modifier-click ─────────────────────────────────────
// Regression: the mousedown handler used to strip `#…` from the href before
// notifying the host, which killed `file.md#27` line navigation and dropped
// anchors from external URLs. Classification uses the fragment-less form;
// the message must carry the full href.
import { mockVscodeApi } from "./setup";

describe("link click fragment routing", () => {
    const DOC =
        "[notes](./notes.md#27) and [ext](https://example.com/page#frag)\n";
    let editor: Editor;
    let container: HTMLElement;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        ({ editor, container } = await makeEditor(DOC));
    });

    afterEach(async () => {
        await editor.destroy();
    });

    function metaMousedown(anchor: Element): void {
        anchor.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, metaKey: true }),
        );
    }

    it("a file link keeps its line-number fragment", () => {
        metaMousedown(container.querySelector('a[href="./notes.md#27"]')!);

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openFile",
            path: "./notes.md#27",
        });
    });

    it("an external link keeps its anchor", () => {
        metaMousedown(
            container.querySelector('a[href="https://example.com/page#frag"]')!,
        );

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openUrl",
            url: "https://example.com/page#frag",
        });
    });
});

// ─── Wikilink routing ───────────────────────────────────────────────────────

describe("wikilink popup and click routing", () => {
    const DOC = "See [[my page#head|shown]] and [[#local heading]] here.\n\n# local heading\n";
    let editor: Editor;
    let container: HTMLElement;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        ({ editor, container } = await makeEditor(DOC));
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("hovering a wikilink opens an editable popup showing target#heading, on wikilink format", async () => {
        vi.useFakeTimers();
        const anchor = container.querySelector('a[data-type="wiki-link"]')!;
        await hover(anchor);

        expect(getPopup().style.display).toBe("flex");
        expect(document.querySelector(".lp-url")?.textContent).toBe("my page#head");
        // Editable (the format switch owns conversions), resting on wikilink.
        expect(document.querySelector<HTMLElement>(".lp-btn-edit")?.style.display).toBe("");
        const select = document.querySelector<HTMLSelectElement>(".lfs-select");
        expect(select?.value).toBe("wikilink");
    });

    it("modifier-click sends openFile with the wiki flag", () => {
        const anchor = container.querySelector('a[data-type="wiki-link"]')!;
        anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, metaKey: true }));

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openFile",
            path: "my page#head",
            wiki: true,
        });
    });

    it("a same-page [[#heading]] never messages the host on modifier-click", () => {
        // The handler deliberately lets this mousedown propagate (the click
        // handler does the jump), so ProseMirror's own mousedown runs too —
        // stub the API jsdom lacks.
        (document as unknown as { elementFromPoint?: unknown }).elementFromPoint ??= () => null;
        const anchors = container.querySelectorAll('a[data-type="wiki-link"]');
        const samePage = anchors[1]!;
        samePage.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, metaKey: true }));

        expect(mockVscodeApi.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "openFile" }),
        );
    });
});

// ─── Link format switch (markdown ⇄ wikilink) ───────────────────────────────

describe("link format switch", () => {
    const DOC = "A [md](page.md) and [[target|alias]] pair, plus [ext](https://example.com/x).\n";
    let editor: Editor;
    let container: HTMLElement;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        ({ editor, container } = await makeEditor(DOC));
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    function formatSelect(): HTMLSelectElement {
        const sel = document.querySelector<HTMLSelectElement>(".lfs-select");
        expect(sel).not.toBeNull();
        return sel!;
    }

    function wikiOption(): HTMLOptionElement {
        const opt = Array.from(formatSelect().options).find(
            (o) => o.value === "wikilink",
        );
        expect(opt).toBeDefined();
        return opt!;
    }

    /** Choose a format the way a user would: set the value and fire change. */
    function chooseFormat(value: "markdown" | "wikilink"): void {
        const sel = formatSelect();
        sel.value = value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function clickEdit(): void {
        document.querySelector<HTMLElement>(".lp-btn-edit")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }

    it("converts a markdown link to a wikilink in place", async () => {
        await hover(container.querySelector('a[href="page.md"]')!);
        clickEdit();
        chooseFormat("wikilink");
        commitEdit();

        const out = editor.action(getMarkdown());
        expect(out).toContain("A [[page.md|md]] and");
        expect(out).toContain("[[target|alias]]");
    });

    it("converts a wikilink to a markdown link in place", async () => {
        await hover(container.querySelector('a[data-type="wiki-link"]')!);
        clickEdit();
        chooseFormat("markdown");
        commitEdit();

        const out = editor.action(getMarkdown());
        expect(out).toContain("[alias](target)");
        expect(out).toContain("[md](page.md)");
    });

    function formatRoot(): HTMLElement {
        const root = document.querySelector<HTMLElement>(".lfs-root");
        expect(root).not.toBeNull();
        return root!;
    }

    it("hides the whole format control for external URLs and forces markdown", async () => {
        await hover(container.querySelector('a[href="https://example.com/x"]')!);
        clickEdit();

        expect(formatRoot().style.display).toBe("none");
        expect(formatSelect().value).toBe("markdown");
    });

    it("shows the format control for a workspace-file target", async () => {
        await hover(container.querySelector('a[href="page.md"]')!);
        clickEdit();

        expect(formatRoot().style.display).toBe("");
        expect(formatSelect().value).toBe("markdown");
        expect(wikiOption()).toBeDefined();
    });
});

// ─── Save on blur + resolved-target hint ────────────────────────────────────
import { dispatchLinkTargetResolved } from "../components/pathLink/linkTargetComplete";

describe("save on blur and resolved-target hint", () => {
    const DOC = "See [inline](notes.md) here.\n";
    let editor: Editor;
    let container: HTMLElement;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        ({ editor, container } = await makeEditor(DOC));
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    function openEdit(): void {
        document.querySelector<HTMLElement>(".lp-btn-edit")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }

    it("input blur applies the edit and keeps the panel open", async () => {
        await hover(container.querySelector('a[href="notes.md"]')!);
        openEdit();

        const inputUrl = document.querySelector<HTMLInputElement>(".lp-url-input")!;
        inputUrl.value = "other.md";
        inputUrl.dispatchEvent(new Event("input", { bubbles: true }));
        inputUrl.dispatchEvent(new FocusEvent("blur"));

        expect(editor.action(getMarkdown())).toContain("[inline](other.md)");
        expect(getPopup().style.display).toBe("flex");
    });

    it("blur without changes dispatches nothing", async () => {
        const before = editor.action(getMarkdown());
        await hover(container.querySelector('a[href="notes.md"]')!);
        openEdit();

        const inputUrl = document.querySelector<HTMLInputElement>(".lp-url-input")!;
        inputUrl.dispatchEvent(new FocusEvent("blur"));

        expect(editor.action(getMarkdown())).toBe(before);
    });

    it("there is no confirm button", async () => {
        await hover(container.querySelector('a[href="notes.md"]')!);
        expect(document.querySelector(".lp-btn-confirm")).toBeNull();
        expect(document.querySelector(".lp-btn-remove")).not.toBeNull();
    });

    it("hover requests the resolved target and shows the reply as help text", async () => {
        await hover(container.querySelector('a[href="notes.md"]')!);

        const req = mockVscodeApi.postMessage.mock.calls
            .map(([m]) => m as { type: string; id?: string; path?: string })
            .find((m) => m.type === "resolveLinkTarget");
        expect(req).toBeDefined();
        expect(req!.path).toBe("notes.md");

        dispatchLinkTargetResolved(req!.id!, "content/write/notes.md");
        const hint = document.querySelector<HTMLElement>(".lp-resolved")!;
        expect(hint.textContent).toBe("→ content/write/notes.md");
        expect(hint.style.display).toBe("");
    });

    it("a smart-mode miss reads as not found", async () => {
        await hover(container.querySelector('a[href="notes.md"]')!);
        const req = mockVscodeApi.postMessage.mock.calls
            .map(([m]) => m as { type: string; id?: string })
            .find((m) => m.type === "resolveLinkTarget")!;

        dispatchLinkTargetResolved(req.id!, null);
        const hint = document.querySelector<HTMLElement>(".lp-resolved")!;
        expect(hint.textContent).toBe("not found in workspace");
    });
});

// ─── Critique regressions: phantom rewrites + mid-edit hover ────────────────

describe("popup never rewrites an untouched link", () => {
    it("hover + click-away on a colon-titled wikilink is a no-op", async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        const { editor, container } = await makeEditor("See [[note: plan]] here.\n");
        vi.useFakeTimers();
        const before = editor.action(getMarkdown());

        await hover(container.querySelector('a[data-type="wiki-link"]')!);
        // A stray click anywhere outside the popup (the save-on-close path).
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(editor.action(getMarkdown())).toBe(before);
        vi.useRealTimers();
        await editor.destroy();
    });
});

// ─── Unlink button lives in the header (text-preserving) ────────────────────

describe("unlink button in the header", () => {
    let editor: Editor;
    let container: HTMLElement;
    let view: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        ({ editor, container, view } = await makeEditor("See [inline](notes.md) here.\n"));
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    function clickRemove(): void {
        document.querySelector<HTMLElement>(".lp-btn-remove")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }

    it("hovering a link should place the unlink button in the header, not the body", async () => {
        await hover(container.querySelector('a[href="notes.md"]')!);

        const btnRemove = document.querySelector<HTMLElement>(".lp-btn-remove")!;
        expect(btnRemove.closest(".lp-header-actions")).not.toBeNull();
        expect(btnRemove.closest(".lp-body")).toBeNull();
    });

    it("the header actions should be ordered open, copy, unlink, then edit", async () => {
        await hover(container.querySelector('a[href="notes.md"]')!);

        const btns = Array.from(
            document.querySelectorAll<HTMLElement>(".lp-header-actions .lp-btn"),
        );
        expect(btns[0]?.classList.contains("lp-btn-open")).toBe(true);
        expect(btns[1]?.classList.contains("lp-btn-copy")).toBe(true);
        expect(btns[2]?.classList.contains("lp-btn-remove")).toBe(true);
        expect(btns[3]?.classList.contains("lp-btn-edit")).toBe(true);
    });

    it("the unlink button should use the link-off (slashed) icon", async () => {
        await hover(container.querySelector('a[href="notes.md"]')!);

        const btnRemove = document.querySelector<HTMLElement>(".lp-btn-remove")!;
        // IconLinkOff carries a diagonal slash line (2,2)→(22,22).
        expect(btnRemove.innerHTML).toContain('x1="2"');
        expect(btnRemove.innerHTML).toContain('y2="22"');
    });

    it("clicking unlink should strip the link mark while preserving the text", async () => {
        await hover(container.querySelector('a[href="notes.md"]')!);
        clickRemove();

        const out = editor.action(getMarkdown());
        // The link syntax is gone but the display text survives as plain prose.
        expect(out).not.toContain("](notes.md)");
        expect(out).toContain("See inline here.");
    });

    it("opening the editor for insert should hide the unlink button", async () => {
        openLinkEditor({
            view,
            anchorRect: { left: 0, right: 0, top: 0, bottom: 0 },
            from: 1,
            to: 1,
            text: "",
            href: "",
        });

        const btnRemove = document.querySelector<HTMLElement>(".lp-btn-remove")!;
        expect(btnRemove.style.display).toBe("none");
    });

    it("opening the editor for insert should hide the edit toggle", async () => {
        // A new link is already being edited, so the edit toggle is redundant.
        openLinkEditor({
            view,
            anchorRect: { left: 0, right: 0, top: 0, bottom: 0 },
            from: 1,
            to: 1,
            text: "",
            href: "",
        });

        const btnEdit = document.querySelector<HTMLElement>(".lp-btn-edit")!;
        expect(btnEdit.style.display).toBe("none");
    });
});

// ─── Copy-link button ───────────────────────────────────────────────────────

describe("copy link button", () => {
    let editor: Editor;
    let container: HTMLElement;
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
        ({ editor, container } = await makeEditor(SAVED));
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    function clickCopy(): void {
        document.querySelector<HTMLElement>(".lp-btn-copy")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }

    it("clicking copy should write the link href to the clipboard", async () => {
        await hover(container.querySelector('a[href="https://example.com/a"]')!);
        clickCopy();

        expect(writeText).toHaveBeenCalledWith("https://example.com/a");
    });

    it("the copy button should be present for a read-only reference link", async () => {
        await hover(container.querySelector('a[data-type="link-ref"]')!);

        const btnCopy = document.querySelector<HTMLElement>(".lp-btn-copy")!;
        expect(btnCopy.style.display).toBe("");
        clickCopy();
        expect(writeText).toHaveBeenCalledWith("https://example.com/b");
    });
});

describe("unlink button hidden for read-only links", () => {
    it("hovering a read-only reference link should hide the unlink button", async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        const { editor, container } = await makeEditor(SAVED);
        vi.useFakeTimers();

        await hover(container.querySelector('a[data-type="link-ref"]')!);
        const btnRemove = document.querySelector<HTMLElement>(".lp-btn-remove")!;
        expect(btnRemove.style.display).toBe("none");

        vi.useRealTimers();
        await editor.destroy();
    });

    it("hovering a same-page wikilink should hide the unlink button", async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        const { editor, container } = await makeEditor(
            "See [[#local heading]] here.\n\n# local heading\n",
        );
        vi.useFakeTimers();

        await hover(container.querySelector('a[data-type="wiki-link"]')!);
        const btnRemove = document.querySelector<HTMLElement>(".lp-btn-remove")!;
        expect(btnRemove.style.display).toBe("none");

        vi.useRealTimers();
        await editor.destroy();
    });
});

// ─── Click-to-pin (Google-Docs link-chip behavior) ─────────────────────────

describe("click to pin the link popup", () => {
    let editor: Editor;
    let container: HTMLElement;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        ({ editor, container } = await makeEditor("See [inline](notes.md) here.\n"));
    });

    afterEach(async () => {
        await editor.destroy();
    });

    function clickLink(anchor: Element): void {
        anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    it("a plain click on a link should reveal its popup", () => {
        clickLink(container.querySelector('a[href="notes.md"]')!);
        expect(getPopup().style.display).toBe("flex");
        expect(document.querySelector(".lp-url")?.textContent).toBe("notes.md");
    });

    it("a pinned popup should survive a mouseleave", () => {
        clickLink(container.querySelector('a[href="notes.md"]')!);
        const popup = getPopup();
        expect(popup.style.display).toBe("flex");

        // A hover-opened popup hides on mouseleave; a pinned one stays put.
        popup.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
        expect(popup.style.display).toBe("flex");
    });

    it("Escape should dismiss a pinned popup", () => {
        clickLink(container.querySelector('a[href="notes.md"]')!);
        expect(getPopup().style.display).toBe("flex");

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(getPopup().style.display).toBe("none");
    });

    it("a click outside both the popup and any link should dismiss a pinned popup", () => {
        clickLink(container.querySelector('a[href="notes.md"]')!);
        expect(getPopup().style.display).toBe("flex");

        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(getPopup().style.display).toBe("none");
    });

    it("a mousedown on a link anchor should not dismiss the popup before the click re-anchors", () => {
        clickLink(container.querySelector('a[href="notes.md"]')!);
        expect(getPopup().style.display).toBe("flex");

        // Re-pointing to the same (or a different) link: the mousedown must not
        // hide it — the click-show handler re-anchors instead.
        const anchor = container.querySelector('a[href="notes.md"]')!;
        anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(getPopup().style.display).toBe("flex");
    });
});

describe("mid-edit safety", () => {
    let editor: Editor;
    let container: HTMLElement;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        ({ editor, container } = await makeEditor(
            "Two links: [alpha](a.md) and [beta](b.md).\n",
        ));
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    function openEdit(): void {
        document.querySelector<HTMLElement>(".lp-btn-edit")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }

    it("hovering another link while editing never rebinds the popup", async () => {
        await hover(container.querySelector('a[href="a.md"]')!);
        openEdit();
        const inputUrl = document.querySelector<HTMLInputElement>(".lp-url-input")!;
        inputUrl.value = "EDITED.md";
        inputUrl.dispatchEvent(new Event("input", { bubbles: true }));

        await hover(container.querySelector('a[href="b.md"]')!);

        // The dirty field survives; blur still saves it to the right link.
        expect(inputUrl.value).toBe("EDITED.md");
        inputUrl.dispatchEvent(new FocusEvent("blur"));
        const out = editor.action(getMarkdown());
        expect(out).toContain("[alpha](EDITED.md)");
        expect(out).toContain("[beta](b.md)");
    });

    it("repeated blur-applies keep the bounds coherent", async () => {
        await hover(container.querySelector('a[href="a.md"]')!);
        openEdit();
        const inputText = document.querySelector<HTMLInputElement>(".lp-text-input")!;
        const inputUrl = document.querySelector<HTMLInputElement>(".lp-url-input")!;

        inputText.value = "alphabet";
        inputText.dispatchEvent(new FocusEvent("blur"));
        expect(editor.action(getMarkdown())).toContain("[alphabet](a.md)");

        inputText.value = "al";
        inputText.dispatchEvent(new FocusEvent("blur"));
        expect(editor.action(getMarkdown())).toContain("[al](a.md)");

        inputUrl.value = "c.md";
        inputUrl.dispatchEvent(new FocusEvent("blur"));
        const out = editor.action(getMarkdown());
        expect(out).toContain("[al](c.md)");
        expect(out).toContain("[beta](b.md)");
    });
});
