/**
 * Multi-block Turn-into (MAR-115): a run of covered blocks offers the
 * INTERSECTION of its blocks' legal targets, and one pick converts the whole
 * run as one gesture and one undo step (webview/blockCapabilities.ts
 * `canConvertRange` / `convertRange`, the block menu's range mode in
 * components/blockMenu/menu.ts).
 *
 * Drives the REAL Milkdown editor (real parser, real schema, the production
 * serialization config, real history and content guard), like
 * blockMenu.test.ts. Two invariants carry the sweep, per AGENTS.md "Choosing
 * what to assert": schema-valid (`doc.check()`) and round-trip stable
 * (serialize, parse, serialize), plus the one this feature adds, that a
 * single undo restores the original document.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, serializerCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { TextSelection, undo } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { contentGuardPlugin } from "../plugins/contentGuard";
import { insertCalloutCommand } from "../plugins/callouts";
import { listAutoJoinPlugin } from "../plugins/list";
import { BlockRangeSelection } from "../plugins/blockRange";
import { closeBlockMenu, LOSS_NOTES, openBlockMenuAtCaret, setBlockMenuContext } from "../components/blockMenu";
import {
    ALL_KINDS,
    canConvert,
    canConvertRange,
    conversionKindAt,
    convertRange,
    coveredBlockPositions,
    type ConversionKind,
} from "../blockCapabilities";

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

setBlockMenuContext({ getEditor: () => activeEditor });
const getEditor = (): Editor | null => activeEditor;

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
        // The auto-join plugin is in the loop on purpose: it appends its
        // own transaction when a conversion lands a list next to one, which
        // is how a run can grow past the blocks it covered.
        .use(listAutoJoinPlugin)
        .create();
    editors.push(editor);
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown()).trim();
}

/** serialize → parse → serialize, the round-trip oracle. */
function reserialized(editor: Editor, source: string): string {
    return editor.action((ctx) => {
        const doc = ctx.get(parserCtx)(source);
        return doc ? ctx.get(serializerCtx)(doc).trim() : "<unparsable>";
    });
}

/** The whole document as a block-range selection. */
function selectAll(v: EditorView): void {
    const range = BlockRangeSelection.tryCreate(v.state.doc, 0, v.state.doc.content.size);
    expect(range).not.toBeNull();
    v.dispatch(v.state.tr.setSelection(range!));
}

function wholeDoc(v: EditorView): { from: number; to: number } {
    return { from: 0, to: v.state.doc.content.size };
}

function topLevelTypes(v: EditorView): string[] {
    const names: string[] = [];
    v.state.doc.forEach((node) => {
        names.push(node.type.name);
    });
    return names;
}

afterEach(async () => {
    closeBlockMenu();
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    activeEditor = null;
    document.body.className = "";
    document.body.innerHTML = "";
});

/** One block per convertible source SHAPE (prose, heading, list, task list,
 * quote, callout), so the intersection has something to disagree about. */
const MIXED_RUN = [
    "plain text",
    "",
    "## Title",
    "",
    "- bullet",
    "",
    "* [ ] task",
    "",
    "> quoted",
    "",
    "> [!NOTE] Heads up",
    "> body",
].join("\n");

