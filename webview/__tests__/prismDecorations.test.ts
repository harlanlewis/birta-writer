/**
 * Syntax-highlight decorations from `@milkdown/plugin-prism`.
 *
 * This file used to be DIFFERENTIAL: it registered upstream's `prismPlugin`
 * beside our fork (`plugins/prismHighlight.ts`) and compared the two decoration
 * sets, because the fork had to re-implement upstream's unexported
 * `getDecorations` and a transcription slip would have shown up only as wrong
 * highlighting. Milkdown 7.22.0 took that fix upstream (#2436), the fork is
 * gone, and there is nothing left to differ from.
 *
 * So the assertions are INVARIANTS instead — properties that hold whatever
 * upstream decides a token looks like, which is the right shape for a test
 * whose subject is now a dependency:
 *
 *   - every decoration lies inside some code block's content, which is what
 *     catches an off-by-one in the incremental re-highlight path (the
 *     `find(from + 1, to - 1)` bound that keeps a re-highlight from eating a
 *     neighbour's decorations);
 *   - a caret move rebuilds nothing, by object identity — the per-keystroke
 *     property MAR-137 bought and #2436 upstreamed, and the one a future bump
 *     could quietly lose;
 *   - a language change re-highlights the block it happened to, INCLUDING a
 *     block that is not the first. Our fork compared only `[0]`'s language and
 *     got this wrong; upstream fixed it as #2440, so it is pinned here rather
 *     than left as a claim in a commit message.
 *
 * Pinning class names or offsets would only re-assert what I believe prism
 * does today, which is exactly what the differential existed to avoid.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { prism, prismConfig } from "@milkdown/plugin-prism";
import type { EditorView, Node as ProseNode } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { refractor } from "../highlighter";
import { registerGrammars } from "../highlighterLanguages";
import { loadCorpusFixtures } from "./helpers/moveFuzz";

registerGrammars(refractor);

const CODE_DOC = [
    "# Heading",
    "",
    "Some prose before the code.",
    "",
    "```js",
    "const x = 1;",
    "function hello(name) { return `hi ${name}`; }",
    "```",
    "",
    "More prose between blocks.",
    "",
    "```python",
    "def add(a, b):",
    "    return a + b  # comment",
    "```",
    "",
    "- a list item",
    "",
    "  ```css",
    "  .cls { color: red; }",
    "  ```",
    "",
    "```not-a-real-language",
    "whatever",
    "```",
    "",
    "Trailing prose.",
    "",
].join("\n");

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            // Production wires the same instance (editor.ts); under Vitest the
            // esbuild `refractor-singleton` rewrite does not apply, so upstream
            // would otherwise resolve the bare `refractor` entry and highlight
            // with a different registration set than `highlighter.ts` builds.
            ctx.set(prismConfig.key, { configureRefractor: () => refractor });
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        // Prism is not part of either preset bundle — production registers it
        // in `editor.ts`, so a test editor has to as well.
        .use(prism)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

type Deco = { from: number; to: number; class: string };
type DecoSet = { find(): { from: number; to: number; type: unknown }[] };

function prismState(v: EditorView): DecoSet {
    const plugin = v.state.plugins.find((p) =>
        String((p as { key?: string }).key ?? "").startsWith("MILKDOWN_PRISM"));
    if (!plugin) { throw new Error("plugin not found: MILKDOWN_PRISM"); }
    const set = (plugin as unknown as { getState(s: unknown): DecoSet | undefined }).getState(v.state);
    if (!set) { throw new Error("no decoration state: MILKDOWN_PRISM"); }
    return set;
}

function decorations(v: EditorView): Deco[] {
    return prismState(v).find()
        .map((d) => ({
            from: d.from,
            to: d.to,
            class: (d.type as { attrs?: { class?: string } }).attrs?.class ?? "",
        }))
        .sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Every code block, as content ranges — the positions a decoration may occupy. */
function codeBlockRanges(v: EditorView): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    v.state.doc.descendants((n: ProseNode, p: number) => {
        if (n.type.name === "code_block") {
            out.push({ from: p + 1, to: p + n.nodeSize - 1 });
            return false;
        }
        return true;
    });
    return out;
}

/** Decorations falling inside a given range, as comparable strings. */
function within(decos: Deco[], range: { from: number; to: number }): string[] {
    return decos
        .filter((d) => d.from >= range.from && d.to <= range.to)
        .map((d) => `${d.from}-${d.to}:${d.class}`);
}

