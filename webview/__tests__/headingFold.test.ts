/**
 * Tests for the heading gutter's level control: `setHeadingLevelAt` (retype a
 * heading by position — the pure transform behind the gutter menu) and
 * `openHeadingLevelMenu` (the popup opened by clicking a heading's `##` marker).
 *
 * Both drive the REAL Milkdown editor (real parser, real schema, the production
 * serialization config) so the position math and node markup match production.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { setHeadingLevelAt } from "../plugins/headingFold";

// openHeadingLevelMenu is not exported (it's DOM-internal), so we exercise it
// through the marker button the plugin renders. The plugin registration wires
// the gutter widget; clicking its marker opens the menu on <body>.
import { headingFoldPlugin } from "../plugins/headingFold";

let editors: Editor[] = [];

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
        .use(gfm)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown()).trim();
}

/** Document position of the first heading node (0 when it leads the doc). */
function firstHeadingPos(v: EditorView): number {
    let pos = -1;
    v.state.doc.forEach((node, offset) => {
        if (pos === -1 && node.type.name === "heading") {
            pos = offset;
        }
    });
    return pos;
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.querySelectorAll(".block-menu").forEach((el) => el.remove());
    document.body.innerHTML = "";
});

describe("setHeadingLevelAt", () => {
    it("a different heading level should retype the heading in place", async () => {
        // Arrange
        const editor = await makeEditor("## Title\n\nBody");
        const v = view(editor);
        const pos = firstHeadingPos(v);

        // Act
        const changed = setHeadingLevelAt(v, pos, 4);

        // Assert
        expect(changed).toBe(true);
        expect(v.state.doc.nodeAt(pos)!.attrs["level"]).toBe(4);
        expect(markdown(editor)).toBe("#### Title\n\nBody");
    });

    it("level 0 should convert the heading to a paragraph", async () => {
        // Arrange
        const editor = await makeEditor("## Title\n\nBody");
        const v = view(editor);
        const pos = firstHeadingPos(v);

        // Act
        const changed = setHeadingLevelAt(v, pos, 0);

        // Assert
        expect(changed).toBe(true);
        expect(v.state.doc.nodeAt(pos)!.type.name).toBe("paragraph");
        expect(markdown(editor)).toBe("Title\n\nBody");
    });

    it("the same heading level should be a no-op returning false", async () => {
        // Arrange
        const editor = await makeEditor("## Title");
        const v = view(editor);
        const pos = firstHeadingPos(v);

        // Act
        const changed = setHeadingLevelAt(v, pos, 2);

        // Assert
        expect(changed).toBe(false);
        expect(v.state.doc.nodeAt(pos)!.attrs["level"]).toBe(2);
    });

    it("a paragraph position should promote to the picked heading level", async () => {
        // Arrange: a bare paragraph at position 0 (the paragraph gutter's path)
        const editor = await makeEditor("Just a paragraph");
        const v = view(editor);

        // Act
        const changed = setHeadingLevelAt(v, 0, 3);

        // Assert
        expect(changed).toBe(true);
        expect(v.state.doc.nodeAt(0)!.type.name).toBe("heading");
        expect(v.state.doc.nodeAt(0)!.attrs["level"]).toBe(3);
        expect(markdown(editor)).toContain("### Just a paragraph");
    });

    it("a paragraph position with level 0 should be a no-op (already P)", async () => {
        const editor = await makeEditor("Just a paragraph");
        const v = view(editor);
        const before = markdown(editor);
        expect(setHeadingLevelAt(v, 0, 0)).toBe(false);
        expect(markdown(editor)).toBe(before);
    });

    it("a position that is neither heading nor paragraph should return false", async () => {
        // Arrange: a code block — not a retypeable block
        const editor = await makeEditor("```js\nlet x = 1\n```");
        const v = view(editor);
        const before = markdown(editor);

        // Act
        const changed = setHeadingLevelAt(v, 0, 3);

        // Assert
        expect(changed).toBe(false);
        expect(markdown(editor)).toBe(before);
    });

    it("an out-of-clamp level should be clamped into 1..6", async () => {
        // Arrange
        const editor = await makeEditor("# Title");
        const v = view(editor);
        const pos = firstHeadingPos(v);

        // Act: 9 clamps to 6
        const changed = setHeadingLevelAt(v, pos, 9);

        // Assert
        expect(changed).toBe(true);
        expect(v.state.doc.nodeAt(pos)!.attrs["level"]).toBe(6);
    });
});

/** The <body>-mounted level menu, if open. */
function levelMenu(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".block-menu");
}

/** The heading's gutter marker button (opens the level menu). */
function marker(): HTMLButtonElement {
    const el = document.querySelector<HTMLButtonElement>(".heading-fold-marker");
    expect(el, "gutter marker not rendered").not.toBeNull();
    return el!;
}

function clickMouse(el: HTMLElement, type: "mousedown" | "click"): void {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
}

