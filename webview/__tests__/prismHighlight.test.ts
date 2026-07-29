/**
 * `prismHighlightPlugin` (webview/plugins/prismHighlight.ts) — our replacement
 * for `@milkdown/plugin-prism`'s `prismPlugin`, which ran two whole-document
 * `findChildren` walks on EVERY transaction, selection-only ones included
 * (MAR-137).
 *
 * The replacement had to re-implement upstream's decoration computation,
 * because `getDecorations` is not exported. That duplication is the real risk
 * in this change — a transcription slip would show up as wrong or missing
 * syntax highlighting, which no perf gate would catch. So the primary test
 * here is DIFFERENTIAL: both plugins are registered side by side on the same
 * document and their decoration sets are compared exactly. It is deliberately
 * not a hand-written table of expected class names, which would only pin what
 * I believed upstream did.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { prism, prismConfig, prismPlugin } from "@milkdown/plugin-prism";
import type { EditorView } from "../pm";
import { TextSelection } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { prismHighlightPlugin } from "../plugins/prismHighlight";
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

/** An editor carrying BOTH plugins, so their outputs can be compared. */
async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            ctx.set(prismConfig.key, { configureRefractor: () => refractor });
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(prism)
        .use(prismHighlightPlugin)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

/** A plugin's decorations, normalized to a comparable, order-stable shape. */
function decorationsOf(v: EditorView, keyName: string): string[] {
    const plugin = v.state.plugins.find((p) => String((p as { key?: string }).key ?? "").startsWith(keyName));
    if (!plugin) { throw new Error(`plugin not found: ${keyName}`); }
    const set = (plugin as unknown as { getState(s: unknown): { find(): { from: number; to: number; type: unknown }[] } | undefined })
        .getState(v.state);
    if (!set) { throw new Error(`no decoration state: ${keyName}`); }
    return set.find()
        .map((d) => `${d.from}-${d.to}:${(d.type as { attrs?: { class?: string } }).attrs?.class ?? ""}`)
        .sort();
}

const ours = (v: EditorView) => decorationsOf(v, "birtaPrismHighlight");
const upstream = (v: EditorView) => decorationsOf(v, "MILKDOWN_PRISM");

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("prismHighlight — differential over the whole corpus", () => {
    // The single strongest guard in this file, and the one that keeps earning
    // its keep after today: it compares our fork against WHATEVER version of
    // upstream is installed, over every corpus fixture. So it is not only a
    // transcription check — it is a dependency-upgrade drift detector. If a
    // future `@milkdown/plugin-prism` bump changes how decorations are built,
    // this goes red on the upgrade PR instead of shipping silently divergent
    // highlighting. (Transcribed from 7.21.2; the version is documented in
    // prismHighlight.ts, but this test, not the version, is the real contract.)
    const corpus = loadCorpusFixtures().filter((f) => f.content.includes("```"));

    it("the corpus should contain code blocks to compare (guards the filter)", () => {
        // Without this, a filter that matched nothing would make every
        // comparison below vacuous while still reading as full coverage.
        expect(corpus.length).toBeGreaterThan(3);
    });

    for (const { name, content } of corpus) {
        it(`${name} should decorate exactly as upstream does`, async () => {
            const editor = await makeEditor(content);
            const v = view(editor);
            expect(ours(v)).toEqual(upstream(v));
        });
    }

    it("at least one corpus fixture should produce a non-empty decoration set", async () => {
        // Two empty sets compare equal. Prove the comparison has teeth on real
        // documents, not just on the hand-written CODE_DOC below.
        let total = 0;
        for (const { content } of corpus) {
            const editor = await makeEditor(content);
            total += ours(view(editor)).length;
        }
        expect(total).toBeGreaterThan(50);
    });
});

describe("prismHighlight — differential against upstream", () => {
    it("the initial decorations should match upstream's exactly", async () => {
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        // Guard against a vacuous comparison: two empty sets are equal too.
        expect(ours(v).length).toBeGreaterThan(20);
        expect(ours(v)).toEqual(upstream(v));
    });

    it("typing in prose should leave both plugins agreeing", async () => {
        // The fast path: an inline edit outside a code block carries the set
        // forward instead of walking. Upstream recomputes. Same answer.
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        const prosePos = v.state.doc.resolve(3).pos;
        v.dispatch(v.state.tr.insertText("zzz", prosePos));
        const after = view(editor);
        expect(ours(after).length).toBeGreaterThan(20);
        expect(ours(after)).toEqual(upstream(after));
    });

    it("typing INSIDE a code block should re-highlight, still matching upstream", async () => {
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        let codePos = -1;
        v.state.doc.descendants((n, p) => {
            if (codePos < 0 && n.type.name === "code_block") { codePos = p; }
            return true;
        });
        expect(codePos).toBeGreaterThanOrEqual(0);
        // Put the caret inside the block, as a real edit would.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, codePos + 2)));
        const view2 = view(editor);
        view2.dispatch(view2.state.tr.insertText("const yy = 2; ", codePos + 1));
        const after = view(editor);
        expect(ours(after).length).toBeGreaterThan(20);
        expect(ours(after)).toEqual(upstream(after));
    });

    it("deleting a whole code block should leave both plugins agreeing", async () => {
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        let block: { pos: number; size: number } | null = null;
        v.state.doc.descendants((n, p) => {
            if (!block && n.type.name === "code_block") { block = { pos: p, size: n.nodeSize }; }
            return true;
        });
        expect(block).not.toBeNull();
        const b = block as unknown as { pos: number; size: number };
        v.dispatch(v.state.tr.delete(b.pos, b.pos + b.size));
        const after = view(editor);
        expect(ours(after)).toEqual(upstream(after));
    });

    it("a selection-only transaction should not rebuild the set (identity preserved)", async () => {
        // The headline defect: upstream's two whole-document walks sat ABOVE
        // its own `docChanged` test, so every caret move paid them. Object
        // identity is the honest observable — asserting the decorations are
        // "still correct" passes either way.
        const editor = await makeEditor(CODE_DOC);
        const v = view(editor);
        const before = (v.state.plugins.find((p) =>
            String((p as { key?: string }).key ?? "").startsWith("birtaPrismHighlight")) as unknown as
            { getState(s: unknown): unknown }).getState(v.state);
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)));
        const after = view(editor);
        const now = (after.state.plugins.find((p) =>
            String((p as { key?: string }).key ?? "").startsWith("birtaPrismHighlight")) as unknown as
            { getState(s: unknown): unknown }).getState(after.state);
        expect(now).toBe(before);
    });

    it("the editor should carry our plugin instead of upstream's, not both", async () => {
        // In production `editor.ts` filters upstream out; this file deliberately
        // registers both to compare them, so the guard reads the real wiring.
        const editorSource = fs.readFileSync(path.resolve(__dirname, "..", "editor.ts"), "utf8");
        expect(editorSource).toContain("prism.filter((plugin) => plugin !== prismPlugin)");
        expect(editorSource).toContain(".use(prismHighlightPlugin)");
        expect(prism).toContain(prismPlugin);
    });
});
