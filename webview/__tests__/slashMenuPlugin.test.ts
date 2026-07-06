/**
 * Plugin-level tests for the slash-command menu, driving the REAL Milkdown
 * editor (linkUrlComplete.test.ts pattern): the plugin, the menu component,
 * and the registry are all production code; picks execute through the real
 * runEditorCommand registry so a picked "Heading 1" genuinely converts the
 * block. acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { setSlashMenuHost, slashMenuPlugin } from "../plugins/slashMenu";
import { runEditorCommand } from "../editorCommands";
import { SLASH_MENU_DOM_ID, slashRowDomId } from "../components/slashMenu";
import { SLASH_MENU_ITEMS } from "../components/slashMenu/registry";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .use(slashMenuPlugin)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Place the text cursor at the very end of the doc's n-th top-level block. */
function placeCursorAtEndOfBlock(v: EditorView, n: number): void {
    const { state } = v;
    let pos = 0;
    for (let i = 0; i < n; i++) pos += state.doc.child(i).nodeSize;
    const endOfText = pos + state.doc.child(n).nodeSize - 1;
    v.dispatch(state.tr.setSelection(TextSelection.create(state.doc, endOfText)));
}

/** Insert text at the caret (each dispatch re-runs the plugin's update). */
function typeText(v: EditorView, text: string): void {
    const { from, to } = v.state.selection;
    v.dispatch(v.state.tr.insertText(text, from, to));
}

function menuEl(): HTMLElement | null {
    return document.getElementById(SLASH_MENU_DOM_ID);
}

/** True while the menu exists AND is not in its hidden zero-match state. */
function menuVisible(): boolean {
    const el = menuEl();
    return el !== null && el.style.display !== "none";
}

/** Rendered row labels, in DOM order. */
function rowLabels(): string[] {
    return Array.from(
        document.querySelectorAll(".slash-menu-item .slash-menu-item-label"),
    ).map((el) => el.textContent ?? "");
}

/**
 * Dispatches a keydown on a node INSIDE the editor content (like real typing
 * does), so the plugin's capture-phase listener on the editor root runs
 * before ProseMirror's own handlers. Returns the event.
 */
function press(v: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const target = v.dom.firstElementChild ?? v.dom;
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
}

/**
 * Presses `key` and reports whether the event propagated past the plugin's
 * capture-phase listener up to the document. A claimed key is stopped at the
 * editor root; an unclaimed key bubbles on (ProseMirror's own keymaps may
 * still preventDefault it, so defaultPrevented can't distinguish the two).
 */
function pressReachesDocument(v: EditorView, key: string): boolean {
    let reached = false;
    const probe = (): void => {
        reached = true;
    };
    document.addEventListener("keydown", probe);
    press(v, key);
    document.removeEventListener("keydown", probe);
    return reached;
}