describe("canConvertRange", () => {
    it("a mixed run should offer exactly the intersection of its blocks' legal targets", async () => {
        const v = view(await makeEditor(MIXED_RUN));
        const range = wholeDoc(v);
        const positions = coveredBlockPositions(v.state.doc, range);
        expect(positions).toHaveLength(6);

        const offered = ALL_KINDS.filter((kind) => canConvertRange(v, range, kind));
        const intersection = ALL_KINDS.filter((kind) =>
            positions.every((pos) => canConvert(v, pos, kind)));
        expect(offered).toEqual(intersection);
        // The intersection is a real subset, and a non-empty one: every
        // source shape here can become prose, a list, a quote, a callout or
        // a fence, and none of them can become a directive.
        expect(offered.length).toBeGreaterThan(0);
        expect(offered.length).toBeLessThan(ALL_KINDS.length);
        expect(offered).not.toContain("directive");
    });

    it("a run that includes a block with no conversion kind should offer nothing (never apply-where-legal)", async () => {
        const v = view(await makeEditor(["one", "", "---", "", "two"].join("\n")));
        const range = wholeDoc(v);
        expect(coveredBlockPositions(v.state.doc, range)).toHaveLength(3);
        const offered = ALL_KINDS.filter((kind) => canConvertRange(v, range, kind));
        expect(offered).toEqual([]);
        // …and the run really would have converted around the rule otherwise.
        expect(canConvert(v, 0, "h2")).toBe(true);
    });

    it("a single-block range should not be a run", async () => {
        const v = view(await makeEditor("alone"));
        expect(canConvertRange(v, wholeDoc(v), "h2")).toBe(false);
        expect(canConvert(v, 0, "h2")).toBe(true);
    });
});

describe("convertRange sweep", () => {
    it("every offered target should convert the mixed run schema-valid, round-trip stable, and undo in ONE step", async () => {
        const editor = await makeEditor(MIXED_RUN);
        const v = view(editor);
        const original = markdown(editor);
        const offered = ALL_KINDS.filter((kind) => canConvertRange(v, wholeDoc(v), kind));
        expect(offered.length).toBeGreaterThan(0);

        const converted: ConversionKind[] = [];
        for (const kind of offered) {
            selectAll(v);
            const before = v.state.doc;
            expect(convertRange(v, wholeDoc(v), kind, getEditor), `convertRange → ${kind}`).toBe(true);
            expect(v.state.doc.eq(before), `${kind} changed nothing`).toBe(false);
            expect(() => v.state.doc.check()).not.toThrow();
            const after = markdown(editor);
            expect(reserialized(editor, after), `${kind} round-trip`).toBe(after);
            // Intersection semantics, checked on the output rather than
            // the predicate: a prose target leaves at least one block of
            // that kind per covered block (a quote's body paragraphs trail
            // its retyped first block, the single-block rule); any other
            // target leaves NOTHING in the run but blocks of that kind
            // (one, unless a marker split the author spelled keeps two
            // lists apart, which the results suite pins).
            const kindsAfter = coveredBlockPositions(v.state.doc, wholeDoc(v))
                .map((pos) => conversionKindAt(v, pos));
            if (kind === "paragraph" || /^h[1-6]$/.test(kind)) {
                expect(kindsAfter.filter((k) => k === kind).length, `${kind}: run is [${kindsAfter}]`)
                    .toBeGreaterThanOrEqual(6);
            } else {
                expect(kindsAfter.length, `${kind}: run is [${kindsAfter}]`).toBeLessThanOrEqual(2);
                expect(kindsAfter.every((k) => k === kind), `${kind}: run is [${kindsAfter}]`).toBe(true);
            }

            expect(undo(v.state, v.dispatch), `${kind} undo`).toBe(true);
            expect(markdown(editor), `${kind}: one undo restores the document`).toBe(original);
            converted.push(kind);
        }
        expect(converted).toEqual(offered);
    });
});

