/**
 * Provider recognition truth table (MAR-56). Pure string work — the URL forms
 * that must resolve to a YouTube id, and the many shapes that must NOT (no false
 * positives), mirroring pasteLink.test.ts's detectPastedLinkTarget discipline.
 */
import { describe, it, expect } from "vitest";
import {
    recognizeProvider,
    youtubeId,
    youtubeThumbnailUrl,
    youtubeEmbedUrl,
} from "../utils/embedProviders";

const ID = "dQw4w9WgXcQ"; // a real-shaped 11-char id

describe("youtubeId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        [`https://www.youtube.com/watch?v=${ID}`, ID],
        [`https://youtube.com/watch?v=${ID}`, ID],
        [`http://www.youtube.com/watch?v=${ID}`, ID],
        [`https://youtu.be/${ID}`, ID],
        [`https://youtu.be/${ID}?t=42`, ID],
        [`https://www.youtube.com/embed/${ID}`, ID],
        [`https://m.youtube.com/watch?v=${ID}`, ID],
        [`https://music.youtube.com/watch?v=${ID}`, ID],
        [`https://www.youtube.com/shorts/${ID}`, ID],
        [`https://www.youtube.com/v/${ID}`, ID],
        // Extra query params around the id must not matter.
        [`https://www.youtube.com/watch?list=PLxyz&v=${ID}&index=2`, ID],
        [`https://youtu.be/${ID}?si=abc123`, ID],
        // Privacy-enhanced host — the same one the player itself uses.
        [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(youtubeId(url)).toBe(expected);
        });
    }
});

describe("youtubeId — rejected (no false positives)", () => {
    const rejects = [
        "https://vimeo.com/123456789",
        "https://example.com/watch?v=dQw4w9WgXcQ",
        "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
        "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=tooShort", // not 11 chars
        "https://www.youtube.com/watch?v=waytoolongtobevalid", // >11 chars
        "https://www.youtube.com/", // no id
        "https://www.youtube.com/watch", // no v param
        "ftp://youtu.be/dQw4w9WgXcQ", // wrong protocol
        "not a url at all",
        "",
        "youtu.be/dQw4w9WgXcQ", // schemeless — never autolinked, and not a URL
    ];
    for (const url of rejects) {
        it(`${url || "<empty>"} should return null`, () => {
            expect(youtubeId(url)).toBeNull();
        });
    }
});

describe("recognizeProvider", () => {
    it("a YouTube URL should resolve to a youtube match with the id", () => {
        expect(recognizeProvider(`https://youtu.be/${ID}`)).toEqual({ kind: "youtube", id: ID });
    });
    it("a non-provider URL should resolve to null", () => {
        expect(recognizeProvider("https://example.com/page")).toBeNull();
    });
});

describe("URL builders", () => {
    it("thumbnail URL should point at i.ytimg.com with the id", () => {
        expect(youtubeThumbnailUrl(ID)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
    });
    it("embed URL should point at the privacy-mode nocookie host with the id", () => {
        expect(youtubeEmbedUrl(ID)).toBe(`https://www.youtube-nocookie.com/embed/${ID}`);
    });
});