describe("slash command menu plugin", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("");
        v = view(editor);
        placeCursorAtEndOfBlock(v, 0);
        setSlashMenuHost({
            runCommand: (id, args) => runEditorCommand(id, () => editor, args),
        });
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("typing / in an empty paragraph should open the full menu", () => {
        typeText(v, "/");

        expect(menuVisible()).toBe(true);
        expect(rowLabels()).toHaveLength(SLASH_MENU_ITEMS.length);
    });

    it("typing a query after / should narrow the menu", () => {
        typeText(v, "/");
        typeText(v, "hea");

        expect(rowLabels()).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    });

    it("Enter should convert the block and remove the /query text", () => {
        typeText(v, "/he");

        const enter = press(v, "Enter");

        expect(enter.defaultPrevented).toBe(true);
        expect(menuEl()).toBeNull();
        const first = v.state.doc.child(0);
        expect(first.type.name).toBe("heading");
        expect(first.attrs["level"]).toBe(1);
        expect(first.textContent).toBe("");
    });

    it("Tab should apply the highlighted item like Enter", () => {
        typeText(v, "/bullet");

        const tab = press(v, "Tab");

        expect(tab.defaultPrevented).toBe(true);
        expect(menuEl()).toBeNull();
        expect(v.state.doc.child(0).type.name).toBe("bullet_list");
    });

    it("ArrowDown should move the highlight to the second match", () => {
        typeText(v, "/he");

        press(v, "ArrowDown");
        press(v, "Enter");

        expect(v.state.doc.child(0).attrs["level"]).toBe(2);
    });

    it("clicking a row should apply it without moving focus first", () => {
        typeText(v, "/quo");

        const row = document.getElementById(slashRowDomId("blockquote"))!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(menuEl()).toBeNull();
        expect(v.state.doc.child(0).type.name).toBe("blockquote");
    });

    it("Escape should dismiss, keep the typed text, and suppress re-opening", () => {
        typeText(v, "/he");

        const esc = press(v, "Escape");
        expect(esc.defaultPrevented).toBe(true);
        expect(menuEl()).toBeNull();
        expect(v.state.doc.textContent).toBe("/he");

        typeText(v, "a"); // still inside the same construct
        expect(menuEl()).toBeNull();
        expect(v.state.doc.textContent).toBe("/hea");
    });

    it("leaving the construct after Escape should lift the suppression", () => {
        typeText(v, "/he");
        press(v, "Escape");

        // Caret out of the construct (before the "/") lifts the dismissal…
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
        // …and moving back without a doc change must NOT re-open…
        placeCursorAtEndOfBlock(v, 0);
        expect(menuEl()).toBeNull();
        // …but typing in the construct again does.
        typeText(v, "a");
        expect(menuVisible()).toBe(true);
    });

    it("backspacing past the / should close the menu", () => {
        typeText(v, "/");
        expect(menuVisible()).toBe(true);

        const caret = v.state.selection.from;
        v.dispatch(v.state.tr.delete(caret - 1, caret));

        expect(menuEl()).toBeNull();
    });

    it("clicking the caret into pre-existing /text should not open the menu", async () => {
        await editor.destroy();
        editor = await makeEditor("/head\n");
        v = view(editor);

        placeCursorAtEndOfBlock(v, 0); // selection change, no doc change

        expect(menuEl()).toBeNull();
    });

    it("a slash glued to a word should not trigger", () => {
        typeText(v, "a/");

        expect(menuEl()).toBeNull();
    });

    it("typing / inside a code block should not trigger", async () => {
        await editor.destroy();
        editor = await makeEditor("```\ntext\n```\n");
        v = view(editor);
        placeCursorAtEndOfBlock(v, 0);

        typeText(v, " /");

        expect(menuEl()).toBeNull();
    });

    it("a zero-match query should hide the menu and release the keys", () => {
        typeText(v, "/zzzz");

        expect(menuEl()).not.toBeNull();
        expect(menuVisible()).toBe(false);

        // A hidden menu claims nothing: Enter keeps its editing meaning.
        expect(pressReachesDocument(v, "Enter")).toBe(true);
    });

    it("backspacing a zero-match query back to a match should re-show the menu", () => {
        typeText(v, "/tzz");
        expect(menuVisible()).toBe(false);

        const caret = v.state.selection.from;
        v.dispatch(v.state.tr.delete(caret - 2, caret)); // "/tzz" → "/t"

        expect(menuVisible()).toBe(true);
        expect(rowLabels().length).toBeGreaterThan(0);
    });

    it("keys should pass through untouched while the menu is closed", () => {
        typeText(v, "plain text");

        for (const key of ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"]) {
            expect(pressReachesDocument(v, key), key).toBe(true);
        }
    });

    it("claimed keys should be stopped before they reach the document", () => {
        typeText(v, "/hea");

        expect(pressReachesDocument(v, "ArrowDown")).toBe(false);
        expect(pressReachesDocument(v, "Enter")).toBe(false);
    });

    it("keydown during IME composition should not be intercepted", () => {
        typeText(v, "/he");
        expect(menuVisible()).toBe(true);

        const esc = press(v, "Escape", { isComposing: true } as KeyboardEventInit);

        expect(esc.defaultPrevented).toBe(false);
        expect(menuEl()).not.toBeNull();
    });

    it("the editor DOM should expose combobox aria state while open", () => {
        typeText(v, "/");

        expect(v.dom.getAttribute("aria-haspopup")).toBe("listbox");
        expect(v.dom.getAttribute("aria-expanded")).toBe("true");
        expect(v.dom.getAttribute("aria-controls")).toBe(SLASH_MENU_DOM_ID);
        expect(v.dom.getAttribute("aria-activedescendant")).toBe(
            slashRowDomId(SLASH_MENU_ITEMS[0].id),
        );

        press(v, "Escape");

        expect(v.dom.hasAttribute("aria-expanded")).toBe(false);
        expect(v.dom.hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("blur should close the menu", () => {
        typeText(v, "/");
        expect(menuVisible()).toBe(true);

        v.dom.dispatchEvent(new FocusEvent("blur"));

        expect(menuEl()).toBeNull();
    });

    it("an outside mousedown should close the menu", () => {
        typeText(v, "/");
        expect(menuVisible()).toBe(true);

        document.body.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );

        expect(menuEl()).toBeNull();
    });
});
