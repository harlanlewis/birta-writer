/**
 * Reading a fatal parse failure (MAR-350).
 *
 * These run the REAL mdx pipeline on real invalid documents rather than
 * hand-built error objects: the whole point of the module is that remark puts
 * the position somewhere other than `.message`, and a fake error would just
 * restate whatever shape the test author assumed. The shapes are asserted
 * separately below only to pin the parsing rules themselves.
 */
import { describe, it, expect } from "vitest";
import { describeParseFailure } from "../format/parseError";
import { mdxFormat } from "../format/mdx";
import { makeCorpusEditor } from "./helpers/moveFuzz";

/** The error the real mdx pipeline throws on `src`. */
async function failureFor(src: string) {
    let thrown: unknown;
    let parsed = false;
    try {
        const editor = await makeCorpusEditor(src, [], mdxFormat);
        await editor.destroy();
        parsed = true;
    } catch (e) {
        thrown = e;
    }
    expect(parsed, `expected a fatal parse for ${JSON.stringify(src)}`).toBe(false);
    return describeParseFailure(thrown);
}

describe("describeParseFailure over real invalid MDX", () => {
    it("an unclosed expression should report the brace's line and column", async () => {
        const { reason, at } = await failureFor("first line\n\nsecond {unclosed\n");

        expect(reason).toContain("closing brace");
        // Where the parser ran out, which is the end of body line 3. Without
        // this module the position is dropped entirely: remark's `.message`
        // carries none at all, only its `.place`.
        expect(at).toEqual({ line: 3, column: 17 });
    });

    it("an unclosed tag should report the tag's own line, not the document start", async () => {
        const { reason, at } = await failureFor("text\n\n<Foo>\n\nmore\n");

        expect(reason).toContain("Expected a closing tag");
        // remark reports 3:1-3:6 inside the reason text while `.name` says
        // 1:1; the reason's is the true one, and the position text is lifted
        // out so only one position is ever shown.
        expect(at).toEqual({ line: 3, column: 1 });
        expect(reason).not.toContain("3:1");
    });

    it("an unterminated tag name should report where the parser stopped", async () => {
        const { at } = await failureFor("x\n\ny <Bar\n");

        expect(at).toEqual({ line: 3, column: 7 });
    });
});

describe("describeParseFailure position sources", () => {
    it("a place with a start point should win over everything else", () => {
        const e = Object.assign(new Error("boom (9:9)"), {
            name: "1:1",
            place: { start: { line: 4, column: 2 }, end: { line: 4, column: 8 } },
        });

        expect(describeParseFailure(e)).toEqual({ reason: "boom (9:9)", at: { line: 4, column: 2 } });
    });

    it("a name-only position should be used when nothing else names one", () => {
        const e = Object.assign(new Error("boom"), { name: "doc.mdx:7:3" });

        expect(describeParseFailure(e)).toEqual({ reason: "boom", at: { line: 7, column: 3 } });
    });

    it("an error naming no position should report the reason alone", () => {
        const e = Object.assign(new Error("boom"), { name: "Error" });

        expect(describeParseFailure(e)).toEqual({ reason: "boom" });
    });

    it("a non-Error throw should still yield its text", () => {
        expect(describeParseFailure("plain string")).toEqual({ reason: "plain string" });
    });
});
