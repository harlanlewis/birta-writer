/**
 * What a narrowed syntax target actually does to the surfaces that offer tools.
 *
 * The unit under test is the seam, not each button: every surface asks one
 * predicate, so what is worth pinning is that each surface asks it at all, and
 * that the two shapes of answer stay distinct. A control whose every command
 * is withdrawn LEAVES; a menu whose commands are mixed STAYS with one row
 * fewer. Getting the second wrong is the failure with no visible symptom until
 * somebody notices their bullet lists went away with their task lists.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { offeredItems, hostAvailableItems } from "../components/toolbar/registry";
import { resolveVisible, ITEM_SYNTAX, FLOATING_TOOLBAR_ITEM_IDS } from "../components/selectionToolbar/registry";
import { SLASH_MENU_ITEMS } from "../components/slashMenu/registry";
import { commandAvailable } from "../../shared/commandAvailability";
import { syntaxAllows, ALL_SYNTAX_SETS, type SyntaxSet } from "../../shared/syntaxSets";

/** Declare `sets` for the duration of a case. Undefined means "says nothing". */
function declare(sets: readonly SyntaxSet[] | undefined): void {
    (window as unknown as { __i18n?: { syntaxSets?: readonly SyntaxSet[] } }).__i18n =
        { syntaxSets: sets };
}

const before = (window as unknown as { __i18n?: unknown }).__i18n;
afterEach(() => {
    (window as unknown as { __i18n?: unknown }).__i18n = before;
});

describe("the top toolbar under a narrowed target", () => {
    it("a page that declares nothing should offer every item the host can carry", () => {
        declare(undefined);
        expect([...offeredItems()].sort()).toEqual([...hostAvailableItems()].sort());
    });

    it("an item whose every command is withdrawn should leave the bar", () => {
        declare([]);
        const offered = offeredItems();
        for (const id of ["table", "strikethrough", "highlight", "math", "footnote"] as const) {
            expect(offered.has(id), `${id} should be withdrawn`).toBe(false);
        }
    });

    it("an item whose commands are MIXED should stay, so its CommonMark rows survive", () => {
        declare([]);
        const offered = offeredItems();
        // The list menu runs bullet, ordered and task; the quote menu runs
        // blockquote and callout. In both, the first commands are CommonMark,
        // so the control stays and filters its own rows. This is the assertion
        // that discriminates: an `every`-shaped withdrawal keeps them and a
        // `some`-shaped one would take both away.
        expect(offered.has("listMenu")).toBe(true);
        expect(offered.has("quote")).toBe(true);
        // And the plainly-CommonMark controls are untouched.
        expect(offered.has("bold")).toBe(true);
        expect(offered.has("codeBlock")).toBe(true);
        expect(offered.has("link")).toBe(true);
    });

    it("re-enabling the target that spells an item should bring it back", () => {
        declare([]);
        expect(offeredItems().has("table")).toBe(false);
        declare(["gfm"]);
        expect(offeredItems().has("table")).toBe(true);
        // Obsidian's alone, so GitHub does not bring the highlight button.
        expect(offeredItems().has("highlight")).toBe(false);
        declare(["obsidian"]);
        expect(offeredItems().has("highlight")).toBe(true);
    });

    it("every set enabled should be the same bar as no declaration at all", () => {
        declare(undefined);
        const silent = [...offeredItems()].sort();
        declare(ALL_SYNTAX_SETS);
        expect([...offeredItems()].sort()).toEqual(silent);
    });
});

