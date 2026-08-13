/**
 * notionIds: recognizing the 32-hex suffix a Notion markdown export writes
 * onto every page file and folder, so the resolver can retry without it and
 * the link popup can show a name a reader can use.
 *
 * The boundary that matters is what must NOT be stripped: the pattern runs
 * over ordinary filenames too, and every false positive silently truncates
 * one.
 */
import { describe, it, expect } from "vitest";
import {
    stripNotionIdFromSegment,
    stripNotionIds,
    notionDisplayTarget,
} from "../notionIds";

// The example from a real export: title, one space, 32 lowercase hex.
const ID = "7a6f70896bfc4e5e976d588412b74370";

describe("stripNotionIdFromSegment", () => {
    it("a file segment carrying an id should lose the id and keep the extension", () => {
        expect(stripNotionIdFromSegment(`Room 1 ${ID}.md`)).toBe("Room 1.md");
    });

    it("a folder segment carrying an id should lose the id with no extension to keep", () => {
        expect(
            stripNotionIdFromSegment("Private & Shared 19b8ecd8a5b3800c8c19c98b45c56de8"),
        ).toBe("Private & Shared");
    });

    it("a multi-word title should keep every word but the id", () => {
        expect(stripNotionIdFromSegment(`My Weekly Review Notes ${ID}.md`)).toBe(
            "My Weekly Review Notes.md",
        );
    });

    it("a title ending in hex of the wrong length should be left alone", () => {
        expect(stripNotionIdFromSegment(`Room 1 ${ID.slice(1)}.md`)).toBeNull();
        expect(stripNotionIdFromSegment(`Room 1 ${ID}0.md`)).toBeNull();
    });

    it("an uppercase id should be left alone (the exporter writes lowercase)", () => {
        expect(stripNotionIdFromSegment(`Room 1 ${ID.toUpperCase()}.md`)).toBeNull();
    });

    it("an id not separated by a space should be left alone", () => {
        expect(stripNotionIdFromSegment(`Room1${ID}.md`)).toBeNull();
        expect(stripNotionIdFromSegment(`Room-1-${ID}.md`)).toBeNull();
    });

    it("a separator other than a plain space should be left alone", () => {
        // Tab, newline and non-breaking space: `\s` would admit all three,
        // and the exporter writes none of them.
        for (const sep of ["\t", "\n", "\u00a0", "\u2009"]) {
            expect(stripNotionIdFromSegment(`Room 1${sep}${ID}.md`)).toBeNull();
        }
    });

    it("an id that is not at the end should be left alone", () => {
        expect(stripNotionIdFromSegment(`Room 1 ${ID} draft.md`)).toBeNull();
    });

    it("a segment that is nothing but an id should be left alone", () => {
        expect(stripNotionIdFromSegment(` ${ID}.md`)).toBeNull();
        expect(stripNotionIdFromSegment(` ${ID}`)).toBeNull();
    });

    it("an ordinary filename should be left alone", () => {
        expect(stripNotionIdFromSegment("notes.md")).toBeNull();
        expect(stripNotionIdFromSegment("Room 1.md")).toBeNull();
        expect(stripNotionIdFromSegment("")).toBeNull();
    });
});

describe("stripNotionIds", () => {
    it("every segment carrying an id should lose it", () => {
        expect(
            stripNotionIds(`Private & Shared 19b8ecd8a5b3800c8c19c98b45c56de8/Room 1 ${ID}.md`),
        ).toBe("Private & Shared/Room 1.md");
    });

    it("a path where only one segment carries an id should keep the rest verbatim", () => {
        expect(stripNotionIds(`vault/notes/Room 1 ${ID}.md`)).toBe("vault/notes/Room 1.md");
        expect(
            stripNotionIds(`Private & Shared 19b8ecd8a5b3800c8c19c98b45c56de8/notes.md`),
        ).toBe("Private & Shared/notes.md");
    });

    it("a path with no id anywhere should return null so a caller can skip the retry", () => {
        expect(stripNotionIds("vault/notes/Room 1.md")).toBeNull();
        expect(stripNotionIds("")).toBeNull();
    });

    it("leading and relative segments should survive untouched", () => {
        expect(stripNotionIds(`../pages/Room 1 ${ID}.md`)).toBe("../pages/Room 1.md");
        expect(stripNotionIds(`/pages/Room 1 ${ID}.md`)).toBe("/pages/Room 1.md");
    });
});

describe("notionDisplayTarget", () => {
    it("a percent-encoded export target should decode and lose its id", () => {
        expect(notionDisplayTarget(`Room%201%20${ID}.md`)).toBe("Room 1.md");
    });

    it("a nested export target should clean every segment", () => {
        expect(
            notionDisplayTarget(
                `Private%20%26%20Shared%2019b8ecd8a5b3800c8c19c98b45c56de8/Room%201%20${ID}.md`,
            ),
        ).toBe("Private & Shared/Room 1.md");
    });

    it("a fragment should survive the cleaning", () => {
        expect(notionDisplayTarget(`Room%201%20${ID}.md#agenda`)).toBe("Room 1.md#agenda");
    });

    it("an ordinary href should return null rather than a decoded rewrite", () => {
        // The popup shows the href verbatim on a null: decoding every `%20`
        // link would change what a non-Notion user sees.
        expect(notionDisplayTarget("my%20notes.md")).toBeNull();
        expect(notionDisplayTarget("https://example.com/a")).toBeNull();
        expect(notionDisplayTarget("#heading")).toBeNull();
        expect(notionDisplayTarget("")).toBeNull();
    });

    it("a malformed percent escape should not throw", () => {
        // decodeURIComponent throws on a lone `%`; the target is then judged
        // on its raw bytes, which carry no id, so there is nothing to clean.
        expect(notionDisplayTarget("100%.md")).toBeNull();
        expect(notionDisplayTarget(`100% done ${ID}.md`)).toBe("100% done.md");
    });
});
