/**
 * Plugin-level tests for the slash-command menu, driving the REAL Milkdown
 * editor (linkUrlComplete.test.ts pattern): the plugin, the menu component,
 * and the registry are all production code; picks execute through the real
 * runEditorCommand registry so a picked "Heading 1" genuinely converts the
 * block. acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { Selection, TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    contextHiddenItemIds,
    opensSlashMenu,
    setSlashMenuHost,
    slashMenuPlugin,
} from "../plugins/slashMenu";
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
        .use(gfmFidelity)
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
    let runCommand: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("");
        v = view(editor);
        placeCursorAtEndOfBlock(v, 0);
        // Spy that still delegates to the real registry, so block-converting
        // picks mutate the doc while non-content picks (font/TOC) are asserted
        // by the id they dispatch.
        runCommand = vi.fn((id: string, args?: unknown) =>
            runEditorCommand(id, () => editor, args),
        );
        setSlashMenuHost({ runCommand });
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("typing / in an empty paragraph should open the browsable menu", () => {
        typeText(v, "/");

        expect(menuVisible()).toBe(true);
        expect(rowLabels()).toHaveLength(
            SLASH_MENU_ITEMS.filter((i) => !i.searchOnly).length,
        );
    });

    it("typing / in a heading should open the menu", async () => {
        // Regression (MAR-94): typing into a heading re-dispatches a synthetic
        // normalization transaction (addToHistory: false) right after the
        // keystroke; that follow-up used to clobber the open-eligible verdict
        // set by the real typing, so the menu silently never opened in
        // headings even though the slash context matched.
        await editor.destroy();
        editor = await makeEditor("# Title\n");
        v = view(editor);
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));

        typeText(v, " /");

        expect(menuVisible()).toBe(true);
    });

    it("typing a query after / should narrow the menu", () => {
        typeText(v, "/");
        typeText(v, "hea");

        expect(rowLabels()).toEqual([
            "Heading 1", "Heading 2", "Heading 3",
            "Heading 4", "Heading 5", "Heading 6",
            // Tier-2 keyword-prefix match ("hea" starts "header"/"heading").
            "Section Link",
            // Tier-3 substring match ("hea" inside the "cheatsheet" keyword)
            // — ranked after every prefix match.
            "Show Keyboard Shortcuts",
        ]);
    });

    it("picking a view-control item should dispatch its command and eat the /query", () => {
        typeText(v, "/serif");

        press(v, "Enter");

        expect(runCommand).toHaveBeenCalledWith("fontSerif", undefined);
        expect(v.state.doc.textContent).toBe("");
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

    it("picking Mermaid Diagram should create a mermaid-language code block", () => {
        typeText(v, "/mer");

        press(v, "Enter");

        const first = v.state.doc.child(0);
        expect(first.type.name).toBe("code_block");
        expect(first.attrs["language"]).toBe("mermaid");
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

    it("aria-expanded should track visibility through the zero-match state", () => {
        typeText(v, "/zz");
        expect(menuVisible()).toBe(false);
        expect(v.dom.getAttribute("aria-expanded")).toBe("false");

        const caret = v.state.selection.from;
        v.dispatch(v.state.tr.delete(caret - 1, caret)); // "/zz" → "/z"… still none
        v.dispatch(v.state.tr.delete(caret - 2, caret - 1)); // → "/"

        expect(menuVisible()).toBe(true);
        expect(v.dom.getAttribute("aria-expanded")).toBe("true");
    });

    it("picking should never steal focus (host panels focus their own inputs)", () => {
        // The /link and /image items open host panels that focus a text
        // input; a view.focus() after the pick would yank it back.
        const focusSpy = vi.spyOn(v, "focus");
        typeText(v, "/quo");

        press(v, "Enter");

        expect(v.state.doc.child(0).type.name).toBe("blockquote");
        expect(focusSpy).not.toHaveBeenCalled();
    });

    it("an undo/redo transaction restoring /query should not re-open the menu", () => {
        // Simulate what prosemirror-history dispatches: a doc change
        // carrying its history meta.
        const tr = v.state.tr.insertText("/he", v.state.selection.from);
        tr.setMeta("history$", { redo: false });
        v.dispatch(tr);

        expect(v.state.doc.textContent).toBe("/he");
        expect(menuEl()).toBeNull();
    });

    it("an external rewrite (addToHistory: false) should not open the menu", () => {
        const tr = v.state.tr.insertText("/he", v.state.selection.from);
        tr.setMeta("addToHistory", false);
        v.dispatch(tr);

        expect(menuEl()).toBeNull();
    });

    it("a stale open-eligible verdict should not survive an external-sync rewrite (MAR-94 regression)", () => {
        // Type a slash construct so the menu opens (openEligible = true).
        typeText(v, "/foo");
        expect(menuVisible()).toBe(true);
        // Close it the way a blur does, WITHOUT moving the caret off the
        // construct — openEligible stays sticky-true across the close.
        v.dom.dispatchEvent(new FocusEvent("blur"));
        expect(menuEl()).toBeNull();

        // An inbound external file edit (git checkout / a side-by-side text
        // edit): addToHistory:false AND external-sync, changing the doc but
        // leaving the /foo construct intact and still caret-matchable (a
        // leading space keeps the `/` preceded by whitespace). The verdict must
        // NOT be preserved here (only the heading-normalization fix-up, which
        // carries no external-sync meta, is transparent) — otherwise the menu
        // pops open on pre-existing text the user never just typed.
        const external = v.state.tr.insertText(" ", 1);
        external.setMeta("addToHistory", false);
        external.setMeta("external-sync", true);
        v.dispatch(external);

        expect(menuEl()).toBeNull();
    });

    it("pasted text ending in /word should not open the menu", () => {
        const tr = v.state.tr.insertText("pasted /tab", v.state.selection.from);
        tr.setMeta("uiEvent", "paste");
        v.dispatch(tr);

        expect(v.state.doc.textContent).toBe("pasted /tab");
        expect(menuEl()).toBeNull();
        // …but typing right after (inside the construct) does open it.
        typeText(v, "l");
        expect(menuVisible()).toBe(true);
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

describe("context-aware item filtering (toggles hidden where they would remove)", () => {
    let editor: Editor;
    let v: EditorView;

    async function openIn(markdown: string): Promise<string[]> {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor(markdown);
        v = view(editor);
        // Last valid cursor position — inside the deepest trailing textblock
        // (placeCursorAtEndOfBlock lands on node boundaries in nested lists).
        v.dispatch(v.state.tr.setSelection(Selection.atEnd(v.state.doc)));
        typeText(v, " /");
        return rowLabels();
    }

    afterEach(async () => {
        await editor.destroy();
    });

    it("inside a bullet list the Bullet List item should be hidden", async () => {
        const labels = await openIn("- item one\n");
        expect(labels).not.toContain("Bullet List");
        expect(labels).toContain("Ordered List"); // cross-type stays: converts
        expect(labels).toContain("Task List");
    });

    it("inside an ordered list the Ordered List item should be hidden", async () => {
        const labels = await openIn("1. item one\n");
        expect(labels).not.toContain("Ordered List");
        expect(labels).toContain("Bullet List");
    });

    it("inside a task list only Task List is hidden — Bullet List converts", async () => {
        const labels = await openIn("- [ ] todo\n");
        expect(labels).not.toContain("Task List");
        // Only the list's CURRENT flavor hides (that row would lift); the
        // other flavors convert the whole tree in place, so "Bullet List"
        // is the make-these-plain-bullets conversion here.
        expect(labels).toContain("Bullet List");
        expect(labels).toContain("Ordered List");
    });

    it("inside a blockquote the Blockquote item should be hidden", async () => {
        const labels = await openIn("> quoted\n");
        expect(labels).not.toContain("Blockquote");
        expect(labels).toContain("Heading 1");
    });

    it("in a plain paragraph every item should show", async () => {
        const labels = await openIn("plain\n");
        expect(labels).toContain("Bullet List");
        expect(labels).toContain("Ordered List");
        expect(labels).toContain("Task List");
        expect(labels).toContain("Blockquote");
    });

    it("inside a table cell only the inline insertions should show", async () => {
        // Cells only allow paragraph content: block conversions would
        // silently no-op after eating the "/query" text, and table/divider
        // insert after the whole table — accidental from inside a cell.
        const labels = await openIn("| a | b |\n| - | - |\n| c | d |\n");
        expect(labels).toEqual(["Image", "Inline Math", "Link", "Footnote"]);
    });
});

describe("pure gates", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("x\n");
        v = view(editor);
        placeCursorAtEndOfBlock(v, 0);
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("opensSlashMenu should accept plain typing and reject everything else", () => {
        const typing = v.state.tr.insertText("/");
        expect(opensSlashMenu(typing)).toBe(true);

        const noDocChange = v.state.tr.setMeta("x", 1);
        expect(opensSlashMenu(noDocChange)).toBe(false);

        const undo = v.state.tr.insertText("/").setMeta("history$", {});
        expect(opensSlashMenu(undo)).toBe(false);

        const external = v.state.tr.insertText("/").setMeta("addToHistory", false);
        expect(opensSlashMenu(external)).toBe(false);

        const paste = v.state.tr.insertText("/").setMeta("uiEvent", "paste");
        expect(opensSlashMenu(paste)).toBe(false);

        const drop = v.state.tr.insertText("/").setMeta("uiEvent", "drop");
        expect(opensSlashMenu(drop)).toBe(false);

        const cut = v.state.tr.insertText("/").setMeta("uiEvent", "cut");
        expect(opensSlashMenu(cut)).toBe(true); // cut changes the doc by typing intent
    });

    it("contextHiddenItemIds should be empty at the top level", () => {
        expect(contextHiddenItemIds(v.state.selection.$from)).toEqual(new Set());
    });
});

describe("contextHiddenItemIds — nesting policy", () => {
    /** $from resolved inside the block containing `text`. */
    async function fromInside(markdown: string, text: string) {
        const editor = await makeEditor(markdown);
        const v = view(editor);
        let inside = -1;
        v.state.doc.descendants((node, pos) => {
            if (node.isTextblock && node.textContent === text) inside = pos + 1;
            return inside === -1;
        });
        expect(inside, `textblock "${text}" not found`).toBeGreaterThan(-1);
        return v.state.doc.resolve(inside);
    }

    it("a callout ancestor should hide NO callout rows (insertCallout nests, not toggles)", async () => {
        const $from = await fromInside("> [!note] Title\n> body text", "body text");
        const hidden = contextHiddenItemIds($from);
        for (const id of ["callout", "callout-tip", "callout-note", "callout-warning"]) {
            expect(hidden.has(id), `${id} should stay available inside a callout`).toBe(false);
        }
    });

    it("a bullet-list ancestor should still hide the bulletList toggle row", async () => {
        const $from = await fromInside("- item text", "item text");
        const hidden = contextHiddenItemIds($from);
        expect(hidden.has("bulletList")).toBe(true);
        // The other flavors stay: they convert the whole tree in place.
        expect(hidden.has("orderedList")).toBe(false);
        expect(hidden.has("taskList")).toBe(false);
    });

    it("a TASK-list ancestor should hide taskList but keep Bullet List (a conversion)", async () => {
        const $from = await fromInside("- [ ] task text", "task text");
        const hidden = contextHiddenItemIds($from);
        expect(hidden.has("taskList")).toBe(true);
        // "Bullet List" is the make-these-plain conversion, no longer a lift.
        expect(hidden.has("bulletList")).toBe(false);
        expect(hidden.has("orderedList")).toBe(false);
    });

    it("a table cell should still hide every block-level row (no table in table)", async () => {
        const $from = await fromInside("| a |\n| --- |\n| cell text |", "cell text");
        const hidden = contextHiddenItemIds($from);
        for (const id of ["table", "codeBlock", "callout", "heading1", "divider"]) {
            expect(hidden.has(id), `${id} should be hidden in a table cell`).toBe(true);
        }
    });
});