describe("convertRange results", () => {
    const THREE = ["one", "", "two", "", "three"].join("\n");

    it("three paragraphs → Bullet List should be ONE list with an item per block", async () => {
        const editor = await makeEditor(THREE);
        const v = view(editor);
        selectAll(v);
        expect(convertRange(v, wholeDoc(v), "bulletList", getEditor)).toBe(true);
        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(markdown(editor)).toBe("- one\n- two\n- three");
        // The run stays selected as a block range over the result.
        expect(v.state.selection).toBeInstanceOf(BlockRangeSelection);
        expect(v.state.selection.from).toBe(0);
        expect(v.state.selection.to).toBe(v.state.doc.content.size);
    });

    it("three paragraphs → Quote should be ONE quote holding all three", async () => {
        const editor = await makeEditor(THREE);
        const v = view(editor);
        selectAll(v);
        expect(convertRange(v, wholeDoc(v), "blockquote", getEditor)).toBe(true);
        expect(topLevelTypes(v)).toEqual(["blockquote"]);
        expect(markdown(editor)).toBe("> one\n>\n> two\n>\n> three");
    });

    it("three paragraphs → Heading 2 should retype each block", async () => {
        const editor = await makeEditor(THREE);
        const v = view(editor);
        selectAll(v);
        expect(convertRange(v, wholeDoc(v), "h2", getEditor)).toBe(true);
        expect(markdown(editor)).toBe("## one\n\n## two\n\n## three");
    });

    it("a paragraph and a list → Code Block should be ONE fence holding the run's markdown", async () => {
        const editor = await makeEditor(["intro", "", "- a", "- b"].join("\n"));
        const v = view(editor);
        selectAll(v);
        expect(convertRange(v, wholeDoc(v), "codeBlock", getEditor)).toBe(true);
        expect(topLevelTypes(v)).toEqual(["code_block"]);
        expect(v.state.doc.firstChild!.textContent).toBe("intro\n\n- a\n- b");
    });

    it("a paragraph, a bullet list and a quote → Bullet List should itemize the paragraph and unwrap the quote into ONE list", async () => {
        const editor = await makeEditor(["intro", "", "- a", "- b", "", "> quoted"].join("\n"));
        const v = view(editor);
        selectAll(v);
        expect(convertRange(v, wholeDoc(v), "bulletList", getEditor)).toBe(true);
        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(markdown(editor)).toBe("- intro\n- a\n- b\n- quoted");
    });

    it("two bullet lists spelling different markers → Numbered List should retype and join them", async () => {
        const editor = await makeEditor(["- a", "", "+ b"].join("\n"));
        const v = view(editor);
        expect(topLevelTypes(v)).toEqual(["bullet_list", "bullet_list"]);
        selectAll(v);
        expect(convertRange(v, wholeDoc(v), "orderedList", getEditor)).toBe(true);
        expect(topLevelTypes(v)).toEqual(["ordered_list"]);
        expect(markdown(editor)).toBe("1. a\n2. b");
    });

    it("a paragraph between two lists spelling different markers → Bullet List should keep the author's split", async () => {
        const editor = await makeEditor(["- a", "", "middle", "", "* b"].join("\n"));
        const v = view(editor);
        selectAll(v);
        expect(convertRange(v, wholeDoc(v), "bulletList", getEditor)).toBe(true);
        // The paragraph joined the `-` list above it (no marker to defend);
        // the `*` list stays its own block.
        expect(markdown(editor)).toBe("- a\n- middle\n\n* b");
    });

    it("a run whose blocks are all already the target should refuse to join across a marker split", async () => {
        const editor = await makeEditor(["- a", "", "+ b"].join("\n"));
        const v = view(editor);
        selectAll(v);
        // Both blocks are bullet lists: nothing to convert, and the `-`/`+`
        // split the author spelled is theirs to keep.
        expect(convertRange(v, wholeDoc(v), "bulletList", getEditor)).toBe(false);
        expect(topLevelTypes(v)).toEqual(["bullet_list", "bullet_list"]);
    });

    it("a run converted to a list beside an existing list should join it once, and undo once", async () => {
        const editor = await makeEditor(["one", "", "two", "", "- x"].join("\n"));
        const v = view(editor);
        const positions = coveredBlockPositions(v.state.doc, wholeDoc(v));
        const range = { from: positions[0]!, to: positions[2]! };
        expect(convertRange(v, range, "bulletList", getEditor)).toBe(true);
        // The auto-join pulled the run's new list into `- x`; the single
        // replay transaction has to carry that neighbour rather than
        // duplicating it beside the result.
        expect(markdown(editor)).toBe("- one\n- two\n- x");
        expect(undo(v.state, v.dispatch)).toBe(true);
        expect(markdown(editor)).toBe("one\n\ntwo\n\n- x");
    });

    it("a partial cover should convert only the covered blocks", async () => {
        const editor = await makeEditor(["keep", "", "one", "", "two", "", "keep"].join("\n"));
        const v = view(editor);
        const second = coveredBlockPositions(v.state.doc, wholeDoc(v))[1]!;
        const fourth = coveredBlockPositions(v.state.doc, wholeDoc(v))[3]!;
        const range = { from: second, to: fourth };
        expect(coveredBlockPositions(v.state.doc, range)).toHaveLength(2);
        expect(convertRange(v, range, "blockquote", getEditor)).toBe(true);
        expect(markdown(editor)).toBe("keep\n\n> one\n>\n> two\n\nkeep");
    });
});

