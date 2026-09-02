/**
 * MAR-429: the editor mounts on the first chunk and the rest streams in.
 *
 * Two things are held here and nowhere else. The document at the end of the
 * stream is the document a single parse gives, heading ids included, over
 * every corpus fixture the segmenter can cut (the segmenter's own test proves
 * each cut; this proves the stream, the seed and the plugins between them
 * add nothing and lose nothing). And no path can serialize a partial
 * document: the flush answers with the saved bytes and the sync pipeline
 * posts nothing until the last chunk lands, at which point an edit made
 * meanwhile is posted whole.
 *
 * The floor is lowered to zero so a jsdom-sized fixture streams; what a real
 * document does in a real browser, and what the marks say, is
 * `e2e/progressiveOpen`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { editorViewCtx, parserCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView, Node as ProseNode } from "../pm";
import {
    createEditor,
    flushPendingEdit,
    isSettled,
    setProgressiveOpenMinCharsForTests,
    syncExternalContent,
} from "../editor";
import { markdownFormat } from "../format/markdown";
import { seedHeadingIds } from "../plugins/headingIdSync";
import { foldPluginKey } from "../plugins/foldState";
import { FIRST_SCREEN_MIN_LINES, PROGRESSIVE_OPEN_MIN_CHARS, STREAM_CHUNK_MIN_LINES, planProgressiveOpen } from "../progressiveOpen";
import { loadCorpusFixtures } from "./helpers/moveFuzz";

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

/** The whole-parse document with the ids a whole seed gives it. */
const wholeParse = (editor: Editor, text: string): ProseNode =>
    editor.action((ctx) => seedHeadingIds(ctx, ctx.get(parserCtx)(text) as ProseNode, {}));

