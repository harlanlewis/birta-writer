/**
 * preset-gfm's `keepTableAlignPlugin`: a table's body cells mirror their
 * column's HEADER cell `alignment`, so the serializer writes one consistent
 * `:---` marker per column.
 *
 * These used to test OUR replacement for it, which walked only the changed
 * range instead of the whole document and allocated its transaction only when
 * it had an edit to make — 16.1 ms of a 23.7 ms keystroke on the 300 KB
 * fixture, which contains no tables at all (MAR-137). That fix went upstream
 * and shipped in Milkdown 7.22.0 (#2436), so the subject here is now the
 * dependency and the replacement is gone.
 *
 * Every assertion below survived the handover unchanged, because none of them
 * was ever about which copy was running: the two things the range-bounded walk
 * must not lose (a body cell still inherits its column header's alignment; the
 * fast path never skips a change that needed reconciling), and the property it
 * adds (no transaction is appended when nothing needs marking). Keeping them
 * pointed at upstream is what makes a future bump that regresses any of it go
 * red here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm, keepTableAlignPlugin } from "@milkdown/preset-gfm";
import type { EditorView, Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";

const TABLE = "| aa | bb |\n|---|---|\n| cc | dd |\n";

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView =>
    editor.action((ctx) => ctx.get(editorViewCtx));

/** Position of the first node of `typeName`, or -1. */
function posOf(v: EditorView, typeName: string, nth = 0): number {
    let seen = 0;
    let pos = -1;
    v.state.doc.descendants((n: ProseNode, p: number) => {
        if (n.type.name === typeName && seen++ === nth && pos < 0) { pos = p; }
        return true;
    });
    return pos;
}