describe("the block menu over a covered run", () => {
    function menuRows(): { label: string; hint: string | null; active: boolean }[] {
        return Array.from(document.querySelectorAll<HTMLElement>(".block-menu-item")).map((row) => ({
            label: row.querySelector(".block-menu-item-label")?.textContent ?? "",
            hint: row.querySelector(".block-menu-item-hint")?.textContent ?? null,
            active: row.getAttribute("aria-checked") === "true" || row.classList.contains("block-menu-item--active"),
        }));
    }

    it("Cmd+. over three covered paragraphs should offer the run and convert every block from one row", async () => {
        const editor = await makeEditor(["one", "", "two", "", "three"].join("\n"));
        const v = view(editor);
        selectAll(v);
        expect(openBlockMenuAtCaret(v)).toBe(true);
        const header = document.querySelector<HTMLElement>(".block-menu-header");
        expect(header?.textContent).toBe("Turn 3 blocks into");
        const row = Array.from(document.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Bullet List");
        expect(row, "Bullet List row").toBeDefined();
        row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(markdown(editor)).toBe("- one\n- two\n- three");
        expect(v.state.selection).toBeInstanceOf(BlockRangeSelection);
    });

    it("a mixed run should mark no row current and merge the loss notes of every source kind", async () => {
        const editor = await makeEditor(["- [ ] task", "", "> [!NOTE] Heads up", "> body"].join("\n"));
        const v = view(editor);
        selectAll(v);
        expect(openBlockMenuAtCaret(v)).toBe(true);
        const rows = menuRows();
        expect(rows.some((row) => row.active)).toBe(false);
        const paragraph = rows.find((row) => row.label === "Paragraph");
        expect(paragraph).toBeDefined();
        // Both source kinds degrade into prose, and the note says so for each.
        expect(paragraph!.hint).toContain(LOSS_NOTES["task:state"]);
        expect(paragraph!.hint).toContain(LOSS_NOTES["callout:marker"]);
    });

    it("clicking a covered block's gutter marker should open the run's menu, not the block's", async () => {
        const editor = await makeEditor(["one", "", "two", "", "three"].join("\n"));
        const v = view(editor);
        selectAll(v);
        const marker = document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker")[1]!;
        marker.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        marker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(document.querySelector<HTMLElement>(".block-menu-header")?.textContent).toBe("Turn 3 blocks into");
        const row = Array.from(document.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Blockquote");
        row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(markdown(editor)).toBe("> one\n>\n> two\n>\n> three");
    });

    it("a caret with no cover should keep the single-block menu", async () => {
        const editor = await makeEditor(["one", "", "two"].join("\n"));
        const v = view(editor);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
        expect(openBlockMenuAtCaret(v)).toBe(true);
        expect(document.querySelector<HTMLElement>(".block-menu-header")?.textContent).toBe("Turn into");
        expect(menuRows().find((row) => row.label === "Paragraph")?.active).toBe(true);
    });
});