async function settled(): Promise<void> {
    for (let i = 0; i < 30000 && !isSettled(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    if (!isSettled()) throw new Error("the stream never settled");
}

/**
 * Enough sections, at seven lines each, for a first chunk and two streamed
 * chunks at the stream's own chunk size, and no more: the editor here is the
 * full production stack under jsdom, and a fixture sized for the browser
 * would time out on a shared machine for a reason with nothing to do with
 * its subject.
 */
const SECTIONS = Math.ceil((FIRST_SCREEN_MIN_LINES + 2 * STREAM_CHUNK_MIN_LINES) / 7) + 10;

/** A document of `sections` sections, each a heading, a paragraph and a list; past any floor. */
function outline(sections: number, headingText = (i: number) => `Section ${i}`): string {
    const lines = ["# Progressive document", "", "Opening paragraph.", ""];
    for (let i = 1; i <= sections; i++) {
        lines.push(`## ${headingText(i)}`, "", `Body of section ${i}.`, "", `- item of ${i}`, `    - nested in ${i}`, "");
    }
    lines.push("Closing paragraph.", "");
    return lines.join("\n");
}

describe("progressive open", { timeout: 60_000 }, () => {
    let editor: Editor | null = null;
    let container: HTMLElement;
    let updates: string[];

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        container = document.createElement("div");
        document.body.appendChild(container);
        updates = [];
        setProgressiveOpenMinCharsForTests(0);
    });

    afterEach(async () => {
        setProgressiveOpenMinCharsForTests(undefined);
        await editor?.destroy();
        editor = null;
    });

    it("the plan should be the whole text in pieces, and null below the floor", () => {
        const text = outline(SECTIONS);
        const plan = planProgressiveOpen(text, markdownFormat, 0);
        expect(plan).not.toBeNull();
        expect(plan!.rest.length).toBeGreaterThan(1);
        expect(plan!.first + plan!.rest.join("")).toBe(text);
        expect(planProgressiveOpen(text, markdownFormat, text.length + 1)).toBeNull();
        expect(planProgressiveOpen("# Small\n\nOne paragraph.\n", markdownFormat, PROGRESSIVE_OPEN_MIN_CHARS)).toBeNull();
    });

    it("every corpus fixture the segmenter can cut should stream to the document a single parse gives", async () => {
        const streamed: string[] = [];
        const differing: string[] = [];
        // Most fixtures are shorter than a first screen and would open
        // whole; each is also taken four times over, joined at a blank line,
        // which keeps it the same markdown and makes it long enough to cut.
        const texts: Array<{ name: string; content: string }> = [];
        for (const f of loadCorpusFixtures()) {
            const body = f.content.endsWith("\n") ? f.content : `${f.content}\n`;
            texts.push({ name: f.name, content: f.content }, { name: `${f.name} x4`, content: [body, body, body, body].join("\n") });
        }
        // The reference is a WHOLE open through the same editor, not a bare
        // parse: the open is the parse plus what the plugins do to it, and
        // that is what has to be the same. Both sides get one empty
        // transaction first, because a plugin that acts on any transaction
        // (the trailing-rule filler) has acted on the streamed document's
        // finishing transactions and on the whole one's nothing yet.
        const opened = async (text: string, minChars: number | undefined): Promise<string> => {
            setProgressiveOpenMinCharsForTests(minChars);
            const ed = await createEditor(container, text, () => {});
            editor = ed;
            await settled();
            const v = view(ed);
            v.dispatch(v.state.tr);
            expect(() => v.state.doc.check()).not.toThrow();
            const json = JSON.stringify(v.state.doc.toJSON());
            await ed.destroy();
            editor = null;
            container.innerHTML = "";
            return json;
        };
        for (const f of texts) {
            if (!planProgressiveOpen(f.content, markdownFormat, 0)) continue;
            const progressive = await opened(f.content, 0);
            const whole = await opened(f.content, undefined);
            streamed.push(f.name);
            if (progressive !== whole) differing.push(f.name);
        }
        setProgressiveOpenMinCharsForTests(0);
        expect(differing).toEqual([]);
        // Reach: a segmenter that cuts nothing streams nothing, and the loop
        // above passes vacuously.
        expect(streamed.length).toBeGreaterThan(20);
    }, 240_000);

    it("a repeated heading in a later chunk should get the id a whole seed gives it", async () => {
        const text = outline(SECTIONS, () => "Notes");
        editor = await createEditor(container, text, () => {});
        await settled();
        const ids: string[] = [];
        view(editor).state.doc.forEach((node) => {
            if (node.type.name === "heading" && node.attrs["level"] === 2) ids.push(String(node.attrs["id"]));
        });
        const expected: string[] = [];
        wholeParse(editor, text).forEach((node) => {
            if (node.type.name === "heading" && node.attrs["level"] === 2) expected.push(String(node.attrs["id"]));
        });
        expect(ids).toEqual(expected);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids[1]).not.toBe(ids[0]);
    });

    it("a flush while the document is still arriving should answer with the saved bytes, never a partial serialize", async () => {
        const text = outline(SECTIONS);
        editor = await createEditor(container, text, (md) => { updates.push(md); });
        expect(isSettled()).toBe(false);
        expect(view(editor).state.doc.childCount).toBeLessThan(wholeParse(editor, text).childCount);
        expect(flushPendingEdit("f1")).toBe(text);
        await settled();
        expect(updates).toEqual([]);
        expect(flushPendingEdit("f2")).toBe(text);
    });

    it("an edit made while the document arrives should keep its place and post whole once the stream completes", async () => {
        const text = outline(SECTIONS);
        editor = await createEditor(container, text, (md) => { updates.push(md); });
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
        const v = view(editor);
        // The caret in the opening paragraph, which every append must leave alone.
        const at = 1 + v.state.doc.child(0).nodeSize + "Opening paragraph.".length;
        v.dispatch(v.state.tr.insertText(" edited", at));
        const caret = v.state.selection.from;
        expect(isSettled()).toBe(false);
        await settled();
        expect(v.state.selection.from).toBe(caret);
        for (let i = 0; i < 1000 && updates.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(updates).toHaveLength(1);
        expect(updates[0]).toBe(text.replace("Opening paragraph.", "Opening paragraph. edited"));
    }, 20_000);

    it("an external sync while the document arrives should replace it whole and stop the stream", async () => {
        const text = outline(SECTIONS);
        editor = await createEditor(container, text, (md) => { updates.push(md); });
        expect(isSettled()).toBe(false);
        const replacement = "# Replaced\n\nBy the file on disk.\n";
        expect(syncExternalContent(replacement)).toBe(true);
        expect(isSettled()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(editor.action(getMarkdown())).toBe(replacement);
        expect(updates).toEqual([]);
    });

    it("a collapsed callout in a later chunk should be folded once the stream completes", async () => {
        const lines = outline(SECTIONS).split("\n");
        lines.push("> [!note]- Folded by its syntax", "> Hidden body.", "");
        const text = lines.join("\n");
        editor = await createEditor(container, text, () => {});
        await settled();
        const state = foldPluginKey.getState(view(editor).state)!;
        const doc = view(editor).state.doc;
        let calloutPos = -1;
        doc.forEach((node, offset) => { if (node.type.name === "callout") calloutPos = offset; });
        expect(calloutPos).toBeGreaterThan(0);
        expect(state.folded.has(calloutPos)).toBe(true);
    });
});
