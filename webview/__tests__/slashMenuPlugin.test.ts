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
    visibleSlashItems,
} from "../plugins/slashMenu";
import { runEditorCommand } from "../editorCommands";
import { pendingRangePlugin } from "../plugins/pendingRange";
import { slashArgumentHintPlugin } from "../plugins/slashArgumentHint";
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
        .use(pendingRangePlugin)
        .use(slashArgumentHintPlugin)
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

/**
 * Argument mode (MAR-371): the registry's one `takesArgument` row (`/ai`).
 * Space commits it and the menu stops filtering; what follows is captured as
 * `{ prompt }` and delivered on Enter. Every other row keeps Space a filter
 * character. `runCommand` is a plain spy here: `askAgent` only posts a
 * message, so there is nothing to observe in the document.
 */
describe("the row's trailing slot", () => {
    let editor: Editor;
    let v: EditorView;

    const rowSlot = (label: string): HTMLElement | null => {
        const row = [...document.querySelectorAll(".slash-menu-item")]
            .find((r) => r.querySelector(".slash-menu-item-label")?.textContent === label);
        return row?.querySelector(".slash-menu-item-hint") ?? null;
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("");
        v = view(editor);
        placeCursorAtEndOfBlock(v, 0);
        setSlashMenuHost({ runCommand: vi.fn() });
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("a row with no syntax should show its description, marked as prose", () => {
        typeText(v, "/");

        const slot = rowSlot("Mermaid Diagram");
        expect(slot?.textContent).toBe("empty diagram");
        expect(slot?.classList.contains("slash-menu-item-hint--detail")).toBe(true);
    });

    it("a row with syntax should keep the syntax, not the description", () => {
        // Both would fit the slot; the syntax is the one worth the space,
        // and the marker class is what keeps them visually distinct.
        typeText(v, "/");

        const slot = rowSlot("Bullet List");
        expect(slot?.textContent).toBe("-");
        expect(slot?.classList.contains("slash-menu-item-hint--detail")).toBe(false);
    });

    it("no row should carry both a syntax hint and a description", () => {
        const both = SLASH_MENU_ITEMS.filter((i) => i.hint !== undefined && i.detail !== undefined);
        expect(both.map((i) => i.id)).toEqual([]);
    });

    it("a description should say something the label does not", () => {
        // The bar this field exists to hold: a note that restates the label
        // spends the attention the useful ones need.
        const described = SLASH_MENU_ITEMS.filter((i) => i.detail !== undefined);
        expect(described.length).toBeGreaterThan(0);
        for (const item of described) {
            expect(item.detail!.toLowerCase()).not.toBe(item.label.toLowerCase());
            expect(item.detail!.length).toBeLessThanOrEqual(24);
        }
    });
});

describe("the committed pill's caret hint", () => {
    let editor: Editor;
    let v: EditorView;

    /** The hint is dispatched from a microtask, the syncQueryPill deferral. */
    const settle = (): Promise<void> => Promise.resolve();
    const hintText = (): string | null =>
        document.querySelector(".md-slash-arg-hint")?.textContent ?? null;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("");
        v = view(editor);
        placeCursorAtEndOfBlock(v, 0);
        setSlashMenuHost({
            runCommand: vi.fn(),
            argumentHint: (item) => (item.commandId === "askAgent"
                ? { text: "edit with claude (Opus xHigh)", strong: "Opus xHigh", trailing: "press Enter for more options" }
                : undefined),
        });
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("committing the pill with nothing typed should show the host's hint", async () => {
        typeText(v, "/ai");
        press(v, " ");
        await settle();

        expect(hintText()).toBe("edit with claude (Opus xHigh) (press Enter for more options)");
    });

    it("the hint should never become document text", async () => {
        // A decoration that reached the document would serialize into the
        // user's file, which is the whole reason this is a widget.
        typeText(v, "/ai");
        press(v, " ");
        await settle();

        expect(v.state.doc.textContent).toBe("/ai ");
    });

    it("one character of argument should remove it, and deleting back should restore it", async () => {
        typeText(v, "/ai");
        press(v, " ");
        await settle();
        expect(hintText()).not.toBeNull();

        typeText(v, "m");
        await settle();
        expect(hintText()).toBeNull();

        // The question is unanswered again, so the prompt comes back.
        v.dispatch(v.state.tr.delete(v.state.selection.from - 1, v.state.selection.from));
        await settle();
        expect(hintText()).toBe("edit with claude (Opus xHigh) (press Enter for more options)");
    });

    it("a space typed as the argument should count as typing, not as nothing", async () => {
        typeText(v, "/ai");
        press(v, " ");
        await settle();

        typeText(v, " ");
        await settle();

        expect(hintText()).toBeNull();
    });

    it("closing the menu should take the hint with it", async () => {
        typeText(v, "/ai");
        press(v, " ");
        await settle();
        expect(hintText()).not.toBeNull();

        press(v, "Escape");
        await settle();

        expect(hintText()).toBeNull();
    });

    it("a host that offers no hint should fall back to the registry's own", async () => {
        setSlashMenuHost({ runCommand: vi.fn() });
        const ai = SLASH_MENU_ITEMS.find((i) => i.id === "ai");

        typeText(v, "/ai");
        press(v, " ");
        await settle();

        expect(ai?.argumentHint).toBeTruthy();
        expect(hintText()).toBe(ai?.argumentHint);
    });

    it("a browsing menu with no pill committed should show no hint", async () => {
        typeText(v, "/ai");
        await settle();

        expect(menuVisible()).toBe(true);
        expect(hintText()).toBeNull();
    });
});

describe("argument mode (takesArgument rows)", () => {
    let editor: Editor;
    let v: EditorView;
    let runCommand: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        editor = await makeEditor("");
        v = view(editor);
        placeCursorAtEndOfBlock(v, 0);
        runCommand = vi.fn();
        setSlashMenuHost({ runCommand });
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("the argument-taking rows should be the two Ask Agent entries", () => {
        // Both take free text after the row; they differ only in what Enter
        // does with it, which is send (`/ai`) or open the composer with it
        // already in place (`/ai-advanced`).
        const rows = SLASH_MENU_ITEMS.filter((i) => i.takesArgument);
        expect(rows.map((r) => r.id)).toEqual(["ai", "ai-advanced"]);
        expect(rows.map((r) => r.commandId)).toEqual(["askAgent", "askAgentAdvanced"]);
    });

    it("every argument-taking row should be findable by its own id", () => {
        // The filter matches labels and keywords and never ids, so a row
        // whose id is not among its keywords cannot be reached by typing its
        // own name: `/ai-advanced` matched nothing, the menu stayed hidden,
        // and Space fell through as a literal space. The commit check reads
        // the same list, so this one invariant covers both.
        for (const row of SLASH_MENU_ITEMS.filter((i) => i.takesArgument)) {
            expect(row.keywords, `${row.id} is not findable by its own id`).toContain(row.id);
        }
    });

    it("every argument-taking row should carry a placeholder for its blank", () => {
        // The invariant, rather than a list: a row that captures free text
        // and says nothing about what goes in it is the gap this feature
        // exists to close, and a new one must not reopen it.
        for (const row of SLASH_MENU_ITEMS.filter((i) => i.takesArgument)) {
            expect(row.argumentHint, `${row.id} has no argumentHint`).toBeTruthy();
        }
    });

    it("typing /ai should rank Ask Agent first", () => {
        typeText(v, "/ai");

        expect(menuVisible()).toBe(true);
        expect(rowLabels()[0]).toBe("Ask Agent");
    });

    it("Space on the highlighted Ask Agent row should commit to /ai and keep the menu open on that row alone", () => {
        typeText(v, "/agent");
        expect(rowLabels()[0]).toBe("Ask Agent");

        const space = press(v, " ");

        expect(space.defaultPrevented).toBe(true);
        expect(v.state.doc.textContent).toBe("/ai ");
        expect(menuVisible()).toBe(true);
        expect(rowLabels()).toEqual(["Ask Agent"]);
        expect(document.querySelector(".slash-menu-footer-hint")?.textContent).toMatch(/Enter to send/);
    });

    it("backspacing over the committed space should return the menu to filtering", () => {
        typeText(v, "/ai");
        press(v, " ");
        expect(document.querySelector(".slash-menu-footer-hint")?.textContent).toMatch(/Enter to send/);

        const caret = v.state.selection.from;
        v.dispatch(v.state.tr.delete(caret - 1, caret));

        expect(v.state.doc.textContent).toBe("/ai");
        expect(menuVisible()).toBe(true);
        expect(document.querySelector(".slash-menu-footer-hint")?.textContent).not.toMatch(/Enter to send/);
        // And the row is committable again.
        press(v, " ");
        expect(v.state.doc.textContent).toBe("/ai ");
    });

    it("Space on a query that merely ranks Ask Agent first should stay a filter character", () => {
        typeText(v, "/a");
        expect(rowLabels()[0]).toBe("Ask Agent");

        expect(pressReachesDocument(v, " ")).toBe(true);
        expect(v.state.doc.textContent).toBe("/a");
        expect(runCommand).not.toHaveBeenCalled();
    });

    it("Space on a row without takesArgument should stay a filter character", () => {
        typeText(v, "/he");

        expect(pressReachesDocument(v, " ")).toBe(true);
        expect(v.state.doc.textContent).toBe("/he");
        expect(runCommand).not.toHaveBeenCalled();
    });

    it("text typed after the commit, spaces included, should be delivered as the prompt on Enter and the construct removed", () => {
        typeText(v, "/ai");
        press(v, " ");
        typeText(v, "add a mermaid diagram of the flow");

        expect(menuVisible()).toBe(true);
        const enter = press(v, "Enter");

        expect(enter.defaultPrevented).toBe(true);
        expect(runCommand).toHaveBeenCalledWith("askAgent", { prompt: "add a mermaid diagram of the flow" });
        expect(v.state.doc.textContent).toBe("");
        expect(menuEl()).toBeNull();
    });

    it("the whole /ai construct should read as the query pill while the argument is typed", async () => {
        typeText(v, "/ai");
        press(v, " ");
        typeText(v, "tighten");

        // The pill decoration is applied a microtask after the update.
        await Promise.resolve();

        const pill = document.querySelector(".ProseMirror .slash-query");
        expect(pill?.textContent).toBe("/ai tighten");
    });

    it("Enter straight on the row (no Space) should run the command with no prompt", () => {
        typeText(v, "/ai");

        press(v, "Enter");

        expect(runCommand).toHaveBeenCalledWith("askAgent", undefined);
        expect(v.state.doc.textContent).toBe("");
    });

    it("Space then Enter with nothing typed should run the command with no prompt", () => {
        typeText(v, "/ai");
        press(v, " ");

        press(v, "Enter");

        expect(runCommand).toHaveBeenCalledWith("askAgent", undefined);
        expect(v.state.doc.textContent).toBe("");
    });

    it("Escape in argument mode should keep the typed text and close", () => {
        typeText(v, "/ai");
        press(v, " ");
        typeText(v, "make");

        press(v, "Escape");

        expect(menuEl()).toBeNull();
        expect(v.state.doc.textContent).toBe("/ai make");
        expect(runCommand).not.toHaveBeenCalled();
    });

    it("moving the caret out of the construct should end argument mode and keep the text", () => {
        typeText(v, "/ai");
        press(v, " ");
        typeText(v, "make");
        expect(menuVisible()).toBe(true);

        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));

        expect(menuEl()).toBeNull();
        expect(v.state.doc.textContent).toBe("/ai make");
        // Back at the end, typing continues as prose: the space after "ai"
        // means the filter regex no longer sees a construct here.
        placeCursorAtEndOfBlock(v, 0);
        typeText(v, "x");
        expect(menuEl()).toBeNull();
    });

    it("arrow keys in argument mode should keep their caret meaning", () => {
        typeText(v, "/ai");
        press(v, " ");
        typeText(v, "make");

        expect(pressReachesDocument(v, "ArrowUp")).toBe(true);
        expect(menuVisible()).toBe(true);
    });

    it("an argument pick on an empty paragraph below other content should keep that paragraph, with the caret in it", async () => {
        // The request's own line is where its marker sits while the agent
        // works, so it stays; the caret reference for an empty paragraph is
        // the blank line after the block before it (agentContext.ts).
        await editor.destroy();
        editor = await makeEditor("Some text.\n\nMore.");
        v = view(editor);
        setSlashMenuHost({ runCommand });
        placeCursorAtEndOfBlock(v, 0);
        v.dispatch(v.state.tr.split(v.state.selection.from));
        expect(v.state.doc.childCount).toBe(3);
        typeText(v, "/ai");
        press(v, " ");
        typeText(v, "add a diagram");

        press(v, "Enter");

        expect(runCommand).toHaveBeenCalledWith("askAgent", { prompt: "add a diagram" });
        expect(v.state.doc.childCount).toBe(3);
        expect(v.state.doc.child(1).textContent).toBe("");
        expect(v.state.selection.$from.index(0)).toBe(1);
    });

    it("clicking the argument row should deliver the typed prompt like Enter", () => {
        typeText(v, "/ai");
        press(v, " ");
        typeText(v, "rewrite");

        const row = document.getElementById(slashRowDomId("ai"))!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(runCommand).toHaveBeenCalledWith("askAgent", { prompt: "rewrite" });
        expect(v.state.doc.textContent).toBe("");
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

    it("inside a table cell only what a cell can hold should show", async () => {
        // A cell's content is `paragraph` and the cell is isolating, so every
        // retype would silently no-op after eating the "/query" text, and
        // table/divider would insert after the whole table — accidental from
        // inside a cell. Paragraph stands because that is what a cell holds;
        // Blockquote and Callout stand because they WRAP, and wrapping from
        // inside a cell quotes the whole table (quoteAnyBlock.test.ts).
        const labels = await openIn("| a | b |\n| - | - |\n| c | d |\n");
        expect(labels).toEqual([
            "Paragraph", "Image", "Blockquote", "Callout",
            "Inline Math", "Link", "Footnote",
        ]);
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

    it("only the INNERMOST list ancestor should hide a row", async () => {
        // The rows act on the caret's own list, so the ordered list above is
        // not evidence about them — Numbered List converts this sublist.
        const $from = await fromInside("1. step\n   - note text\n", "note text");
        const hidden = contextHiddenItemIds($from);
        expect(hidden.has("bulletList")).toBe(true);
        expect(hidden.has("orderedList")).toBe(false);
        expect(hidden.has("taskList")).toBe(false);
    });

    it("a table cell should hide every row that retypes or inserts a block", async () => {
        // contextHiddenItemIds owns the toggle rule alone; structural
        // legality is the placement probe's, so the cell rule is visible on
        // visibleSlashItems rather than here.
        const $from = await fromInside("| a |\n| --- |\n| cell text |", "cell text");
        expect(contextHiddenItemIds($from).size).toBe(0);
        const shown = new Set(visibleSlashItems($from).map((item) => item.id));
        for (const id of ["table", "codeBlock", "heading1", "divider", "bulletList"]) {
            expect(shown.has(id), `${id} should be hidden in a table cell`).toBe(false);
        }
        // The wrap rows reach past the cell and act on the whole table.
        for (const id of ["callout", "blockquote"]) {
            expect(shown.has(id), `${id} should stay offered in a table cell`).toBe(true);
        }
    });
});
