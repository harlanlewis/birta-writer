/**
 * A marker change is a list boundary, and it means the same thing wherever it
 * comes from (MAR-333). `- a` followed by `* b` is two lists to CommonMark, so
 * a `*` the user TYPES under a `-` list starts a second list, spelled `*`,
 * exactly as the same two lines parse from a file — and the editor's own
 * auto-join, which merges adjacency an edit created, stops at a boundary the
 * two lists spell differently.
 *
 * WHEREVER INCLUDES THE HEAD OF AN ITEM IN A LIST OF THAT VERY KIND (MAR-337),
 * the one position where the same characters used to become an escaped
 * literal. The gesture there splits the item out as its own list, and the two
 * halves of that fact are tested the same way as the line-under-a-list half:
 * against the file holding those characters.
 *
 * The invariant these tests hold, and the reason it is worth holding, is that
 * the typed document and the authored document are the SAME bytes: every case
 * below asserts the two against each other rather than against a string this
 * file picked, so a change to how either path spells a list fails here rather
 * than drifting apart quietly.
 *
 * The asymmetry is deliberate and is asserted at the bottom: auto-join stops,
 * while the block menu's Merge rows and the caret advisory keep OFFERING the
 * cross-marker merge, because merging two differently-spelled lists on purpose
 * is a real thing to want. Silence is what the marker forbids, not the merge.
 *
 * Runs against the REAL Milkdown editor with the list plugins wired as
 * webview/editor.ts wires them, so the input rules, listAutoJoin and the
 * spread normalizer all get their say (the listMarkerInput.test.ts setup).
 *
 * The sibling file listMarkerFidelity.test.ts owns the other half of the same
 * fact: that a marker read out of a FILE survives a round trip. This one owns
 * where a marker becomes a boundary.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView, Node as ProseNode } from "../pm";
import { parseFromClipboard, TextSelection } from "../pm";
import { pasteMarkdownPlugin } from "../plugins/pasteMarkdown";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    listAutoJoinPlugin,
    listEnterPlugin,
    listLiftPlugin,
    listSpreadNormalizePlugin,
} from "../plugins";
import {
    caretMergeBoundary,
    listMarkerOf,
    listMarkersConflict,
    mergeableListBoundary,
    mergeListsAt,
} from "../editing/listMerge";
import { convertListTreeAt } from "../editing/listConvert";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const created = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(listAutoJoinPlugin)
        .use(listSpreadNormalizePlugin)
        .create();
    editors.push(created);
    return created;
}

/** The same editor with the paste path wired, for the clipboard cases. */
async function makePastingEditor(markdownSource: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const created = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdownSource);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(listLiftPlugin)
        .use(listEnterPlugin)
        .use(listAutoJoinPlugin)
        .use(listSpreadNormalizePlugin)
        .use(pasteMarkdownPlugin)
        .create();
    editors.push(created);
    return created;
}

/** Selects the whole text of the first top-level paragraph reading `text`. */
function selectParagraph(v: EditorView, text: string): void {
    let from = -1;
    v.state.doc.forEach((child: ProseNode, offset: number) => {
        if (from === -1 && child.type.name === "paragraph" && child.textContent === text) {
            from = offset + 1;
        }
    });
    expect(from).toBeGreaterThan(0);
    v.dispatch(
        v.state.tr.setSelection(TextSelection.create(v.state.doc, from, from + text.length)),
    );
}

/** Paste `text` as a text-only clipboard, the way ProseMirror does. */
function pasteText(v: EditorView, text: string): void {
    const slice = parseFromClipboard(v, text, null, false, v.state.selection.$from);
    expect(slice, "the clipboard produced no slice").not.toBeNull();
    v.dispatch(v.state.tr.replaceSelection(slice!));
}

afterEach(async () => {
    for (const editor of editors) await editor.destroy();
    editors = [];
    document.body.innerHTML = "";
});

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown());
}

/** Type text one character at a time, running input rules like a real user. */
function typeText(v: EditorView, text: string): void {
    for (const ch of text) {
        const { from, to } = v.state.selection;
        const handled = v.someProp("handleTextInput", (f) => f(v, from, to, ch));
        if (!handled) v.dispatch(v.state.tr.insertText(ch, from, to));
    }
}

