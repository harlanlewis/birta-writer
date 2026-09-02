/**
 * The verify worker's parser is built where there is no document
 * (webview/utils/headlessParser.ts), and this is the one place the tree asks
 * that with no document: the webview project runs every file under jsdom, so
 * a green there says nothing about a worker. The context is asserted first,
 * before anything that would read as a finding about the parser.
 *
 * What the shim below provides is not a DOM. Milkdown's clock resolves its
 * timers by dispatching events on the global object, which every window and
 * every worker scope can do and Node's global cannot; the shim is that one
 * capability, and the test would be lying about the worker if it gave more.
 */
import { describe, it, expect, beforeAll } from "vitest";

describe("the headless parser, with no document", () => {
    beforeAll(() => {
        const target = new EventTarget();
        Object.assign(globalThis, {
            addEventListener: target.addEventListener.bind(target),
            removeEventListener: target.removeEventListener.bind(target),
            dispatchEvent: target.dispatchEvent.bind(target),
        });
    });

    it("this file should be running with no document and no window, or nothing below means anything", () => {
        expect(typeof document).toBe("undefined");
        expect(typeof window).toBe("undefined");
    });

    it("the markdown parse half should load and build the page's parser with no document", async () => {
        const { createHeadlessParser } = await import("../../webview/utils/headlessParser");
        const { markdownParse } = await import("../../webview/format/markdown/parse");
        const parser = await createHeadlessParser(markdownParse);
        try {
            const doc = parser.parse(
                "# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone ~~gone~~.\n",
            );
            expect(doc).not.toBeNull();
            const kinds: string[] = [];
            doc!.forEach((child) => { kinds.push(child.type.name); });
            // The GFM preset's constructs are here, so this is the whole
            // stack and not commonmark alone.
            expect(kinds).toEqual(["heading", "bullet_list", "table", "paragraph"]);
            expect(parser.schema.marks.strike_through).toBeDefined();
            // The serializer is the page's too; the worker does not use it,
            // but a parser without one is not the page's pipeline.
            expect(parser.serialize(doc!)).toContain("| a | b |");
        } finally {
            await parser.destroy();
        }
    });
});