/** Every `alignment` attr in column `col`, header row first. */
function columnAlignments(v: EditorView, col: number): (string | null)[] {
    const out: (string | null)[] = [];
    v.state.doc.descendants((n: ProseNode) => {
        if (/^table.*row$/.test(n.type.name)) {
            out.push((n.child(col).attrs["alignment"] as string | null) ?? null);
        }
        return true;
    });
    return out;
}

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("keepTableAlign", () => {
    it("a header cell alignment change should propagate to the column's body cells", async () => {
        // The plugin's whole reason to exist. Marking ONLY the header leaves the
        // body cell out of sync; the appended transaction is what re-syncs it.
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const headerPos = posOf(v, "table_header");
        expect(headerPos).toBeGreaterThanOrEqual(0);
        const header = v.state.doc.nodeAt(headerPos)!;
        v.dispatch(
            v.state.tr.setNodeMarkup(headerPos, undefined, { ...header.attrs, alignment: "center" }),
        );
        expect(columnAlignments(view(editor), 0)).toEqual(["center", "center"]);
    });

    it("a header change should propagate down its OWN column, not the first one", async () => {
        // Guards the column index. Every single-column-relevant fixture passes
        // with a hardcoded `maybeChild(0)`, so the mismatch has to be in a
        // column that is not column 0 for a wrong index to be observable.
        const editor = await makeEditor("| aa | bb | cc |\n|---|---|---|\n| dd | ee | ff |\n");
        const v = view(editor);
        const headerPos = posOf(v, "table_header", 1);
        const header = v.state.doc.nodeAt(headerPos)!;
        expect(header.type.name).toBe("table_header");
        v.dispatch(
            v.state.tr.setNodeMarkup(headerPos, undefined, { ...header.attrs, alignment: "right" }),
        );
        const after = view(editor);
        expect(columnAlignments(after, 1)).toEqual(["right", "right"]);
        expect(columnAlignments(after, 0)).toEqual([null, null]);
        expect(columnAlignments(after, 2)).toEqual([null, null]);
    });

    it("a structural change over an already-consistent table should append no transaction", async () => {
        // Reaches the WALK (a structural edit is not localizable, so the fast
        // path does not fire) and finds nothing to re-mark. Upstream allocated
        // `tr` on the first node visited, so this appended an empty transaction
        // and cost a second applyInner — the typing-path test above cannot see
        // that defect, because it never gets past the fast path.
        const editor = await makeEditor("| aa | bb |\n|:---:|---:|\n| cc | dd |\n\npara\n");
        const v = view(editor);
        const tr = v.state.tr.replaceWith(
            v.state.doc.content.size,
            v.state.doc.content.size,
            v.state.schema.nodes["paragraph"]!.create(),
        );
        expect(tr.docChanged).toBe(true);
        expect(v.state.applyTransaction(tr).transactions).toHaveLength(1);
    });

    it("a doc-changing transaction that needs no re-marking should append no transaction", async () => {
        // The second upstream defect: `tr` was allocated on the first node
        // VISITED, so a transaction was always returned and ProseMirror ran a
        // whole extra applyInner (every plugin's state field, again) for every
        // keystroke. Counting the resulting transactions is the honest
        // observable — asserting the alignment attrs would pass either way.
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const cellPos = posOf(v, "table_cell");
        const tr = v.state.tr.insertText("x", cellPos + 2);
        expect(v.state.applyTransaction(tr).transactions).toHaveLength(1);
    });

    it("a transaction that both types text and re-aligns a header should still propagate", async () => {
        // The fast path's SCOPE, which is the part that can silently lose the
        // behavior: "some text changed" must not be read as "this is typing".
        // One transaction carrying both an insertText and a setNodeMarkup is
        // not localizable to one textblock's inline content, so the walk must
        // still run. A fast path keyed on the text change alone skips this and
        // leaves the body cell stranded — with nothing else red.
        const editor = await makeEditor(TABLE);
        const v = view(editor);
        const headerPos = posOf(v, "table_header");
        const header = v.state.doc.nodeAt(headerPos)!;
        const bodyPos = posOf(v, "table_cell");
        v.dispatch(
            v.state.tr
                .insertText("zz", bodyPos + 2)
                .setNodeMarkup(headerPos, undefined, { ...header.attrs, alignment: "right" }),
        );
        expect(columnAlignments(view(editor), 0)).toEqual(["right", "right"]);
    });

    it("a freshly parsed table should already be internally consistent", async () => {
        // The fast path's load-bearing PREMISE, and the one real behavioral
        // difference from upstream: upstream re-walked on every transaction, so
        // a table that arrived inconsistent from the parser was repaired by the
        // user's first keystroke. This skips that keystroke — which is only
        // safe because the parser sets header and body cells from the same
        // mdast `align`, so there is never anything to repair. If that ever
        // stops holding, this goes red instead of the bug shipping silently.
        for (const [md, expected] of [
            ["| aa | bb |\n|:---|---:|\n| cc | dd |\n", ["left", "right"]],
            ["| aa | bb |\n|:---:|---|\n| cc | dd |\n", ["center", null]],
        ] as const) {
            const editor = await makeEditor(md);
            const v = view(editor);
            for (let col = 0; col < expected.length; col++) {
                // Spelled out, not derived from `column` itself: comparing a
                // list to a re-map of that same list passes vacuously when the
                // walk finds no rows at all.
                expect(columnAlignments(v, col), `column ${col} of ${JSON.stringify(md)}`)
                    .toEqual([expected[col] ?? null, expected[col] ?? null]);
            }
        }
    });

    it("the composed preset should carry exactly one keep-table-align plugin", async () => {
        // While we shipped a replacement, this guarded the identity FILTER that
        // dropped upstream's copy: a filter that silently stopped matching (a
        // rename, a shape change) would have left both running, paying the
        // O(doc) walk again with nothing red.
        //
        // The filter is gone, but the count is still worth pinning from the
        // other side: `gfmFidelity` must not drop the plugin, and nothing must
        // reintroduce a second one. Every behavioral assertion above depends on
        // exactly one being registered.
        expect(gfm).toContain(keepTableAlignPlugin);
        expect(gfmFidelity).toContain(keepTableAlignPlugin);
        const editor = await makeEditor(TABLE);
        const keys = view(editor).state.plugins
            .map((p) => String((p as { key?: string }).key ?? ""))
            .filter((k) => /keepTableAlign|KEEP_TABLE_ALIGN/i.test(k));
        expect(keys).toHaveLength(1);
    });
});
