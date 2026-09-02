/**
 * The static first frame's decisions, in jsdom: which documents get one,
 * where the prefix ends, that it renders as the editor's own markup, and that
 * text typed into the frame is replayed into the live editor in order. What
 * jsdom cannot see, that the frame is PAINTED before the model build and
 * swapped without a gap, is `e2e/firstFrame`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { markdownFormat } from "../format/markdown";
import { mdxFormat } from "../format/mdx";
import {
    FIRST_FRAME_MAX_LINES,
    FIRST_FRAME_MIN_CHARS,
    FIRST_FRAME_MIN_LINES,
    firstFramePrefix,
    paintFirstFrame,
    renderPrefix,
    replayTypedText,
} from "../firstFrame";
import { makeCorpusEditor } from "./helpers/moveFuzz";

beforeAll(() => {
    if (typeof globalThis.requestAnimationFrame === "undefined") {
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
            setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
    }
});

/** A document of `sections` headed sections, each with a paragraph and a list. */
function outline(sections: number): string {
    let out = "";
    for (let i = 1; i <= sections; i++) {
        out += `## Section ${i}\n\nParagraph ${i} of ordinary prose, long enough to matter.\n\n- item a ${i}\n- item b ${i}\n\n`;
    }
    return out;
}

/** Enough sections to clear the size floor. */
const BIG = outline(Math.ceil(FIRST_FRAME_MIN_CHARS / 80));

describe("firstFramePrefix", () => {
    it("a document under the size floor should get no frame", () => {
        expect(BIG.length).toBeGreaterThanOrEqual(FIRST_FRAME_MIN_CHARS);
        expect(firstFramePrefix(outline(3), markdownFormat)).toBeNull();
    });

    it("a large document should get a prefix of at least the minimum lines, ending at a safe cut", () => {
        const prefix = firstFramePrefix(BIG, markdownFormat)!;
        expect(prefix).not.toBeNull();
        const lines = prefix.split("\n");
        expect(lines.length).toBeGreaterThanOrEqual(FIRST_FRAME_MIN_LINES);
        expect(lines.length).toBeLessThanOrEqual(FIRST_FRAME_MAX_LINES);
        // The cut sits at a blank line before a block start, never inside a
        // list: the heading, the paragraph, or the list's first item.
        expect(prefix.endsWith("\n\n")).toBe(true);
        expect(BIG.slice(prefix.length)).toMatch(/^(## Section|Paragraph|- item a)/);
    });

    it("a format without a segmenter should get no frame", () => {
        expect(firstFramePrefix(BIG, mdxFormat)).toBeNull();
    });

    it("a large document whose first safe cut is too far down should get no frame", () => {
        // One list from the first line to well past the ceiling: no cut inside it.
        const list = Array.from({ length: FIRST_FRAME_MAX_LINES + 50 }, (_, i) => `- item ${i}`).join("\n");
        const doc = `${list}\n\n${BIG}`;
        expect(firstFramePrefix(doc, markdownFormat)).toBeNull();
    });
});

describe("renderPrefix", () => {
    it("should render the prefix as the editor's own markup", async () => {
        const fragment = await renderPrefix("## Title\n\nA paragraph with **bold**.\n\n- one\n- two\n", markdownFormat);
        expect(fragment).not.toBeNull();
        const host = document.createElement("div");
        host.appendChild(fragment!);
        expect(host.querySelector("h2")?.textContent).toBe("Title");
        expect(host.querySelector("p strong")?.textContent).toBe("bold");
        expect(host.querySelectorAll("li")).toHaveLength(2);
    });
});

describe("paintFirstFrame and replayTypedText", () => {
    it("should paint a read-only frame with a focused capture field, then hand the typed text to the live editor", async () => {
        document.body.innerHTML = "";
        const container = document.createElement("div");
        document.body.appendChild(container);

        const frame = await paintFirstFrame(container, BIG, markdownFormat);
        expect(frame).not.toBeNull();
        expect(container.querySelector(".birta-first-frame .ProseMirror")?.getAttribute("contenteditable")).toBe("false");
        expect(container.querySelector(".birta-first-frame h2")?.textContent).toBe("Section 1");
        const sink = container.querySelector<HTMLTextAreaElement>(".birta-first-frame-sink")!;
        expect(document.activeElement).toBe(sink);

        // What a user types while the model builds.
        sink.value = "hello\nworld";

        const editor = await makeCorpusEditor("# Heading\n\nBody.\n");
        try {
            const { typed, hadFocus } = frame!.dispose();
            expect(typed).toBe("hello\nworld");
            expect(hadFocus).toBe(true);
            expect(container.querySelector(".birta-first-frame")).toBeNull();

            const view = editor.action((ctx) => ctx.get(editorViewCtx));
            replayTypedText(view, typed);
            const blocks: string[] = [];
            view.state.doc.forEach((n) => blocks.push(`${n.type.name}:${n.textContent}`));
            // The caret opens at the start of the heading: "hello" lands there,
            // the newline splits it, and "world" starts the block that follows.
            expect(blocks).toEqual(["heading:hello", "heading:worldHeading", "paragraph:Body."]);
        } finally {
            await editor.destroy();
        }
    });

    it("a document opening on a rule should keep the rule and take the text in its first paragraph", async () => {
        // The opening selection on a leading atom is a node selection, and
        // inserting text over one replaces the node.
        const editor = await makeCorpusEditor("---\n\nBody.\n");
        try {
            const view = editor.action((ctx) => ctx.get(editorViewCtx));
            replayTypedText(view, "x");
            const blocks: string[] = [];
            view.state.doc.forEach((n) => blocks.push(`${n.type.name}:${n.textContent}`));
            expect(blocks).toEqual(["hr:", "paragraph:xBody."]);
        } finally {
            await editor.destroy();
        }
    });

    it("a small document should paint nothing and leave the container untouched", async () => {
        const container = document.createElement("div");
        expect(await paintFirstFrame(container, outline(2), markdownFormat)).toBeNull();
        expect(container.childNodes).toHaveLength(0);
    });
});
