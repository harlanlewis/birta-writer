import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import type { Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { contentGuardPlugin, fingerprintDoc, diffFingerprints, formatFingerprintDiff } from "../plugins/contentGuard";
import { moveRangeAt, setBlockMenuContext } from "../components/blockMenu";
import { moveBlocks } from "../editing/moveBlocks";
import { blockBoundaryPositions } from "../components/blockMenu";
import { reparseRefusal } from "../plugins/reparseHazard";

vi.mock("../editing/rangeIndicator", () => ({ flashRange: vi.fn(), showRangeVeil: vi.fn(), hideRangeVeil: vi.fn() }));

let editors: Editor[] = [];
let active: Editor | null = null;
setBlockMenuContext({ getEditor: () => active });
afterEach(async () => { for (const e of editors) await e.destroy(); editors = []; active = null; document.body.innerHTML = ""; });
async function make(md: string): Promise<Editor> {
    const root = document.createElement("div"); document.body.appendChild(root);
    const e = await Editor.make().config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, md); configureSerialization(ctx); })
        .use(pureCommonmark).use(gfmFidelity).use(headingFoldPlugin).use(historyPlugin).use(contentGuardPlugin).create();
    editors.push(e); active = e; return e;
}
function view(e: Editor): EditorView { return e.action((c) => c.get(editorViewCtx)); }
function reparseDiff(e: Editor, v: EditorView): string {
    const s = e.action(getMarkdown());
    const r = e.action((c) => c.get(parserCtx)(s)) as ProseNode | null;
    if (!r) return "reparse nothing";
    const d = formatFingerprintDiff(diffFingerprints(fingerprintDoc(v.state.doc), fingerprintDoc(r)));
    return d === "lost: (none); gained: (none)" ? "" : d;
}

/**
 * MAR-88 ships the gutter grabber for a container/leaf block nested inside a
 * list item (blockquote/code/callout/table/heading), making its block menu and
 * drag handle reachable. The block's drag offers only the existing (safe) drop
 * slots — no NEW item-internal block slots (those exposed unfixed serializer
 * round-trip hazards and are deferred; see moveProperty.test.ts). This guard
 * pins that dragging such a block OUT of its item to top level round-trips.
 */
describe("MAR-88 marker drag-out safety", () => {
    const cases: [string, string][] = [
        ["blockquote", "- item one\n\n  > quoted inside item\n\n- item two"],
        ["code block", "- item one\n\n  ```js\n  code()\n  ```\n\n- item two"],
        ["callout", "- item one\n\n  > [!WARNING]\n  > callout inside item\n\n- item two"],
    ];
    for (const [name, md] of cases) {
        it(`dragging a ${name} out of a list item to top level round-trips`, async () => {
            const e = await make(md);
            const v = view(e);
            expect(reparseDiff(e, v)).toBe(""); // precondition
            // Find the nested block: the second child of the first list item.
            let blockPos = -1;
            v.state.doc.descendants((node, pos) => {
                if (blockPos >= 0) return false;
                if (node.type.name === "list_item") {
                    let seen = 0;
                    node.forEach((child, off) => {
                        if (seen >= 0 && off > 0 && blockPos < 0 && child.type.name !== "paragraph") {
                            blockPos = pos + 1 + off;
                        }
                        seen++;
                    });
                }
                return true;
            });
            expect(blockPos).toBeGreaterThan(0);
            const range = moveRangeAt(v, blockPos);
            expect(range).not.toBeNull();
            // Move it to the doc-start block slot (top level).
            const target = blockBoundaryPositions(v.state.doc).find((b) => b.kind === "block")!.pos;
            const ok = moveBlocks(v, { from: range!.from, to: range!.to }, target);
            expect(ok, "move should succeed").toBe(true);
            expect(reparseDiff(e, v), "drag-out must round-trip").toBe("");
        });
    }
});

