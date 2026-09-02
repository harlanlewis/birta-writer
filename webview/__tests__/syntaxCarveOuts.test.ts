/**
 * The two places a syntax target deliberately does NOT withdraw a control, and
 * the only two places in this feature where the rule is a carve-out rather than
 * the rule itself (shared/syntaxSets.ts).
 *
 * Both are promises the CHANGELOG makes by name: a callout in a CommonMark-only
 * note still says it is a callout, and a wikilink still keeps the Local link
 * format control so it can be converted rather than stranded. Both were
 * unpinned when this feature landed, which is the shape to distrust: the gate
 * itself has tests on every surface, and the exception written to stop the gate
 * reaching into an existing document had none, so nothing would have reported
 * it being dropped.
 *
 * Each carve-out is checked against the case it exists for AND against the case
 * it must not swallow, because a carve-out that fires everywhere would pass
 * every assertion about the thing it protects and quietly withdraw nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { contentGuardPlugin } from "../plugins/contentGuard";
import { insertCalloutCommand } from "../plugins/callouts";
import { BlockRangeSelection } from "../plugins/blockRange";
import { closeBlockMenu, openBlockMenuAtCaret, setBlockMenuContext } from "../components/blockMenu";
import { createLinkFormatSwitch } from "../components/linkPopup/formatSwitch";
import type { SyntaxSet } from "../../shared/syntaxSets";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

setBlockMenuContext({ getEditor: () => activeEditor });

/** Run `body` with `sets` declared, restoring whatever was there before. */
function withSets(sets: readonly SyntaxSet[], body: () => void): void {
    const globals = globalThis as { __i18n?: { syntaxSets?: readonly SyntaxSet[] } };
    const before = globals.__i18n;
    globals.__i18n = { ...(before ?? {}), syntaxSets: sets };
    try {
        body();
    } finally {
        globals.__i18n = before;
    }
}

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
        .use(headingFoldPlugin)
        .use(historyPlugin)
        .use(contentGuardPlugin)
        .use(insertCalloutCommand)
        .create();
    editors.push(editor);
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function caretIn(v: EditorView, pos: number): void {
    v.dispatch(v.state.tr.setSelection(
        BlockRangeSelection.tryCreate(v.state.doc, pos, pos) ?? v.state.selection,
    ));
}

/** Every Turn-into row's label, in render order. */
function turnIntoLabels(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>(".block-menu-item"))
        .map((row) => row.querySelector(".block-menu-item-label")?.textContent ?? "");
}

/** The label of the row marked as what the block already IS, or null. */
function currentLabel(): string | null {
    const active = Array.from(document.querySelectorAll<HTMLElement>(".block-menu-item"))
        .find((row) => row.getAttribute("aria-checked") === "true"
            || row.classList.contains("block-menu-item--active"));
    return active?.querySelector(".block-menu-item-label")?.textContent ?? null;
}

afterEach(() => {
    closeBlockMenu();
    for (const editor of editors) { void editor.destroy(); }
    editors = [];
    activeEditor = null;
    document.body.innerHTML = "";
});

describe("the block menu's own-kind carve-out", () => {
    it("a target with no callouts should still offer Callout on a block that IS one", async () => {
        const editor = await makeEditor("> [!NOTE] Heads up\n> body");
        const v = view(editor);
        withSets([], () => {
            caretIn(v, 3);
            expect(openBlockMenuAtCaret(v)).toBe(true);
            // The row is there and it is the CURRENT one, which is how this
            // menu says what you are looking at. Without it a callout in a
            // CommonMark-only note would open a menu with nothing marked,
            // which reads as a block the editor does not recognise.
            expect(turnIntoLabels()).toContain("Callout");
            expect(currentLabel()).toBe("Callout");
        });
    });

    it("the same target should still withdraw Callout on a block that is NOT one", async () => {
        // The discriminating half. Without it the assertion above would hold
        // for a carve-out that had simply switched the whole gate off.
        const editor = await makeEditor("just a paragraph");
        const v = view(editor);
        withSets([], () => {
            caretIn(v, 1);
            expect(openBlockMenuAtCaret(v)).toBe(true);
            const labels = turnIntoLabels();
            expect(labels).not.toContain("Callout");
            expect(labels).not.toContain("Task List");
            // And the CommonMark rows are all still there, so the menu was
            // narrowed rather than emptied.
            expect(labels).toContain("Bullet List");
            expect(labels).toContain("Blockquote");
            expect(labels).toContain("Code Block");
        });
    });

    it("with every target on, a paragraph should be offered the gated rows too", async () => {
        const editor = await makeEditor("just a paragraph");
        const v = view(editor);
        withSets(["gfm", "obsidian", "pandoc", "birta"], () => {
            caretIn(v, 1);
            expect(openBlockMenuAtCaret(v)).toBe(true);
            const labels = turnIntoLabels();
            expect(labels).toContain("Callout");
            expect(labels).toContain("Task List");
        });
    });
});

describe("the link popup's existing-wikilink carve-out", () => {
    const visible = (sw: { el: HTMLElement }): boolean => sw.el.style.display !== "none";

    it("a target with no wikilinks should hide the Format row on a markdown link", () => {
        withSets(["gfm"], () => {
            const sw = createLinkFormatSwitch("markdown");
            sw.setWikiAllowed(true);
            expect(visible(sw)).toBe(false);
            expect(sw.get()).toBe("markdown");
        });
    });

    it("the same target should keep the row on a link that ALREADY is a wikilink", () => {
        withSets(["gfm"], () => {
            const sw = createLinkFormatSwitch("markdown");
            // The popup sets the link's own format before asking about the
            // target, which is the order this carve-out depends on.
            sw.set("wikilink");
            sw.setWikiAllowed(true);
            expect(visible(sw)).toBe(true);
            // And it is NOT rewritten to markdown, which is the whole point:
            // narrowing the target must not convert a link the author typed.
            expect(sw.get()).toBe("wikilink");
        });
    });

    it("a target that cannot be a wikilink should still win over the carve-out", () => {
        // An external URL is not expressible as a wikilink at all, so the
        // carve-out must not resurrect the row for one. This is the case the
        // carve-out could have swallowed by reading only the syntax target.
        withSets(["obsidian"], () => {
            const sw = createLinkFormatSwitch("markdown");
            sw.set("wikilink");
            sw.setWikiAllowed(false);
            expect(visible(sw)).toBe(false);
            expect(sw.get()).toBe("markdown");
        });
    });

    it("a target that spells wikilinks should offer the row on a plain markdown link", () => {
        withSets(["obsidian"], () => {
            const sw = createLinkFormatSwitch("markdown");
            sw.setWikiAllowed(true);
            expect(visible(sw)).toBe(true);
        });
    });
});
