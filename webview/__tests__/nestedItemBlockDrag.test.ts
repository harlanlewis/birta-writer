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
import { blockBoundaryPositions } from "../components/blockMenu/drag";

vi.mock("../components/blockMenu/rangeIndicator", () => ({ flashRange: vi.fn(), showRangeVeil: vi.fn(), hideRangeVeil: vi.fn() }));

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