/** Backspace through the editor's own keymap; true when a handler took it. */
function pressBackspace(v: EditorView): boolean {
    const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true });
    return v.someProp("handleKeyDown", (f) => f(v, event)) ?? false;
}

/** Caret at the start of the first textblock whose text contains `needle`. */
function caretAtStartOf(v: EditorView, needle: string): void {
    let found = -1;
    v.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.isTextblock && node.textContent.includes(needle)) {
            found = pos + 1;
            return false;
        }
        return true;
    });
    if (found < 0) throw new Error(`no textblock containing ${JSON.stringify(needle)}`);
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, found)));
}

/** Type `typed` at the head of the line holding `needle`; return the markdown. */
async function typeAtHeadOf(source: string, needle: string, typed: string): Promise<string> {
    const editor = await makeEditor(source);
    const v = view(editor);
    caretAtStartOf(v, needle);
    typeText(v, typed);
    v.state.doc.check();
    return markdown(editor);
}

/** Serialize → reparse → serialize. Equal means the bytes survive a reopen. */
async function roundTrips(md: string): Promise<boolean> {
    const reopened = await makeEditor(md);
    return markdown(reopened) === md;
}

/** Deletes the first top-level paragraph whose text is `text`, whole-node. */
function deleteParagraph(v: EditorView, text: string): void {
    let from = -1;
    let to = -1;
    v.state.doc.forEach((child: ProseNode, offset: number) => {
        if (from === -1 && child.type.name === "paragraph" && child.textContent === text) {
            from = offset;
            to = offset + child.nodeSize;
        }
    });
    expect(from).toBeGreaterThanOrEqual(0);
    v.dispatch(v.state.tr.delete(from, to));
}

/** Top-level node type names, e.g. ["bullet_list", "bullet_list"]. */
function topLevelTypes(v: EditorView): string[] {
    const types: string[] = [];
    v.state.doc.forEach((child: ProseNode) => types.push(child.type.name));
    return types;
}

/**
 * How many lists this markdown holds and how each one is spelled, read by
 * PARSING it — `["bullet_list:-", "bullet_list:*"]`.
 *
 * The comparison the matrix below needs, and nothing more. Comparing the two
 * documents byte for byte would fail on their BLANK LINES rather than their
 * markers: `- a` and a blank line and `- b` is one LOOSE list, and the editor
 * keeps that looseness, while the same pair typed comes out tight. Spread is a
 * separate authored property with its own rules, so reading the parse answers
 * the question this file asks without being satisfied by that one.
 */
async function listSignature(md: string): Promise<string[]> {
    const editor = await makeEditor(md);
    const signature: string[] = [];
    view(editor).state.doc.descendants((node: ProseNode) => {
        if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
            signature.push(`${node.type.name}:${String(node.attrs["marker"])}`);
        }
        return true;
    });
    return signature;
}

/**
 * Every textblock's text, in document order, read by PARSING `md`. The other
 * half of what `listSignature` cannot see: a marker that stayed as text is a
 * line whose CONTENT changed, and nothing about the list structure says so.
 */
async function textLines(md: string): Promise<string[]> {
    const editor = await makeEditor(md);
    const lines: string[] = [];
    view(editor).state.doc.descendants((node: ProseNode) => {
        if (!node.isTextblock) {
            return true;
        }
        lines.push(node.textContent);
        return false;
    });
    return lines;
}

describe("listMarkersConflict", () => {
    it("two different recorded markers should conflict", () => {
        expect(listMarkersConflict("-", "*")).toBe(true);
        expect(listMarkersConflict("*", "+")).toBe(true);
        expect(listMarkersConflict(".", ")")).toBe(true);
    });

    it("two equal recorded markers should not conflict", () => {
        expect(listMarkersConflict("-", "-")).toBe(false);
        expect(listMarkersConflict(".", ".")).toBe(false);
    });

    it("a list with no recorded marker should conflict with nothing", () => {
        // No marker is no opinion, so a list the editor created still folds
        // into whatever it lands beside — which is what keeps every existing
        // auto-join case merging.
        expect(listMarkersConflict(null, "*")).toBe(false);
        expect(listMarkersConflict("*", null)).toBe(false);
        expect(listMarkersConflict(undefined, undefined)).toBe(false);
    });
});

// The three bullet characters against the three a list above can be spelled
// with. The verdict is the same one CommonMark gives, so it is derived rather
// than tabulated: same character continues the list, different starts one.
const BULLETS = ["-", "*", "+"] as const;

