/**
 * Provider recognition truth table (MAR-56, extended for MAR-186). Pure string
 * work — the URL forms that must resolve to a provider id, and the many shapes
 * that must NOT (no false positives), mirroring pasteLink.test.ts's
 * detectPastedLinkTarget discipline.
 */
import { describe, it, expect } from "vitest";
import {
    recognizeProvider,
    providerFor,
    youtubeId,
    youtubeThumbnailUrl,
    youtubeEmbedUrl,
    loomId,
    loomEmbedUrl,
    figmaId,
    figmaEmbedUrl,
    githubId,
    githubCardParts,
} from "../utils/embedProviders";

const ID = "dQw4w9WgXcQ"; // a real-shaped 11-char id
const LOOM = "0123456789abcdef0123456789abcdef"; // a real-shaped 32-hex id
const FKEY = "BAZsTPbh6W1r66Bdo9xkQp"; // a real-shaped alphanumeric file key

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

describe("loomId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        [`https://www.loom.com/share/${LOOM}`, LOOM],
        [`https://loom.com/share/${LOOM}`, LOOM],
        [`http://www.loom.com/share/${LOOM}`, LOOM],
        [`https://www.loom.com/embed/${LOOM}`, LOOM],
        // The ?sid= param real share links carry must not matter.
        [`https://www.loom.com/share/${LOOM}?sid=1234abcd-12ab-34cd-56ef-1234567890ab`, LOOM],
        [`https://www.loom.com/share/${LOOM}?t=42`, LOOM],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(loomId(url)).toBe(expected);
        });
    }
});

describe("loomId — rejected (no false positives)", () => {
    const rejects = [
        `https://loom.com.evil.com/share/${LOOM}`,
        `https://gist.loom.com/share/${LOOM}`,
        `https://www.loom.com/share/${LOOM.slice(0, 31)}`, // 31 chars
        `https://www.loom.com/share/${LOOM}0`, // 33 chars
        `https://www.loom.com/share/${LOOM.toUpperCase()}`, // uppercase hex
        `https://www.loom.com/v/${LOOM}`, // unknown path shape
        `https://www.loom.com/${LOOM}`, // id without share/embed
        "https://www.loom.com/share/", // no id
        `ftp://www.loom.com/share/${LOOM}`, // wrong protocol
        "https://www.loom.com/", // nothing
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(loomId(url)).toBeNull();
        });
    }
});

describe("figmaId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        [`https://www.figma.com/design/${FKEY}/My-Design-File`, `design/${FKEY}`],
        [`https://figma.com/design/${FKEY}`, `design/${FKEY}`],
        [`https://www.figma.com/board/${FKEY}/Workshop-Notes`, `board/${FKEY}`],
        [`https://www.figma.com/slides/${FKEY}`, `slides/${FKEY}`],
        [`https://www.figma.com/deck/${FKEY}`, `deck/${FKEY}`],
        [`https://www.figma.com/proto/${FKEY}/Prototype?node-id=0-3`, `proto/${FKEY}`],
        // The legacy /file/ path must normalize to design so the Embed Kit
        // 2.0 URL built from the id is valid.
        [`https://www.figma.com/file/${FKEY}/Old-Style-Link`, `design/${FKEY}`],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(figmaId(url)).toBe(expected);
        });
    }
});

describe("figmaId — rejected (no false positives)", () => {
    const rejects = [
        `https://figma.com.evil.com/design/${FKEY}`,
        `https://www.figma.com/community/file/${FKEY}`, // unknown type segment
        `https://www.figma.com/${FKEY}`, // key without type
        "https://www.figma.com/design/key-with-hyphens", // bad charset
        "https://www.figma.com/design/under_scores0", // bad charset
        "https://www.figma.com/design/short", // under 10 chars
        "https://www.figma.com/design/", // no key
        "https://www.figma.com/", // nothing
        `ftp://www.figma.com/design/${FKEY}`, // wrong protocol
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(figmaId(url)).toBeNull();
        });
    }
});

describe("githubId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        ["https://github.com/harlanlewis/birta-writer", "harlanlewis/birta-writer"],
        ["https://github.com/harlanlewis/birta-writer/", "harlanlewis/birta-writer"],
        ["https://www.github.com/harlanlewis/birta-writer", "harlanlewis/birta-writer"],
        ["https://github.com/microsoft/vscode/pull/12345", "microsoft/vscode/pull/12345"],
        ["https://github.com/microsoft/vscode/issues/1", "microsoft/vscode/issues/1"],
        [
            "https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-main/main.ts",
            "microsoft/vscode/blob/main/src/vs/code/electron-main/main.ts",
        ],
        // Dots and hyphens are legal in owners, repos, refs, and paths.
        ["https://github.com/git-xing/md-wysiwyg-editor", "git-xing/md-wysiwyg-editor"],
        ["https://github.com/o/r.js/blob/v1.0/lib/a.min.js", "o/r.js/blob/v1.0/lib/a.min.js"],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(githubId(url)).toBe(expected);
        });
    }
});

