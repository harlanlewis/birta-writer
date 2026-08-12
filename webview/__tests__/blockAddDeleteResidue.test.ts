/**
 * Adding a block and deleting it again is a no-op edit, for EVERY block type
 * the schema has — not just the paragraph MAR-360 was reported against.
 *
 * The gate enumerates the live schema rather than a hand-picked list, because
 * the question "was this paragraph-specific?" cannot be answered by a sample.
 * For each type it drives the three states a real deletion passes through, and
 * merges each one into the file the way a save would:
 *
 *   added    the block exists with content
 *   emptied  its text is gone, the NODE still exists  ← the poisoning state
 *   deleted  the node is gone
 *
 * Measured against pre-fix `main`, the only dirty rows were `paragraph` and
 * the two cell types, which degenerate into a bare paragraph when inserted at
 * top level — every other type already came back clean. That is the finding
 * this file exists to keep true, and it explains WHY the damage was
 * paragraph-shaped: every other type's emptied spelling leaves a VISIBLE
 * marker (`#`, `>`, `- `, ```` ``` ````, `:::`, `[^]:`, a table pipe row),
 * which the minimal-diff merge sees change and takes back out on the next
 * save. A paragraph's emptied spelling is blank lines, and blank lines are
 * deliberately invisible to that merge — user blank-line spacing is preserved
 * (MAR-313, MAR-290) — so those bytes were the only ones that could not be
 * removed once written.
 *
 * The transient residue is therefore normal and self-healing; permanence was
 * the bug. This gate asserts the end state, which is the property a user has.
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { makeCorpusEditor as makeEditor } from "./helpers/moveFuzz";

const BASE = "# Title\n\nAnchor paragraph.\n";

/** Empty every textblock in [from, to), latest first so positions hold. */
function emptyTextblocksIn(v: EditorView, from: number, to: number): void {
    const ranges: Array<[number, number]> = [];
    v.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock && node.content.size > 0) ranges.push([pos + 1, pos + 1 + node.content.size]);
        return true;
    });
    for (const [a, b] of ranges.reverse()) {
        if (b <= v.state.doc.content.size) v.dispatch(v.state.tr.delete(a, b));
    }
}

describe("add a block, delete it again — the file comes back (MAR-360)", () => {
    it("every top-level block type should leave the file byte-identical", async () => {
        const probe = await makeEditor(BASE);
        const names = Object.keys((probe.action((ctx) => ctx.get(editorViewCtx)) as EditorView).state.schema.nodes)
            .filter((name) => {
                const t = (probe.action((ctx) => ctx.get(editorViewCtx)) as EditorView).state.schema.nodes[name];
                return name !== "doc" && name !== "text" && t.isBlock;
            });

        const dirty: string[] = [];
        const covered: string[] = [];
        const unplaceable: string[] = [];

        for (const name of names) {
            const editor = await makeEditor(BASE);
            const v = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;
            const protection = computeRoundTripProtection(BASE, editor.action(getMarkdown()));

            // Each makeEditor builds its OWN Schema, so the node must come from
            // THIS editor's schema. A node built elsewhere fails to place and
            // tr.insert silently no-ops — which reads as a green sweep that
            // enumerated nothing, and did exactly that before this was fixed.
            const schema = v.state.schema;
            const type = schema.nodes[name];

            let node;
            try {
                if (name === "table") {
                    // createAndFill cannot produce a placeable table (it needs a
                    // header row plus a body row), and leaving the type out
                    // would be a hole in the census rather than a skip.
                    const cell = (t: string, header: boolean) =>
                        schema.nodes[header ? "table_header" : "table_cell"]
                            .createChecked(null, schema.nodes.paragraph.createChecked(null, schema.text(t)));
                    node = schema.nodes.table.createChecked(null, [
                        schema.nodes.table_header_row.createChecked(null, [cell("A", true), cell("B", true)]),
                        schema.nodes.table_row.createChecked(null, [cell("1", false), cell("2", false)]),
                    ]);
                } else {
                    node = type.createAndFill(
                        null,
                        type.spec.content?.includes("inline") ? schema.text("temp") : undefined,
                    );
                }
            } catch {
                node = null;
            }
            if (!node) { unplaceable.push(`${name} (cannot construct)`); continue; }

            const at = v.state.doc.content.size;
            try {
                const tr = v.state.tr.insert(at, node);
                tr.doc.check();
                v.dispatch(tr);
            } catch {
                unplaceable.push(`${name} (invalid at top level)`);
                continue;
            }
            if (v.state.doc.content.size === at) { unplaceable.push(`${name} (does not place)`); continue; }

            // Give any empty nested textblock text, so "emptied" means something.
            const addedPos = v.state.doc.content.size - v.state.doc.child(v.state.doc.childCount - 1).nodeSize;
            const holes: number[] = [];
            v.state.doc.nodesBetween(addedPos, v.state.doc.content.size, (n, pos) => {
                if (n.isTextblock && n.content.size === 0) holes.push(pos + 1);
                return true;
            });
            for (const pos of holes.reverse()) {
                try { v.dispatch(v.state.tr.insertText("temp", pos)); } catch { /* leave it empty */ }
            }

            const added = applyMinimalChanges(BASE, editor.action(getMarkdown()), protection);

            const curPos = v.state.doc.content.size - v.state.doc.child(v.state.doc.childCount - 1).nodeSize;
            emptyTextblocksIn(v, curPos, v.state.doc.content.size);
            const emptied = applyMinimalChanges(added, editor.action(getMarkdown()), protection);

            const last = v.state.doc.child(v.state.doc.childCount - 1);
            const lastPos = v.state.doc.content.size - last.nodeSize;
            v.dispatch(v.state.tr.delete(lastPos, lastPos + last.nodeSize));
            const final = applyMinimalChanges(emptied, editor.action(getMarkdown()), protection);

            covered.push(name);
            if (final !== BASE) dirty.push(`${name}: ${JSON.stringify(final)}`);
        }

        // A census is evidence only about what it enumerated, so say what it
        // did not reach rather than letting a green run imply everything.
        // table_header_row / table_row do not place at top level, and their
        // cells are covered through `table` itself.
        expect(covered.length).toBeGreaterThanOrEqual(16);
        expect(unplaceable).toEqual(["table_header_row (does not place)", "table_row (does not place)"]);
        expect(dirty).toEqual([]);
    });
});