describe("a typed bullet character means what the same character means in a file", () => {
    for (const above of BULLETS) {
        for (const typed of BULLETS) {
            it(`\`${typed} \` typed under a \`${above}\` list should spell what the file spells`, async () => {
                const typedDoc = await typeAtHeadOf(`${above} alpha\n\nworld\n`, "world", `${typed} `);
                // Against the AUTHORED document holding the same two lines.
                // When the characters match, markdown itself merges the pair at
                // parse time, so this holds for the join case and the split
                // case alike without the test knowing which it is looking at.
                expect(await listSignature(typedDoc)).toEqual(
                    await listSignature(`${above} alpha\n\n${typed} world\n`),
                );
                expect(await roundTrips(typedDoc)).toBe(true);
            });
        }
    }

    it("the typed character should survive as its own list, not the neighbor's", async () => {
        // The concrete shape behind the matrix, stated once so a reader does
        // not have to run it: the `*` reaches the file.
        expect(await typeAtHeadOf("- alpha\n\nworld\n", "world", "* ")).toBe(
            "- alpha\n\n* world\n",
        );
    });

    it("a matching character should still continue the list above", async () => {
        expect(await typeAtHeadOf("- alpha\n\nworld\n", "world", "- ")).toBe("- alpha\n- world\n");
    });
});

describe("a typed bullet character at an item head means the same thing too", () => {
    for (const above of BULLETS) {
        for (const typed of BULLETS) {
            it(`\`${typed} \` typed at the head of an item in a \`${above}\` list should spell what the file spells`, async () => {
                const typedDoc = await typeAtHeadOf(
                    `${above} alpha\n${above} beta\n`,
                    "beta",
                    `${typed} `,
                );
                // Derived from CommonMark, not tabulated: a different character
                // is a boundary, so the item leaves the list it was in and the
                // file holds the two lists those bytes make. The same character
                // describes the line the item already had, so there is nothing
                // to do and the marker stays as text — which only the TEXT can
                // show, the list structure being identical either way.
                const splits = above !== typed;
                const authored = splits
                    ? `${above} alpha\n\n${typed} beta\n`
                    : `${above} alpha\n${above} beta\n`;
                expect(await listSignature(typedDoc)).toEqual(await listSignature(authored));
                expect(await textLines(typedDoc)).toEqual(
                    splits ? ["alpha", "beta"] : ["alpha", `${typed} beta`],
                );
                expect(await roundTrips(typedDoc)).toBe(true);
            });
        }
    }

    it("the typed character should carry its item out of the list it was in", async () => {
        // The concrete shape behind the matrix, stated once so a reader does
        // not have to run it: the `*` reaches the file, and takes its item with
        // it into the list it names.
        expect(await typeAtHeadOf("- alpha\n- beta\n", "beta", "* ")).toBe(
            "- alpha\n\n* beta\n",
        );
    });

    it("the head of the FIRST item should split the same way", async () => {
        expect(await typeAtHeadOf("- alpha\n- beta\n", "alpha", "* ")).toBe(
            "* alpha\n\n- beta\n",
        );
    });

    it("an item between two others should leave a list on each side", async () => {
        const typedDoc = await typeAtHeadOf("- alpha\n- beta\n- gamma\n", "beta", "* ");
        expect(typedDoc).toBe("- alpha\n\n* beta\n\n- gamma\n");
        expect(await roundTrips(typedDoc)).toBe(true);
    });

    it("a list of one item should be respelled rather than split", async () => {
        // The same rule with nothing to split off: the item IS the list, so
        // what is left is one list wearing the character that was typed.
        expect(await typeAtHeadOf("- alpha\n", "alpha", "* ")).toBe("* alpha\n");
    });

    it("a nested item should split its own list and leave its parent alone", async () => {
        const typedDoc = await typeAtHeadOf("- alpha\n  - beta\n  - gamma\n", "beta", "* ");
        expect(typedDoc).toBe("- alpha\n  * beta\n  - gamma\n");
        expect(await roundTrips(typedDoc)).toBe(true);
    });

    it("everything else in the item should travel with it", async () => {
        // A second paragraph and a sublist are the item's own content, so the
        // split moves them and changes nothing about them.
        const withParagraph = await typeAtHeadOf(
            "- alpha\n- beta\n\n  second para\n",
            "beta",
            "* ",
        );
        expect(withParagraph).toBe("- alpha\n\n* beta\n\n  second para\n");
        expect(await roundTrips(withParagraph)).toBe(true);

        const withSublist = await typeAtHeadOf(
            "- alpha\n- beta\n  - deep\n- gamma\n",
            "beta",
            "* ",
        );
        expect(withSublist).toBe("- alpha\n\n* beta\n  - deep\n\n- gamma\n");
        expect(await roundTrips(withSublist)).toBe(true);
    });

    it("a list with no recorded spelling should have nothing to disagree with", async () => {
        // A converted list carries no marker, so a typed character contradicts
        // nothing and stays text — the same clause that lets such a list still
        // fold into whatever it lands beside.
        const editor = await makeEditor("1. a\n1. b\n");
        const v = view(editor);
        convertListTreeAt(v, 0, "bulletList");
        expect(v.state.doc.child(0).attrs["marker"]).toBeNull();

        caretAtStartOf(v, "b");
        typeText(v, "* ");
        v.state.doc.check();
        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(markdown(editor)).toBe("- a\n- \\* b\n");
    });

    it("Backspace should give back the characters as text", async () => {
        // The route to literal `* ` text at an item head, which is what a
        // marker consumed there costs: type it, then Backspace. The list
        // keymap chains `undoInputRule` ahead of its own handling for this.
        const editor = await makeEditor("- alpha\n- beta\n");
        const v = view(editor);
        caretAtStartOf(v, "beta");
        typeText(v, "* ");
        expect(markdown(editor)).toBe("- alpha\n\n* beta\n");

        expect(pressBackspace(v)).toBe(true);
        v.state.doc.check();
        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(await textLines(markdown(editor))).toEqual(["alpha", "* beta"]);
    });

    it("the caret advisory should offer the split back", async () => {
        // Two adjacent bullet lists draw alike, so the advisory is what the
        // gesture has to show for itself: the caret lands in the first item of
        // the list it just made, right where the merge would happen.
        const editor = await makeEditor("- alpha\n- beta\n");
        const v = view(editor);
        caretAtStartOf(v, "beta");
        typeText(v, "* ");
        v.state.doc.check();

        const boundary = caretMergeBoundary(v.state);
        expect(boundary).toBe(v.state.doc.child(0).nodeSize);
        expect(mergeListsAt(v, boundary as number)).toBe(true);
        expect(markdown(editor)).toBe("- alpha\n- beta\n");
    });
});