/**
 * Discovered under MAR-88: `- > quote` parses as [artifact empty paragraph,
 * blockquote] (`list_item` is `paragraph block*`). Dragging the sole real
 * block out via its PR #56 grabber left the husk — an item holding only the
 * artifact — which serializes as a bare `-` marker line, and a bare marker
 * under a paragraph line re-lexes as a SETEXT UNDERLINE on reopen: the
 * paragraph became a heading and the list was destroyed. Two defenses now
 * hold the class: moveBlocks dissolves the artifact husk with the move
 * (the good gesture keeps working), and the save-survival check's
 * structural gate treats any bare-marker item as hazard machinery so
 * residual paths to the shape are judged by the round-trip oracle.
 */
describe("MAR-88 discovered: vacated-item bare marker", () => {
    it("dragging an artifact-lead item's sole block out should dissolve the husk and round-trip", async () => {
        const e = await make("- lead item text\n  - > quoted inside a nested bullet\n- item two");
        const v = view(e);
        expect(reparseDiff(e, v)).toBe(""); // precondition
        let quotePos = -1;
        v.state.doc.descendants((node, pos) => {
            if (quotePos < 0 && node.type.name === "blockquote") quotePos = pos;
            return quotePos < 0;
        });
        expect(quotePos).toBeGreaterThan(0);
        const range = moveRangeAt(v, quotePos)!;
        expect(range).not.toBeNull();
        const ok = moveBlocks(v, { from: range.from, to: range.to }, 0);
        expect(ok, "the drag-out gesture must keep working").toBe(true);
        // The husk dissolved: no bare `-` marker line in the serialization,
        // and the whole document survives a save+reopen.
        const serialized = e.action(getMarkdown());
        expect(serialized, "no bare marker line may remain").not.toMatch(/^\s*-\s*$/m);
        expect(reparseDiff(e, v), "the result must round-trip").toBe("");
    });

    it("an item with a real lead paragraph should keep it (no over-dissolution)", async () => {
        const e = await make("- lead item text\n\n  > quoted continuation\n- item two");
        const v = view(e);
        let quotePos = -1;
        v.state.doc.descendants((node, pos) => {
            if (quotePos < 0 && node.type.name === "blockquote") quotePos = pos;
            return quotePos < 0;
        });
        const range = moveRangeAt(v, quotePos)!;
        const ok = moveBlocks(v, { from: range.from, to: range.to }, 0);
        expect(ok).toBe(true);
        // The vacated item keeps its real paragraph.
        expect(e.action(getMarkdown())).toContain("- lead item text");
        expect(reparseDiff(e, v)).toBe("");
    });

    it("the save-survival check should judge bare-marker husk shapes by position (backstop)", async () => {
        const e = await make("- lead item text\n  - placeholder\n- item two");
        const v = view(e);
        const schema = v.state.doc.type.schema;
        const p = (text?: string): ProseNode =>
            schema.nodes["paragraph"]!.createChecked(null, text ? schema.text(text) : null);
        const li = (...children: ProseNode[]): ProseNode =>
            schema.nodes["list_item"]!.createChecked(null, children);
        const ul = (...items: ProseNode[]): ProseNode =>
            schema.nodes["bullet_list"]!.createChecked(null, items);
        const docOf = (...blocks: ProseNode[]): ProseNode =>
            schema.nodes["doc"]!.createChecked(null, blocks);
        const pre = v.state.doc;
        // Hazardous: a husk nested under a text-bearing item serializes to a
        // bare `-` directly under "lead item text" — a setext underline on
        // reopen. The oracle must refuse a gesture producing this.
        const hazardous = docOf(ul(li(p("lead item text"), ul(li(p()))), li(p("item two"))));
        expect(String(reparseRefusal(pre, hazardous))).toMatch(/would not survive/);
        // Harmless: a leading empty item round-trips fine; same machinery,
        // no damage, so the oracle allows it — the gate is positional, not
        // a shape ban.
        const harmless = docOf(ul(li(p()), li(p("item two"))));
        expect(reparseRefusal(pre, harmless)).toBeNull();
    });
});
