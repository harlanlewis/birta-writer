/**
 * Source-style preservation (MAR-16): emphasis/strong markers, thematic-break
 * markers, and setext headings survive a parse → serialize round trip instead
 * of being canonicalized.
 *
 * Every fixture is driven through the REAL Milkdown editor (real parser, real
 * remark-stringify, the production `pureCommonmark` + `configureSerialization`
 * stack) plus the real minimal-diff merge — the same wiring as the round-trip
 * corpus, with no mocks.
 *
 * Two complementary guarantees:
 *   1. The constructs now round-trip NATIVELY — `computeRoundTripProtection`
 *      returns null (zero regions) where it previously had to repair setext
 *      headings and rewritten `***`/`_em_` markers on every save.
 *   2. Editing a construct's own text keeps its recorded style: an edited
 *      setext heading stays setext, and editing next to a `***` rule leaves
 *      the `***` marker intact.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

const FIXTURES_DIR = join(__dirname, "fixtures");

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Document position right after the first text node equal to `text`. */
function posAfterText(v: EditorView, text: string): number {
    let found = -1;
    v.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.isText && node.text === text) {
            found = pos + text.length;
            return false;
        }
        return true;
    });
    if (found < 0) throw new Error(`text not found in doc: ${text}`);
    return found;
}

describe("source-style preservation removes round-trip protection", () => {
    for (const name of ["setext-and-rules.md", "emphasis-styles.md"]) {
        it(`${name} should round-trip byte-identically with NO protection regions`, async () => {
            // Arrange
            const content = readFileSync(join(FIXTURES_DIR, name), "utf8");
            const editor = await makeEditor(content);

            // Act
            const serialized = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(content, serialized);
            const merged = applyMinimalChanges(content, serialized, protection);

            // Assert — the file now serializes to itself, so the round-trip
            // needs zero protection regions (null); previously every setext
            // heading and rewritten `***`/`_em_` marker required one.
            expect(serialized).toBe(content);
            expect(protection).toBeNull();
            expect(merged).toBe(content);

            await editor.destroy();
        });
    }
});

describe("editing a construct keeps its recorded source style", () => {
    it("editing a setext heading's text should keep it setext", async () => {
        // Arrange — an H1 whose 10-char text has a matching 10-char underline.
        const content = "My Heading\n==========\n\nBody paragraph.\n";
        const editor = await makeEditor(content);
        const baseline = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(content, baseline);

        // Act — append to the heading text inside the real editor.
        const v = view(editor);
        v.dispatch(v.state.tr.insertText(" Extended", posAfterText(v, "My Heading")));
        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(content, serialized, protection);

        // Assert — the heading kept the setext (underlined) form; it was NOT
        // canonicalized to ATX (`# My Heading Extended`).
        const lines = merged.split("\n");
        const headingLine = lines.findIndex((l) => l === "My Heading Extended");
        expect(headingLine).toBeGreaterThanOrEqual(0);
        expect(lines[headingLine + 1]).toMatch(/^=+$/);
        expect(merged).not.toContain("# My Heading Extended");

        await editor.destroy();
    });

    it("editing next to a star rule should keep the *** marker", async () => {
        // Arrange
        const content = "Intro paragraph.\n\n***\n\nOutro paragraph.\n";
        const editor = await makeEditor(content);
        const baseline = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(content, baseline);

        // Act — edit the paragraph after the rule.
        const v = view(editor);
        v.dispatch(v.state.tr.insertText(" edited", posAfterText(v, "Outro paragraph.")));
        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(content, serialized, protection);

        // Assert — the star rule kept its marker; it was NOT rewritten to `---`.
        expect(merged).toContain("\n***\n");
        expect(merged).not.toContain("\n---\n");
        expect(merged).toContain("Outro paragraph. edited");

        await editor.destroy();
    });

    it("editing a setext H2's text should keep the dash underline", async () => {
        // Arrange — depth-2 setext heading (dash underline).
        const content = "Section Two\n-----------\n\nBody.\n";
        const editor = await makeEditor(content);
        const baseline = editor.action(getMarkdown());
        const protection = computeRoundTripProtection(content, baseline);

        // Act
        const v = view(editor);
        v.dispatch(v.state.tr.insertText(" X", posAfterText(v, "Section Two")));
        const serialized = editor.action(getMarkdown());
        const merged = applyMinimalChanges(content, serialized, protection);

        // Assert — still setext with a dash underline, not ATX `## ...`.
        const lines = merged.split("\n");
        const headingLine = lines.findIndex((l) => l === "Section Two X");
        expect(headingLine).toBeGreaterThanOrEqual(0);
        expect(lines[headingLine + 1]).toMatch(/^-+$/);
        expect(merged).not.toContain("## Section Two X");

        await editor.destroy();
    });
});