describe("a typed ordered delimiter is source too", () => {
    it("`2) ` under a `1.` list should start a second list rather than lose the `)`", async () => {
        const typedDoc = await typeAtHeadOf("1. alpha\n\nworld\n", "world", "2) ");
        expect(await listSignature(typedDoc)).toEqual(
            await listSignature("1. alpha\n\n2) world\n"),
        );
        expect(typedDoc).toBe("1. alpha\n\n2) world\n");
        expect(await roundTrips(typedDoc)).toBe(true);
    });

    it("`2. ` under a `1.` list should still continue it", async () => {
        expect(await typeAtHeadOf("1. alpha\n\nworld\n", "world", "2. ")).toBe(
            "1. alpha\n2. world\n",
        );
    });

    it("`2) ` at the head of an item in a `1.` list should split it off, `)` intact", async () => {
        const typedDoc = await typeAtHeadOf("1. alpha\n2. beta\n", "beta", "2) ");
        expect(typedDoc).toBe("1. alpha\n\n2) beta\n");
        expect(await roundTrips(typedDoc)).toBe(true);
    });

    it("`2. ` at the head of an item in a `1)` list should split it off too", async () => {
        expect(await typeAtHeadOf("1) alpha\n2) beta\n", "beta", "2. ")).toBe(
            "1) alpha\n\n2. beta\n",
        );
    });

    it("a number alone at an item head should still be left as text", async () => {
        // The delimiter is source; the start number is not, because markdown
        // cannot say one at a boundary. So a marker that changes only the
        // number changes nothing about the file and stays text.
        expect(await typeAtHeadOf("1. alpha\n2. beta\n", "beta", "3. ")).toBe(
            "1. alpha\n2. 3\\. beta\n",
        );
    });

    it("a start number the file cannot say at a boundary should still merge", async () => {
        // `1. a`, a blank line, `5. b` reparses as ONE list numbered 1, 2 —
        // markdown has no way to restart the count there. The presentation /
        // source test (docs/DESIGN_PRINCIPLES.md) puts the number on the other
        // side of the line from the delimiter, so the pair merges.
        expect(await typeAtHeadOf("1. alpha\n\nworld\n", "world", "5. ")).toBe(
            "1. alpha\n2. world\n",
        );
    });
});

