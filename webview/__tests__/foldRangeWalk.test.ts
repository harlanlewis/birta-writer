/**
 * `findHeadingFoldRange` answers for ONE heading what `computeFoldRanges`
 * answers for every heading at once, and it is asked on every doc change by
 * the sticky title, so it must cost the heading's section and not the
 * document. Two things are held: the two agree for every top-level heading
 * (and the single-heading form keeps its nested-heading answer), and the
 * walk stops at the section's end rather than visiting every block.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/core";
import type { EditorView, Node as ProseNode } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { computeFoldRanges, findHeadingFoldRange } from "../plugins/headingFold/foldModel";

const DOC = `# One

para

## One A

para

### One A i

para

## One B

> quoted
>
> ### Nested in a quote
>
> more

para

# Two

## Two A

## Two B empty tail

# Three (owns nothing)
`;

let editors: Editor[] = [];

async function makeDoc(markdown: string): Promise<ProseNode> {
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
        .create();
    editors.push(editor);
    const view: EditorView = editor.action((ctx) => ctx.get(editorViewCtx));
    return view.state.doc;
}

afterEach(async () => {
    for (const editor of editors) await editor.destroy();
    editors = [];
    document.body.innerHTML = "";
});

describe("findHeadingFoldRange", () => {
    it("should agree with computeFoldRanges for every top-level heading", async () => {
        const doc = await makeDoc(DOC);
        const map = computeFoldRanges(doc);
        let headings = 0;
        doc.forEach((node, pos) => {
            if (node.type.name !== "heading") return;
            headings++;
            expect(findHeadingFoldRange(doc, pos)).toEqual(map.get(pos) ?? null);
        });
        // The fixture has to hold the shapes that make the agreement mean
        // anything: a nested section closed by a shallower heading, a
        // heading closed by one of its own rank, and a last heading that
        // owns nothing.
        expect(headings).toBe(8);
        expect([...map.values()].filter((r) => r === null).length).toBeGreaterThan(0);
    });

    it("a heading nested inside a container should keep the answer the top-level walk gave it", async () => {
        const doc = await makeDoc(DOC);
        let nestedPos = -1;
        let nextTopLevelAtOrAbove = -1;
        doc.descendants((node, pos) => {
            if (node.type.name === "heading" && doc.resolve(pos).depth > 0 && nestedPos < 0) {
                nestedPos = pos;
            }
            return true;
        });
        expect(nestedPos).toBeGreaterThan(0);
        // The old walk visited top-level blocks after the heading's position
        // and stopped at the first heading of its rank (3) or higher: here
        // that is "# Two".
        doc.forEach((node, pos) => {
            if (nextTopLevelAtOrAbove < 0 && pos > nestedPos && node.type.name === "heading" && (node.attrs["level"] as number) <= 3) {
                nextTopLevelAtOrAbove = pos;
            }
        });
        const nested = doc.nodeAt(nestedPos)!;
        expect(findHeadingFoldRange(doc, nestedPos)).toEqual({ from: nestedPos + nested.nodeSize, to: nextTopLevelAtOrAbove });
    });

    it("the walk should stop at the section's end rather than visit every block", async () => {
        const doc = await makeDoc(DOC);
        // "### One A i" is closed by "## One B" two blocks later; a walk that
        // visited every top-level block would read them all.
        let target = -1;
        doc.forEach((node, pos) => {
            if (target < 0 && node.type.name === "heading" && node.textContent === "One A i") target = pos;
        });
        expect(target).toBeGreaterThan(0);
        // Count the top-level blocks the walk reads, whichever way it reads
        // them: `child(i)` (the section walk) or a `forEach` callback (the
        // whole-document walk this replaced). A spy on `child` alone read
        // zero against the old implementation and passed for the wrong
        // reason.
        let visited = 0;
        const counted = new Proxy(doc, {
            get(target, key) {
                if (key === "child") return (i: number) => { visited++; return doc.child(i); };
                if (key === "forEach") return (f: (node: ProseNode, offset: number, index: number) => void) =>
                    doc.forEach((node, offset, index) => { visited++; f(node, offset, index); });
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(doc) : value;
            },
        }) as ProseNode;
        const range = findHeadingFoldRange(counted, target);
        expect(range).not.toBeNull();
        expect(visited).toBeGreaterThan(0);
        expect(visited).toBeLessThan(doc.childCount / 2);
    });
});