describe("githubId — rejected (no false positives)", () => {
    const rejects = [
        "https://gist.github.com/user/abc123", // not github.com
        "https://github.com.evil.com/owner/repo",
        "https://github.com/settings/profile", // reserved first segment
        "https://github.com/orgs/anthropics/repositories", // reserved
        "https://github.com/features/copilot", // reserved
        "https://github.com/harlanlewis", // one segment — a profile, not a repo
        "https://github.com/owner/repo/tree/main/src", // tree is not an accepted shape
        "https://github.com/owner/repo/releases", // 3 segments, not pull/issues
        "https://github.com/owner/repo/pull/abc", // non-numeric PR
        "https://github.com/owner/repo/issues/", // no number
        "https://github.com/owner/repo/blob/main", // blob without a path
        "https://github.com/owner/repo%20name", // bad charset
        "ftp://github.com/owner/repo", // wrong protocol
        "https://github.com/", // nothing
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(githubId(url)).toBeNull();
        });
    }
});

describe("githubCardParts", () => {
    const cases: Array<[string, ReturnType<typeof githubCardParts>]> = [
        ["owner/repo", { owner: "owner", repo: "repo", kind: "repo" }],
        ["owner/repo/pull/42", { owner: "owner", repo: "repo", kind: "pull", number: "42" }],
        ["owner/repo/issues/7", { owner: "owner", repo: "repo", kind: "issue", number: "7" }],
        [
            "owner/repo/blob/main/src/deep/file.ts",
            { owner: "owner", repo: "repo", kind: "blob", path: "src/deep/file.ts" },
        ],
    ];
    for (const [id, expected] of cases) {
        it(`${id} should split into ${expected.kind} parts`, () => {
            expect(githubCardParts(id)).toEqual(expected);
        });
    }
});

describe("recognizeProvider", () => {
    it("a YouTube URL should resolve to a youtube match with the id", () => {
        expect(recognizeProvider(`https://youtu.be/${ID}`)).toEqual({ kind: "youtube", id: ID });
    });
    it("a Loom URL should resolve to a loom match with the id", () => {
        expect(recognizeProvider(`https://www.loom.com/share/${LOOM}`)).toEqual({
            kind: "loom",
            id: LOOM,
        });
    });
    it("a Figma URL should resolve to a figma match with the composite id", () => {
        expect(recognizeProvider(`https://www.figma.com/design/${FKEY}/Title`)).toEqual({
            kind: "figma",
            id: `design/${FKEY}`,
        });
    });
    it("a GitHub URL should resolve to a github match with the path id", () => {
        expect(recognizeProvider("https://github.com/owner/repo/pull/9")).toEqual({
            kind: "github",
            id: "owner/repo/pull/9",
        });
    });
    it("a non-provider URL should resolve to null", () => {
        expect(recognizeProvider("https://example.com/page")).toBeNull();
    });
    it("a Vimeo URL should resolve to null (provider not shipped)", () => {
        expect(recognizeProvider("https://vimeo.com/76979871")).toBeNull();
    });
});

describe("providerFor", () => {
    it("only github should be usable without the network", () => {
        expect(providerFor("github").needsNetwork).toBe(false);
        for (const kind of ["youtube", "loom", "figma"] as const) {
            expect(providerFor(kind).needsNetwork, kind).toBe(true);
        }
    });
    it("card capabilities should encode the three facade shapes", () => {
        // Thumbnail facade: YouTube alone fetches a static thumbnail.
        expect(providerFor("youtube").thumbnailUrl).toBeDefined();
        // Branded facades: a player but no thumbnail.
        for (const kind of ["loom", "figma"] as const) {
            expect(providerFor(kind).thumbnailUrl, kind).toBeUndefined();
            expect(providerFor(kind).playerUrl, kind).toBeDefined();
        }
        // Info card: GitHub never builds an iframe.
        expect(providerFor("github").playerUrl).toBeUndefined();
        expect(providerFor("github").aspect).toBeUndefined();
    });
});

describe("URL builders", () => {
    it("thumbnail URL should point at i.ytimg.com with the id", () => {
        expect(youtubeThumbnailUrl(ID)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
    });
    it("embed URL should point at the privacy-mode nocookie host with the id", () => {
        expect(youtubeEmbedUrl(ID)).toBe(`https://www.youtube-nocookie.com/embed/${ID}`);
    });
    it("loom embed URL should point at www.loom.com/embed with the id", () => {
        expect(loomEmbedUrl(LOOM)).toBe(`https://www.loom.com/embed/${LOOM}`);
    });
    it("figma embed URL should target embed.figma.com and carry the embed-host param", () => {
        expect(figmaEmbedUrl(`design/${FKEY}`)).toBe(
            `https://embed.figma.com/design/${FKEY}?embed-host=birta-writer`,
        );
    });
    it("external URLs should reconstruct a canonical page per provider", () => {
        expect(providerFor("youtube").externalUrl(ID)).toBe(
            `https://www.youtube.com/watch?v=${ID}`,
        );
        expect(providerFor("loom").externalUrl(LOOM)).toBe(`https://www.loom.com/share/${LOOM}`);
        expect(providerFor("figma").externalUrl(`design/${FKEY}`)).toBe(
            `https://www.figma.com/design/${FKEY}`,
        );
        expect(providerFor("github").externalUrl("o/r/pull/3")).toBe("https://github.com/o/r/pull/3");
    });
});