describe("listMarkerOf", () => {
    it("a converted list should carry no marker its new type cannot print", async () => {
        // The two types print from disjoint alphabets, so a Turn-into has no
        // marker to carry across the type change and drops it. Asserted on the
        // ATTR rather than through `listMarkerOf`, because the point is that
        // the bad value is never written, not merely never read.
        const editor = await makeEditor("1. a\n\n- b\n");
        const v = view(editor);
        expect(v.state.doc.child(0).attrs["marker"]).toBe(".");

        convertListTreeAt(v, 0, "bulletList");
        expect(v.state.doc.child(0).attrs["marker"]).toBeNull();
    });

    it("a marker its list type cannot print should still read as none at all", async () => {
        // The defence, exercised on a hand-built node so it stays held even
        // though no caller writes such an attr. Nothing in the schema stops one
        // holding a character its own type cannot spell, and the invariant is
        // the schema's: two lists that will print the SAME character must never
        // read as disagreeing.
        const editor = await makeEditor("- a\n\n1. b\n");
        const v = view(editor);
        const bullet = v.state.doc.child(0);
        const ordered = v.state.doc.child(1);

        const bulletWithOrderedMarker = bullet.type.create(
            { ...bullet.attrs, marker: "." },
            bullet.content,
        );
        const orderedWithBulletMarker = ordered.type.create(
            { ...ordered.attrs, marker: "*" },
            ordered.content,
        );
        expect(listMarkerOf(bulletWithOrderedMarker)).toBeNull();
        expect(listMarkerOf(orderedWithBulletMarker)).toBeNull();
        // A marker the type CAN print still reads through.
        expect(listMarkerOf(bullet)).toBe("-");
        expect(listMarkerOf(ordered)).toBe(".");
    });

    it("a typed list should read back the character that made it", async () => {
        const editor = await makeEditor("hello\n\nworld\n");
        const v = view(editor);
        caretAtStartOf(v, "world");
        typeText(v, "* ");
        expect(listMarkerOf(v.state.doc.child(1))).toBe("*");
    });

    it("a list with no recorded marker should read as none", async () => {
        // The clause every pre-existing auto-join case rests on: a list the
        // editor created carries no spelling to defend, so it conflicts with
        // nothing and still folds into whatever it lands beside. Built by hand
        // because `convertListTreeAt` is the only producer today, and this
        // invariant is the schema's rather than that one caller's.
        const editor = await makeEditor("- a\n");
        const v = view(editor);
        const list = v.state.doc.child(0);
        const unspelled = list.type.create({ ...list.attrs, marker: null }, list.content);

        expect(listMarkerOf(unspelled)).toBeNull();
        expect(listMarkersConflict(listMarkerOf(unspelled), "*")).toBe(false);
        expect(listMarkerOf(null)).toBeNull();
        expect(listMarkerOf(undefined)).toBeNull();
    });
});

