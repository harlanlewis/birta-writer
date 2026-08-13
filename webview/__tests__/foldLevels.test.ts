/**
 * What "level" means for the fold-level commands (MAR-116).
 *
 * The commands mirror VS Code's `editor.foldLevelN`, and the word "level" has
 * two candidate readings in this editor that VS Code never had to choose
 * between, because it folds a flat text document where depth is indentation:
 *
 *   (a) a heading's own rank — level 2 means "every h2"
 *   (b) containment depth in the tree of foldable regions
 *
 * (b) is what shipped, and these tests are the argument. The first group shows
 * the two readings AGREEING wherever (a) is meaningful, so the intuitive
 * reading is not being quietly discarded. The second shows (a) being undefined
 * rather than merely different: this editor folds code blocks, tables,
 * callouts, blockquotes and directives, none of which has a heading rank, and
 * they are exactly the blocks a reader most wants collapsed.
 *
 * Drives the REAL Milkdown editor, so ranges and position math match
 * production. acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";
import {
    foldLevels,
    foldablesAtLevel,
    foldableSubtree,
    getHeadingLevel,
    isHeadingNode,
} from "../plugins/headingFold/foldModel";

let editors: Editor[] = [];

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
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView => editor.ctx.get(editorViewCtx);

afterEach(async () => {
    await Promise.all(editors.map((e) => e.destroy()));
    editors = [];
    document.body.innerHTML = "";
});

/** Each foldable as `level:description`, in document order — a readable shape
 *  to assert a whole document's level assignment against. */
function levelMap(v: EditorView): string[] {
    const doc = v.state.doc;
    return [...foldLevels(doc)]
        .sort((a, b) => a[0] - b[0])
        .map(([pos, level]) => {
            const node = doc.nodeAt(pos);
            const name = node?.type.name ?? "?";
            const label = isHeadingNode(node) ? `h${getHeadingLevel(node)}` : name;
            return `${level}:${label}`;
        });
}

describe("fold levels — where the heading reading and containment agree", () => {
    it("a document descending h1/h2/h3 should give each heading its own rank as its level", async () => {
        const v = view(await makeEditor(
            "# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n",
        ));
        // Containment and "the heading's rank" produce the same answer here,
        // which is the case that makes the feature feel obvious.
        expect(levelMap(v)).toEqual(["1:h1", "2:h2", "3:h3"]);
    });

    it("two sibling sections should both be level 1, not consecutive levels", async () => {
        const v = view(await makeEditor(
            "# One\n\ntext\n\n# Two\n\ntext\n",
        ));
        expect(levelMap(v)).toEqual(["1:h1", "1:h1"]);
    });
});

describe("fold levels — where the heading reading breaks down", () => {
    it("a document starting at h2 should put its outermost section at level 1", async () => {
        const v = view(await makeEditor(
            "## Two\n\ntext\n\n### Three\n\ntext\n",
        ));
        // The heading reading would call these 2 and 3 and leave level 1
        // folding nothing at all. Containment matches VS Code: the outermost
        // region is level 1 whatever it happens to be called.
        expect(levelMap(v)).toEqual(["1:h2", "2:h3"]);
        expect(foldablesAtLevel(v.state.doc, 1)).toHaveLength(1);
    });

    it("a top-level code block should take a level, which its heading rank cannot give it", async () => {
        const v = view(await makeEditor(
            "```js\nconst a = 1;\n```\n\n# One\n\ntext\n",
        ));
        const levels = levelMap(v);
        // The code block has no heading rank at all, so the heading reading
        // has nowhere to put it. It is level 1 beside the section.
        expect(levels).toContain("1:code_block");
        expect(levels).toContain("1:h1");
    });

    it("mixed kinds nested in a section should take levels below it", async () => {
        const v = view(await makeEditor(
            "# One\n\n> [!TIP]\n> A callout body.\n\n```js\nconst a = 1;\n```\n",
        ));
        const levels = levelMap(v);
        expect(levels[0]).toBe("1:h1");
        // Both nested foldables sit one level inside the section, regardless
        // of being different kinds from each other and from a heading.
        expect(levels.slice(1).every((l) => l.startsWith("2:"))).toBe(true);
        expect(levels).toHaveLength(3);
    });

    it("every foldable should get a level, so no kind is silently unreachable", async () => {
        const v = view(await makeEditor(
            "# One\n\n## Two\n\n- item\n  - nested item\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n" +
            "> quoted\n> more\n\n```js\nx\n```\n",
        ));
        const doc = v.state.doc;
        const levels = foldLevels(doc);
        // The count assertion is the point: a level map that silently reached
        // nothing would satisfy every "is level N right" test above.
        expect(levels.size).toBeGreaterThanOrEqual(5);
        for (const [, level] of levels) {
            expect(level).toBeGreaterThanOrEqual(1);
        }
    });
});

describe("foldableSubtree", () => {
    it("a section's subtree should carry its nested foldables and itself", async () => {
        const v = view(await makeEditor(
            "# One\n\n## Two\n\ntext\n\n### Three\n\ntext\n\n# Separate\n\ntext\n",
        ));
        const doc = v.state.doc;
        const outermost = foldablesAtLevel(doc, 1);
        expect(outermost).toHaveLength(2);
        const subtree = foldableSubtree(doc, outermost[0]!);
        // h1 + h2 + h3, and NOT the sibling section that follows it.
        expect(subtree).toHaveLength(3);
        expect(subtree).toContain(outermost[0]!);
        expect(subtree).not.toContain(outermost[1]!);
    });

    it("a leaf foldable's subtree should be just itself", async () => {
        const v = view(await makeEditor("```js\nconst a = 1;\n```\n"));
        const doc = v.state.doc;
        const [only] = foldablesAtLevel(doc, 1);
        expect(foldableSubtree(doc, only!)).toEqual([only]);
    });

    it("a position that folds nothing should have an empty subtree", async () => {
        const v = view(await makeEditor("plain paragraph\n"));
        expect(foldableSubtree(v.state.doc, 0)).toEqual([]);
    });
});