describe("heading gutter level menu", () => {
    it("clicking the marker should open the block menu with the current level checked", async () => {
        // Arrange
        const editor = await makeEditor("## Title\n\nBody");
        view(editor); // force layout

        // Act
        clickMouse(marker(), "click");

        // Assert: the Turn-into section leads with the level radio, then the
        // conversions, then the block actions (heading flavor: Copy Link +
        // section moves).
        const menu = levelMenu();
        expect(menu).not.toBeNull();
        const rows = menu!.querySelectorAll(".block-menu-item-label");
        expect(Array.from(rows).map((r) => r.textContent)).toEqual([
            "Paragraph", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6",
            "Bullet List", "Ordered List", "Task List", "Blockquote", "Callout", "Code Block",
            "Duplicate", "Copy as Markdown", "Copy Link",
            "Move Section Up", "Move Section Down",
            "Fold All", "Unfold All", "Delete",
        ]);
        // Two labeled sections frame the rows (slash-menu group idiom).
        expect(Array.from(menu!.querySelectorAll(".block-menu-header")).map((h) => h.textContent))
            .toEqual(["Turn into", "Actions"]);
        const active = menu!.querySelector(".block-menu-item--active");
        expect(active!.querySelector(".block-menu-item-label")!.textContent).toBe("Heading 2");
        expect(active!.getAttribute("aria-checked")).toBe("true");
    });

    it("picking a level should retype the heading and close the menu", async () => {
        // Arrange
        const editor = await makeEditor("## Title");
        const v = view(editor);
        clickMouse(marker(), "click");

        // Act: pick H4 (rows are P,H1,H2,H3,H4,... → index 4)
        const rows = levelMenu()!.querySelectorAll<HTMLButtonElement>(".block-menu-item");
        clickMouse(rows[4]!, "mousedown");

        // Assert
        expect(levelMenu()).toBeNull();
        expect(v.state.doc.nodeAt(firstHeadingPos(v))!.attrs["level"]).toBe(4);
    });

    it("picking P should convert the heading to a paragraph", async () => {
        // Arrange
        const editor = await makeEditor("### Heading");
        const v = view(editor);
        clickMouse(marker(), "click");

        // Act: first row is P
        const rows = levelMenu()!.querySelectorAll<HTMLButtonElement>(".block-menu-item");
        clickMouse(rows[0]!, "mousedown");

        // Assert
        expect(levelMenu()).toBeNull();
        expect(v.state.doc.firstChild!.type.name).toBe("paragraph");
    });

    it("a top-level paragraph should render a 'P' gutter marker that opens the same menu", async () => {
        // Arrange: paragraph only — the paragraph gutter's own marker
        const editor = await makeEditor("Just a paragraph");
        const v = view(editor);
        const pMarker = document.querySelector<HTMLButtonElement>(".heading-fold-marker--paragraph");
        expect(pMarker).not.toBeNull();
        // The marker is the slash menu's Paragraph icon (pilcrow SVG).
        expect(pMarker!.querySelector("svg")).not.toBeNull();
        expect(pMarker!.dataset["pill"]).toBe("Paragraph");

        // Act: open the menu and pick H2 (rows are P,H1,H2 → index 2)
        clickMouse(pMarker!, "click");
        const menu = levelMenu();
        expect(menu).not.toBeNull();
        // P is the checked current level for a paragraph.
        expect(menu!.querySelector(".block-menu-item--active .block-menu-item-label")!.textContent).toBe("Paragraph");
        const rows = menu!.querySelectorAll<HTMLButtonElement>(".block-menu-item");
        clickMouse(rows[2]!, "mousedown");

        // Assert: promoted, menu closed
        expect(levelMenu()).toBeNull();
        expect(v.state.doc.firstChild!.type.name).toBe("heading");
        expect(v.state.doc.firstChild!.attrs["level"]).toBe(2);
    });

    it("a paragraph inside a blockquote should NOT render a paragraph gutter", async () => {
        const editor = await makeEditor("> quoted text");
        view(editor);
        expect(document.querySelector(".heading-fold-marker--paragraph")).toBeNull();
    });

    // MAR-79: standalone images/HTML parse as paragraphs wrapping a single
    // inline atom — "P" (a text-level cue) and the heading retype menu are
    // wrong for them.
    it("an image-only paragraph should NOT render a paragraph gutter", async () => {
        const editor = await makeEditor("![two cats](cats.jpg)");
        view(editor);
        expect(document.querySelector(".heading-fold-marker--paragraph")).toBeNull();
    });

    it("an html-only paragraph should NOT render a paragraph gutter", async () => {
        const editor = await makeEditor("<div align='center'>Centered raw HTML block</div>");
        view(editor);
        expect(document.querySelector(".heading-fold-marker--paragraph")).toBeNull();
    });

    it("a paragraph mixing text and an inline image SHOULD render a paragraph gutter", async () => {
        const editor = await makeEditor("An inline ![icon](i.png) in a sentence");
        view(editor);
        expect(document.querySelector(".heading-fold-marker--paragraph")).not.toBeNull();
    });

    it("an empty paragraph (blank line) SHOULD render a paragraph gutter", async () => {
        const editor = await makeEditor("");
        view(editor);
        expect(document.querySelector(".heading-fold-marker--paragraph")).not.toBeNull();
    });

    // ── Decoration caching (the typing-perf contract) ──

    it("typing inside a block should NOT rebuild the gutter widget DOM", async () => {
        const editor = await makeEditor("## Title\n\nBody text");
        const v = view(editor);
        const before = Array.from(document.querySelectorAll(".heading-fold-marker"));
        expect(before).toHaveLength(2);
        // Type into the paragraph — positions shift, structure doesn't.
        v.dispatch(v.state.tr.insertText("x", v.state.doc.content.size - 2));
        const after = Array.from(document.querySelectorAll(".heading-fold-marker"));
        expect(after).toHaveLength(2);
        // Same DOM elements, merely position-mapped — not recreated.
        expect(after[0]).toBe(before[0]);
        expect(after[1]).toBe(before[1]);
    });

    it("a selection-only transaction should return the identical plugin state", async () => {
        const { headingFoldPluginKey } = await import("../plugins/headingFold");
        const { TextSelection } = await import("@milkdown/prose/state");
        const editor = await makeEditor("## Title\n\nBody");
        const v = view(editor);
        const before = headingFoldPluginKey.getState(v.state);
        v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(3))));
        expect(headingFoldPluginKey.getState(v.state)).toBe(before);
    });

    it("a marker clicked AFTER earlier-block edits should still target its own block", async () => {
        // The stale-closure regression: widgets survive edits via position
        // mapping, so their handlers must derive the block position at
        // interaction time, not capture it at build time.
        const editor = await makeEditor("Alpha\n\n## Title");
        const v = view(editor);
        // Grow the first paragraph so every later position shifts.
        v.dispatch(v.state.tr.insertText("xxxxx", 1));
        const heading = Array.from(document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker"))
            .find((m) => m.textContent === "H2")!;
        clickMouse(heading, "click");
        const menu = levelMenu()!;
        expect(menu.querySelector(".block-menu-item--active .block-menu-item-label")!.textContent).toBe("Heading 2");
        // Retype via the menu: the SHIFTED heading must be the one retyped.
        const rows = menu.querySelectorAll<HTMLButtonElement>(".block-menu-item");
        clickMouse(rows[3]!, "mousedown"); // H3
        expect(markdown(editor)).toBe("xxxxxAlpha\n\n### Title");
    });

    it("Escape should close the menu", async () => {
        // Arrange
        const editor = await makeEditor("## Title");
        view(editor);
        clickMouse(marker(), "click");
        expect(levelMenu()).not.toBeNull();

        // Act
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        // Assert
        expect(levelMenu()).toBeNull();
    });

    it("clicking the same marker again should toggle the menu closed", async () => {
        // Arrange
        const editor = await makeEditor("## Title");
        view(editor);
        const m = marker();

        // Act + Assert: open …
        clickMouse(m, "click");
        expect(levelMenu()).not.toBeNull();
        // … then a re-click (mousedown is ignored on the anchor, click toggles).
        clickMouse(m, "mousedown");
        clickMouse(m, "click");
        expect(levelMenu()).toBeNull();
    });

    it("a keyboard open should focus the search input, current level marked", async () => {
        // Arrange
        const editor = await makeEditor("## Title");
        view(editor);

        // Act: a keyboard-activated button click reports detail 0
        marker().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));

        // Assert: focus lands in the "Search actions…" input (the Notion
        // pattern) with the current type accent-marked in the list below.
        expect(document.activeElement).toBe(levelMenu()!.querySelector(".block-menu-search"));
        const active = levelMenu()!.querySelector<HTMLElement>(".block-menu-item--active");
        expect(active!.querySelector(".block-menu-item-label")!.textContent).toBe("Heading 2");
    });

    it("arrow keys should move the highlight and Enter should activate it", async () => {
        // Arrange: keyboard-open on H2, focus in the search input
        const editor = await makeEditor("## Title");
        const v = view(editor);
        marker().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));

        // Act: ArrowDown highlights the first row (Paragraph), then Enter
        // activates it. Keydowns dispatch from the focused search input so
        // the capture handler sees it as event.target.
        const pressKey = (key: string): void =>
            document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        pressKey("ArrowDown");
        expect(levelMenu()!.querySelector(".block-menu-item--hl .block-menu-item-label")!.textContent)
            .toBe("Paragraph");
        pressKey("Enter");

        // Assert: heading retyped to a paragraph, menu closed
        expect(levelMenu()).toBeNull();
        expect(v.state.doc.child(0).type.name).toBe("paragraph");
        expect(v.state.doc.child(0).textContent).toBe("Title");
    });

    it("Escape should close a keyboard-opened menu and return focus to the marker", async () => {
        // Arrange
        const editor = await makeEditor("## Title");
        view(editor);
        const m = marker();
        m.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));

        // Act
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        // Assert
        expect(levelMenu()).toBeNull();
        expect(document.activeElement).toBe(m);
    });
});