describe("auto-join stops at a marker change", () => {
    it("a Turn-into beside a same-type list should still merge the pair", async () => {
        // The end-to-end shape both halves protect: both lists print `-`, so
        // leaving them split makes the serializer alternate the second to `*`,
        // the exact durable artifact the auto-join is for. It fails if a
        // conversion writes a marker its new type cannot print, and it fails
        // again if a reader takes such a value at face value.
        const editor = await makeEditor("1. a\n\n- b\n");
        const v = view(editor);
        convertListTreeAt(v, 0, "bulletList");
        v.state.doc.check();

        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(markdown(editor)).toBe("- a\n- b\n");
    });

    it("a Turn-into onto an ordered neighbor should still merge the pair", async () => {
        const editor = await makeEditor("1. a\n\n* b\n");
        const v = view(editor);
        convertListTreeAt(v, v.state.doc.child(0).nodeSize, "orderedList");
        v.state.doc.check();

        expect(topLevelTypes(v)).toEqual(["ordered_list"]);
        expect(markdown(editor)).toBe("1. a\n2. b\n");
    });

    it("deleting the separator between two differently-spelled lists should keep both", async () => {
        const editor = await makeEditor("- alpha\n\nsep\n\n* beta\n");
        const v = view(editor);
        deleteParagraph(v, "sep");
        v.state.doc.check();

        expect(topLevelTypes(v)).toEqual(["bullet_list", "bullet_list"]);
        expect(markdown(editor)).toBe("- alpha\n\n* beta\n");
    });

    it("deleting the separator between two differently-delimited lists should keep both", async () => {
        // The ordered half of the case above. `listMarkersConflict` is asserted
        // over `.` against `)` at the top of this file; this is the only place
        // the auto-join is asked the same question about an ordered pair.
        const editor = await makeEditor("1. alpha\n\nsep\n\n1) beta\n");
        const v = view(editor);
        deleteParagraph(v, "sep");
        v.state.doc.check();

        expect(topLevelTypes(v)).toEqual(["ordered_list", "ordered_list"]);
        expect(markdown(editor)).toBe("1. alpha\n\n1) beta\n");
    });

    it("deleting the separator between two same-spelled lists should still merge", async () => {
        const editor = await makeEditor("- alpha\n\nsep\n\n- beta\n");
        const v = view(editor);
        deleteParagraph(v, "sep");
        v.state.doc.check();

        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(markdown(editor)).toBe("- alpha\n- beta\n");
    });

    // A PASTE is the third way an adjacency is born, and it reaches the same
    // verdict by the same door: the marker test sits in the auto-join's
    // candidate collection, upstream of the probe that asks whether this edit
    // created the adjacency, so it applies to every edit rather than to typing
    // alone. The pasted list carries a real marker because the paste is parsed
    // by the document's own parser, `sourceStyle` included, so the clipboard's
    // bytes are read exactly like a file's.
    //
    // Worth a test of its own rather than reasoning from the typed cases: this
    // is the only path where the marker arrives on a node the user never typed.
    it("pasting a differently-spelled list below one should keep both", async () => {
        const editor = await makePastingEditor("- alpha\n\ntail\n");
        const v = view(editor);
        selectParagraph(v, "tail");
        pasteText(v, "* beta");
        v.state.doc.check();

        expect(topLevelTypes(v)).toEqual(["bullet_list", "bullet_list"]);
        expect(markdown(editor)).toBe("- alpha\n\n* beta\n");
    });

    it("pasting a same-spelled list below one should still merge", async () => {
        const editor = await makePastingEditor("- alpha\n\ntail\n");
        const v = view(editor);
        selectParagraph(v, "tail");
        pasteText(v, "- beta");
        v.state.doc.check();

        expect(topLevelTypes(v)).toEqual(["bullet_list"]);
        expect(markdown(editor)).toBe("- alpha\n- beta\n");
    });
});

describe("the merge is refused silently, never refused outright", () => {
    it("the block menu should still offer a merge across a marker change", async () => {
        const editor = await makeEditor("- alpha\n\nworld\n");
        const v = view(editor);
        caretAtStartOf(v, "world");
        typeText(v, "* ");
        v.state.doc.check();

        // The lower list's own position: the second top-level child.
        const lowerPos = v.state.doc.child(0).nodeSize;
        expect(mergeableListBoundary(v.state.doc, lowerPos, -1)).toBe(lowerPos);
        expect(mergeableListBoundary(v.state.doc, 0, 1)).toBe(lowerPos);
    });

    it("the caret advisory should still fire in the first item of the typed list", async () => {
        const editor = await makeEditor("- alpha\n\nworld\n");
        const v = view(editor);
        caretAtStartOf(v, "world");
        typeText(v, "* ");
        v.state.doc.check();

        expect(caretMergeBoundary(v.state)).toBe(v.state.doc.child(0).nodeSize);
    });

    it("confirming the merge should join the pair and keep the first list's character", async () => {
        const editor = await makeEditor("- alpha\n\nworld\n");
        const v = view(editor);
        caretAtStartOf(v, "world");
        typeText(v, "* ");
        const boundary = caretMergeBoundary(v.state);
        expect(boundary).not.toBeNull();

        expect(mergeListsAt(v, boundary as number)).toBe(true);
        v.state.doc.check();
        expect(markdown(editor)).toBe("- alpha\n- world\n");
    });
});