/** The nth code block's position, or -1. */
function codeBlockPos(v: EditorView, nth: number): number {
    let seen = 0;
    let pos = -1;
    v.state.doc.descendants((n: ProseNode, p: number) => {
        if (n.type.name === "code_block") {
            if (seen++ === nth && pos < 0) { pos = p; }
            return false;
        }
        return true;
    });
    return pos;
}

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("prism decorations — corpus invariants", () => {
    const corpus = loadCorpusFixtures().filter((f) => f.content.includes("```"));

    it("the corpus should contain code blocks to check (guards the filter)", () => {
        // Without this, a filter that matched nothing would make every check
        // below vacuous while still reading as full coverage.
        expect(corpus.length).toBeGreaterThan(3);
    });

    for (const { name, content } of corpus) {
        it(`${name} should place every decoration inside a code block's content`, async () => {
            const editor = await makeEditor(content);
            const v = view(editor);
            const ranges = codeBlockRanges(v);
            for (const d of decorations(v)) {
                const inside = ranges.some((r) => d.from >= r.from && d.to <= r.to);
                expect(inside, `decoration ${d.from}-${d.to} is outside every code block`).toBe(true);
            }
        });
    }

    it("the corpus should produce a substantial number of decorations", async () => {
        // An empty set satisfies every containment check above. Prove the
        // checks have teeth on real documents.
        let total = 0;
        for (const { content } of corpus) {
            const editor = await makeEditor(content);
            total += decorations(view(editor)).length;
        }
        expect(total).toBeGreaterThan(50);
    });
});

describe("prism decorations — editing", () => {
    it("a fresh document should decorate its supported-language blocks", async () => {
        const editor = await makeEditor(CODE_DOC);
        expect(decorations(view(editor)).length).toBeGreaterThan(20);
    });

    it("a selection-only transaction should not rebuild the set (identity preserved)", async () => {
        // The headline defect #2436 fixed: two whole-document `findChildren`
        // walks sat ABOVE the plugin's own `docChanged` test, so every caret
        // move paid them. Object identity is the honest observable — asserting
        // the decorations are "still correct" passes either way.
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        const before = prismState(v);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)));
        expect(prismState(view(editor))).toBe(before);
    });

    it("typing in prose should leave the code blocks' decorations in place", async () => {
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        const before = decorations(v).length;
        v.dispatch(v.state.tr.insertText("zzz", v.state.doc.resolve(3).pos));
        const after = view(editor);
        expect(decorations(after)).toHaveLength(before);
        const ranges = codeBlockRanges(after);
        for (const d of decorations(after)) {
            expect(ranges.some((r) => d.from >= r.from && d.to <= r.to)).toBe(true);
        }
    });

    it("typing inside a code block should re-highlight that block", async () => {
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        const first = codeBlockRanges(v)[0];
        expect(first).toBeDefined();
        const before = within(decorations(v), first!);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, first!.from + 1)));
        const v2 = view(editor);
        v2.dispatch(v2.state.tr.insertText("const yy = 2; ", first!.from));
        const after = view(editor);
        const now = within(decorations(after), codeBlockRanges(after)[0]!);
        expect(now).not.toEqual(before);
        expect(now.length).toBeGreaterThan(0);
    });

    it("changing the language of a NON-FIRST code block should re-highlight it", async () => {
        // Milkdown #2440, and the bug our fork carried: it compared only
        // `blocks[0]`'s language attr, so a change to any later block left
        // stale highlighting on screen. A language change goes through
        // `setNodeMarkup`, whose `AttrStep` maps to an empty step map, so the
        // step scan cannot see it either — only the per-index attr comparison
        // catches it.
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        const secondPos = codeBlockPos(v, 1);
        expect(secondPos).toBeGreaterThanOrEqual(0);
        const node = v.state.doc.nodeAt(secondPos)!;
        const range = { from: secondPos + 1, to: secondPos + node.nodeSize - 1 };
        const before = within(decorations(v), range);
        expect(before.length).toBeGreaterThan(0);

        // Keep the caret OUTSIDE the block: with it inside, the plugin
        // recomputes for that reason alone and this would pass vacuously.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)));
        const v2 = view(editor);
        v2.dispatch(v2.state.tr.setNodeMarkup(secondPos, undefined, {
            ...node.attrs,
            language: "css",
        }));
        const after = view(editor);
        expect(within(decorations(after), range)).not.toEqual(before);
    });

    it("deleting a whole code block should drop only its decorations", async () => {
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        const pos = codeBlockPos(v, 0);
        expect(pos).toBeGreaterThanOrEqual(0);
        const size = v.state.doc.nodeAt(pos)!.nodeSize;
        const removed = within(decorations(v), { from: pos + 1, to: pos + size - 1 }).length;
        expect(removed).toBeGreaterThan(0);
        const before = decorations(v).length;
        v.dispatch(v.state.tr.delete(pos, pos + size));
        const after = view(editor);
        expect(decorations(after)).toHaveLength(before - removed);
        const ranges = codeBlockRanges(after);
        for (const d of decorations(after)) {
            expect(ranges.some((r) => d.from >= r.from && d.to <= r.to)).toBe(true);
        }
    });
});
