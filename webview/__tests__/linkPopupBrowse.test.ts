/**
 * The link editor's OS-file-browser button. The webview cannot open a native
 * dialog itself, so the button posts `pickLinkTarget` to the extension and
 * fills the URL field from the `linkTargetPicked` reply — WITHOUT committing:
 * apply-on-Enter/blur stays the popup's single write path, and a reply that
 * lands after the editor closed (Escape while the dialog was up) must change
 * nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { setupLinkPopup, openLinkEditor } from "../components/linkPopup";
import { dispatchLinkTargetPicked } from "../components/pathLink/linkTargetComplete";
import { mockVscodeApi } from "./setup";

let editor: Editor;

async function makeEditor(markdown: string): Promise<EditorView> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor = await Editor.make()
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
    return view;
}

/** Opens the insert-link editor at the caret (the ⌘K path). */
function openEditorAtCaret(view: EditorView): void {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    openLinkEditor({
        view,
        from: 1,
        to: 1,
        text: "",
        href: "",
        anchorRect: { left: 0, right: 0, top: 0, bottom: 0 },
    });
}

function browseBtn(): HTMLButtonElement {
    const btn = document.querySelector<HTMLButtonElement>(".lp-btn-browse");
    expect(btn, "browse button").not.toBeNull();
    return btn!;
}

function urlInput(): HTMLInputElement {
    return document.querySelector<HTMLInputElement>(".lp-url-input")!;
}

/** The ids of every pickLinkTarget message posted so far. */
function postedPickIds(): string[] {
    return mockVscodeApi.postMessage.mock.calls
        .map((c) => c[0] as { type: string; id: string })
        .filter((m) => m.type === "pickLinkTarget")
        .map((m) => m.id);
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

afterEach(async () => {
    await editor.destroy();
});

describe("link editor browse button", () => {
    it("renders beside the URL input, inside the edit body", async () => {
        const view = await makeEditor("hello\n");
        openEditorAtCaret(view);

        const btn = browseBtn();
        expect(btn.closest(".lp-url-row")).not.toBeNull();
        expect(btn.closest(".lp-url-row")?.querySelector(".lp-url-input")).not.toBeNull();
        expect(btn.querySelector("svg")).not.toBeNull();
    });

    it("click posts pickLinkTarget and the reply fills the URL field uncommitted", async () => {
        const view = await makeEditor("hello\n");
        openEditorAtCaret(view);
        const before = view.state.doc;

        browseBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const ids = postedPickIds();
        expect(ids).toHaveLength(1);

        dispatchLinkTargetPicked(ids[0]!, "docs/POSITIONING.md");

        // Field filled, document untouched (apply stays on Enter/blur).
        expect(urlInput().value).toBe("docs/POSITIONING.md");
        expect(view.state.doc.eq(before)).toBe(true);
    });

    it("a canceled dialog (null reply) leaves the field alone", async () => {
        const view = await makeEditor("hello\n");
        openEditorAtCaret(view);
        urlInput().value = "typed-by-hand.md";

        browseBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
        dispatchLinkTargetPicked(postedPickIds()[0]!, null);

        expect(urlInput().value).toBe("typed-by-hand.md");
    });

    it("a reply after the editor closed changes nothing", async () => {
        const view = await makeEditor("hello\n");
        openEditorAtCaret(view);

        browseBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const id = postedPickIds()[0]!;

        // Escape closes the editor while the (native) dialog is still up.
        urlInput().dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        const before = view.state.doc;

        dispatchLinkTargetPicked(id, "docs/POSITIONING.md");

        expect(view.state.doc.eq(before)).toBe(true);
        expect(urlInput().value).toBe("");
    });

    it("mousedown on the button is not a save point (no apply of the half-typed URL)", async () => {
        const view = await makeEditor("hello\n");
        openEditorAtCaret(view);
        const before = view.state.doc;
        urlInput().focus();
        urlInput().value = "half-typ";

        const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        browseBtn().dispatchEvent(e);

        expect(e.defaultPrevented).toBe(true);
        expect(view.state.doc.eq(before)).toBe(true);
    });
});
