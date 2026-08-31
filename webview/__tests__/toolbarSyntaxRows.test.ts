/**
 * The rows a family dropdown withdraws when the reader narrows their
 * publishing target, read back off a real toolbar.
 *
 * The registry decides which CONTROLS leave the bar; this is the other half,
 * and the half a table cannot answer. Lists, Code and Quote each mix CommonMark
 * with something beyond it, so each stays on the bar and has to drop rows of
 * its own, and each has a separator whose group can empty underneath it.
 *
 * Read off the built DOM rather than off the gate function, because the failure
 * here is not the predicate: it is a row that was gated and never re-gated, or
 * a rule left drawn over nothing. Both look correct in every table.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { initToolbar } from "../components/toolbar";
import { runEditorCommand } from "../editorCommands";
import { ALL_SYNTAX_SETS, type SyntaxSet } from "../../shared/syntaxSets";

let editors: Editor[] = [];

async function makeEditor(): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, "hello\n");
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

/** Declare `sets` before the toolbar is built, keeping the rest of the blob. */
function declare(sets: readonly SyntaxSet[] | undefined): void {
    const blob = (window as unknown as { __i18n?: Record<string, unknown> }).__i18n ?? {};
    (window as unknown as { __i18n?: Record<string, unknown> }).__i18n =
        { ...blob, syntaxSets: sets };
}

/** The row labels a reader would see in the dropdown of `itemId`. */
function rowLabels(topbar: HTMLElement, itemId: string): string[] {
    const menu = topbar.querySelector<HTMLElement>(`[data-item-id="${itemId}"] .tb-fmt-menu`);
    if (!menu) { return []; }
    return Array.from(menu.children)
        .filter((el) => !(el as HTMLElement).hidden)
        .map((el) => (el.classList.contains("ui-menu-divider") ? "-" : (el.textContent ?? "").trim()));
}

async function toolbar(): Promise<HTMLElement> {
    const editor = await makeEditor();
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    initToolbar(topbar, () => editor);
    return topbar;
}

const originalI18n = (window as unknown as { __i18n?: unknown }).__i18n;

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.replaceChildren();
    (window as unknown as { __i18n?: unknown }).__i18n = originalI18n;
});

describe("family dropdowns under a narrowed target", () => {
    it("with every target on, every row should be drawn", async () => {
        declare(ALL_SYNTAX_SETS);
        const topbar = await toolbar();
        expect(rowLabels(topbar, "listMenu")).toContain("Task List");
        expect(rowLabels(topbar, "codeBlock")).toContain("Mermaid Diagram");
        expect(rowLabels(topbar, "codeBlock")).toContain("Math Block");
        expect(rowLabels(topbar, "quote")).toContain("Note");
    });

    it("the Lists menu should lose its task row and keep the two CommonMark ones", async () => {
        declare([]);
        const topbar = await toolbar();
        const rows = rowLabels(topbar, "listMenu");
        expect(rows).toContain("Bullet List");
        expect(rows).toContain("Ordered List");
        expect(rows).not.toContain("Task List");
    });

    it("the Code menu should lose both language rows AND the rule above them", async () => {
        // The rule is the part a row-only gate gets wrong: it draws a group
        // boundary, so one left over the empty half is a line at the foot of
        // the menu.
        declare([]);
        const topbar = await toolbar();
        const rows = rowLabels(topbar, "codeBlock");
        expect(rows).toEqual(["Code Block"]);
    });

    it("the Quote menu should lose all five callouts AND the rule above them", async () => {
        declare([]);
        const topbar = await toolbar();
        expect(rowLabels(topbar, "quote")).toEqual(["Blockquote"]);
    });

    it("a target that spells one of a menu's rows should keep that menu's rule", async () => {
        // GitHub spells Mermaid and math but Birta's SVG fence is elsewhere, so
        // the Code menu keeps its group and its rule. The discriminating case
        // for the separator rule: it goes when the group EMPTIES, not whenever
        // any row in it is withdrawn.
        declare(["gfm"]);
        const topbar = await toolbar();
        const rows = rowLabels(topbar, "codeBlock");
        expect(rows).toContain("-");
        expect(rows).toContain("Mermaid Diagram");
        expect(rows).toContain("Math Block");
    });

    it("re-gating live should put the rows back without rebuilding the bar", async () => {
        // The bar is built once and outlives a settings change, so the rows
        // have to come back rather than being reconstructed. A gate applied
        // only at build would pass every case above and fail here.
        declare([]);
        const editor = await makeEditor();
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        document.body.appendChild(topbar);
        const tb = initToolbar(topbar, () => editor);
        expect(rowLabels(topbar, "quote")).toEqual(["Blockquote"]);

        declare(ALL_SYNTAX_SETS);
        tb.applySyntaxSets();
        expect(rowLabels(topbar, "quote")).toContain("Note");
        expect(rowLabels(topbar, "listMenu")).toContain("Task List");
    });

    it("a target change during Customize Toolbar should land when the tray closes", async () => {
        // The tray's exit keeps the DOM rather than rebuilding, because the
        // config echo can lag the drags. That is right for a placement and
        // wrong for a withdrawal: an item the target no longer spells would sit
        // on the bar as a control that does nothing when clicked. Delete the
        // deferred-apply branch in `layout.ts` and this goes red.
        declare(ALL_SYNTAX_SETS);
        const editor = await makeEditor();
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        document.body.appendChild(topbar);
        const tb = initToolbar(topbar, () => editor);
        const placed = (): string[] => Array.from(
            topbar.querySelectorAll<HTMLElement>(".tb-item"),
        ).map((el) => el.dataset["itemId"] ?? "");
        expect(placed()).toContain("table");

        // Entered the way every surface enters it, through the command
        // `initToolbar` registers a host for, rather than through a handle
        // method the bar does not expose.
        runEditorCommand("customizeToolbar", () => editor);
        declare([]);
        tb.applySyntaxSets();
        // Deferred while the tray is open: the drag state is the DOM's, and a
        // rebuild mid-session would drop it.
        expect(placed()).toContain("table");

        const done = document.querySelector<HTMLElement>(".tb-edit-done");
        expect(done, "the customize tray should have a Done button").not.toBeNull();
        done!.click();
        expect(placed()).not.toContain("table");
        expect(placed()).toContain("bold");
    });

    it("re-gating live should also re-place the items on the bar", async () => {
        declare(ALL_SYNTAX_SETS);
        const editor = await makeEditor();
        const topbar = document.createElement("div");
        topbar.className = "editor-topbar";
        document.body.appendChild(topbar);
        const tb = initToolbar(topbar, () => editor);
        const placed = (): string[] => Array.from(
            topbar.querySelectorAll<HTMLElement>(".tb-item"),
        ).map((el) => el.dataset["itemId"] ?? "");
        expect(placed()).toContain("table");

        declare([]);
        tb.applySyntaxSets();
        expect(placed()).not.toContain("table");
        expect(placed()).toContain("listMenu");
    });
});