describe("the floating palette under a narrowed target", () => {
    it("its syntax table should cover every item, so a new one cannot be missed", () => {
        expect(Object.keys(ITEM_SYNTAX).sort())
            .toEqual([...FLOATING_TOOLBAR_ITEM_IDS].sort());
    });

    it("a target should withdraw an item the user explicitly switched ON", () => {
        // The palette's own settings say which controls this reader wants; the
        // target says which of them write Markdown the document is meant to
        // contain. An explicit `true` must not win over that, or the two
        // settings would contradict each other with the palette taking the
        // reader's side against their own target.
        declare([]);
        const visible = resolveVisible({ strikethrough: true, highlight: true, math: true });
        expect(visible.has("strikethrough")).toBe(false);
        expect(visible.has("highlight")).toBe(false);
        expect(visible.has("math")).toBe(false);
        // CommonMark items keep the setting's answer, so the gate is not simply
        // emptying the palette.
        expect(visible.has("bold")).toBe(true);
        expect(visible.has("link")).toBe(true);
    });

    it("with every target on, the settings alone should decide", () => {
        declare(ALL_SYNTAX_SETS);
        const visible = resolveVisible({ strikethrough: true, highlight: true });
        expect(visible.has("strikethrough")).toBe(true);
        expect(visible.has("highlight")).toBe(true);
        // Still off by its shipped default, which the target did not change.
        expect(visible.has("math")).toBe(false);
    });
});

describe("the slash registry under a narrowed target", () => {
    /** The rows a menu built now would offer, by the filter `index.ts` applies. */
    const offered = (): string[] =>
        SLASH_MENU_ITEMS
            .filter((item) => (item.visibleWhen?.() ?? true)
                && commandAvailable(item.commandId)
                && syntaxAllows(item.syntax))
            .map((item) => item.id);

    it("rows whose command declares a syntax should go with it", () => {
        declare([]);
        const ids = offered();
        for (const id of ["table", "taskList", "footnote", "math", "callout", "callout-note"]) {
            expect(ids, `/${id} should be withdrawn`).not.toContain(id);
        }
    });

    it("the four rows that share insertCodeBlock should go by their OWN syntax", () => {
        // `insertCodeBlock` writes a plain fence and is CommonMark, so its
        // command can carry no answer for these. Without the row-level field
        // they would all survive a CommonMark-only target while every other
        // diagram and math affordance went, which is the case this pins.
        declare([]);
        const ids = offered();
        expect(ids).toContain("codeBlock");
        for (const id of ["mermaid", "svgBlock", "mathBlock", "calcBlock"]) {
            expect(ids, `/${id} should be withdrawn`).not.toContain(id);
        }
    });

    it("each of those rows should come back with the target that spells it", () => {
        declare(["gfm"]);
        expect(offered()).toContain("mermaid");
        expect(offered()).not.toContain("calcBlock");
        declare(["birta"]);
        expect(offered()).toContain("calcBlock");
        expect(offered()).toContain("svgBlock");
        expect(offered()).not.toContain("mermaid");
    });

    it("the CommonMark rows should be untouched by any target", () => {
        declare([]);
        const ids = offered();
        for (const id of ["paragraph", "heading1", "bulletList", "orderedList",
                          "blockquote", "codeBlock", "link", "divider"]) {
            expect(ids, `/${id} should survive`).toContain(id);
        }
    });

    it("a row declaring a syntax should name one the vocabulary knows", () => {
        const declared = SLASH_MENU_ITEMS.flatMap((item) => item.syntax ? [item.syntax] : []);
        expect(declared.length).toBeGreaterThan(0);
        for (const feature of declared) {
            expect(syntaxAllows(feature)).toBeTypeOf("boolean");
        }
    });
});

describe("what a target must never reach", () => {
    beforeEach(() => declare([]));

    it("editing a construct the document already holds should stay available", () => {
        // The line this whole feature stands on: a document renders everything
        // it contains under every target, so the controls for what is already
        // there cannot go. A table in a CommonMark-only note is still a table,
        // and its rows and columns are still editable.
        for (const id of ["tableInsertRowAbove", "tableInsertColumnRight",
                          "tableAlignColumnLeft", "tableDeleteRow", "tableDeleteTable",
                          "toggleTaskChecked", "uncheckAllTasks"]) {
            expect(commandAvailable(id), `${id} should survive every target`).toBe(true);
        }
    });

    it("reading and chrome commands should be untouched", () => {
        for (const id of ["openFind", "copyAsMarkdown", "exportHtml", "toggleToc",
                          "editRawMarkdown", "foldAll"]) {
            expect(commandAvailable(id), id).toBe(true);
        }
    });
});
