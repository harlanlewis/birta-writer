/**
 * A marker change is a list boundary, and it means the same thing wherever it
 * comes from (MAR-333). `- a` followed by `* b` is two lists to CommonMark, so
 * a `*` the user TYPES under a `-` list starts a second list, spelled `*`,
 * exactly as the same two lines parse from a file — and the editor's own
 * auto-join, which merges adjacency an edit created, stops at a boundary the
 * two lists spell differently.
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
import { TextSelection } from "../pm";
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

    it("a list with no recorded marker should read as none", async () => {
        const editor = await makeEditor("hello\n\nworld\n");
        const v = view(editor);
        caretAtStartOf(v, "world");
        typeText(v, "* ");
        expect(listMarkerOf(v.state.doc.child(1))).toBe("*");
        expect(listMarkerOf(null)).toBeNull();
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

    it("deleting the separator between two same-spelled lists should still merge", async () => {
        const editor = await makeEditor("- alpha\n\nsep\n\n- beta\n");
        const v = view(editor);
        deleteParagraph(v, "sep");
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
