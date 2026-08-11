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
    googleDocsEmbedUrl,
    googleDocsPubId,
    googleDriveId,
    googleDrivePreviewUrl,
    googleFileCardParts,
    googleFileId,
    googleSheetsEmbedUrl,
    googleSheetsPubId,
    googleSlidesEmbedUrl,
    googleSlidesPubId,
    codepenEmbedUrl,
    codepenId,
    codesandboxEmbedUrl,
    codesandboxId,
    linearCardParts,
    linearId,
    miroEmbedUrl,
    miroId,
    stackblitzEmbedUrl,
    stackblitzId,
    vimeoId,
    vimeoEmbedUrl,
} from "../utils/embedProviders";

const ID = "dQw4w9WgXcQ"; // a real-shaped 11-char id
const LOOM = "0123456789abcdef0123456789abcdef"; // a real-shaped 32-hex id
const FKEY = "BAZsTPbh6W1r66Bdo9xkQp"; // a real-shaped alphanumeric file key
const GFILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz01234"; // a real-shaped 33-char Drive/Docs file id
const GPUB = "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp"; // a real-shaped publish-to-web token
const MIRO = "uXjVO5X2CWo="; // a real-shaped Miro board id (trailing =)

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
        ["https://github.com/some-owner/a-hyphenated-repo", "some-owner/a-hyphenated-repo"],
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

describe("googleDriveId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        [`https://drive.google.com/file/d/${GFILE}/view`, GFILE],
        [`https://drive.google.com/file/d/${GFILE}/view?usp=sharing`, GFILE],
        [`https://drive.google.com/file/d/${GFILE}/preview`, GFILE],
        [`https://drive.google.com/file/d/${GFILE}/edit`, GFILE],
        [`https://drive.google.com/file/d/${GFILE}`, GFILE],
        [`http://drive.google.com/file/d/${GFILE}/view`, GFILE],
        // The legacy open?id= form still circulates in old documents.
        [`https://drive.google.com/open?id=${GFILE}`, GFILE],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(googleDriveId(url)).toBe(expected);
        });
    }
});

describe("googleDriveId — rejected (no false positives)", () => {
    const rejects = [
        `https://drive.google.com/drive/folders/${GFILE}`, // a folder, not a file
        `https://drive.google.com/file/d/${GFILE}/share`, // unknown tail
        "https://drive.google.com/file/d/short/view", // under the id floor
        `https://drive.google.com.evil.com/file/d/${GFILE}/view`, // lookalike host
        `https://docs.google.com/file/d/${GFILE}/view`, // wrong host for this shape
        "https://drive.google.com/open?id=short",
        `ftp://drive.google.com/file/d/${GFILE}/view`, // wrong protocol
        "https://drive.google.com/", // nothing
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(googleDriveId(url)).toBeNull();
        });
    }
});

describe("google publish-to-web ids — the sharing-mode split", () => {
    it("a published Doc /pub URL should extract the token", () => {
        expect(googleDocsPubId(`https://docs.google.com/document/d/e/${GPUB}/pub`)).toBe(GPUB);
        expect(googleDocsPubId(`https://docs.google.com/document/d/e/${GPUB}/pub?embedded=true`)).toBe(GPUB);
    });
    it("a published Slides URL should extract from both /pub and /embed", () => {
        expect(googleSlidesPubId(`https://docs.google.com/presentation/d/e/${GPUB}/pub?start=false`)).toBe(GPUB);
        expect(googleSlidesPubId(`https://docs.google.com/presentation/d/e/${GPUB}/embed`)).toBe(GPUB);
    });
    it("a published Sheets /pubhtml URL should extract the token", () => {
        expect(googleSheetsPubId(`https://docs.google.com/spreadsheets/d/e/${GPUB}/pubhtml`)).toBe(GPUB);
        expect(googleSheetsPubId(`https://docs.google.com/spreadsheets/d/e/${GPUB}/pubhtml?widget=true&headers=false`)).toBe(GPUB);
    });
    it("cross-product and wrong-tail shapes should return null", () => {
        // Each product only accepts its own tails — no doomed iframes.
        expect(googleDocsPubId(`https://docs.google.com/presentation/d/e/${GPUB}/pub`)).toBeNull();
        expect(googleDocsPubId(`https://docs.google.com/document/d/e/${GPUB}/pubhtml`)).toBeNull();
        expect(googleDocsPubId(`https://docs.google.com/document/d/e/${GPUB}`)).toBeNull();
        expect(googleSheetsPubId(`https://docs.google.com/spreadsheets/d/e/${GPUB}/pub`)).toBeNull();
        expect(googleSlidesPubId(`https://docs.google.com/presentation/d/e/${GPUB}/pubhtml`)).toBeNull();
        // A short token is not a publish-to-web id.
        expect(googleDocsPubId("https://docs.google.com/document/d/e/short/pub")).toBeNull();
        // An ordinary edit URL is NOT a published one (that is the whole split).
        expect(googleDocsPubId(`https://docs.google.com/document/d/${GFILE}/edit`)).toBeNull();
        expect(googleDocsPubId(`https://docs.google.com.evil.com/document/d/e/${GPUB}/pub`)).toBeNull();
    });
});

describe("googleFileId — ordinary Docs/Slides/Sheets URLs (the Rung 0 side)", () => {
    const cases: Array<[string, string]> = [
        [`https://docs.google.com/document/d/${GFILE}/edit`, `document/${GFILE}`],
        [`https://docs.google.com/document/d/${GFILE}/edit?usp=sharing&tab=t.0`, `document/${GFILE}`],
        [`https://docs.google.com/document/d/${GFILE}`, `document/${GFILE}`],
        [`https://docs.google.com/presentation/d/${GFILE}/edit`, `presentation/${GFILE}`],
        [`https://docs.google.com/spreadsheets/d/${GFILE}/view`, `spreadsheets/${GFILE}`],
        [`https://docs.google.com/document/d/${GFILE}/preview`, `document/${GFILE}`],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(googleFileId(url)).toBe(expected);
        });
    }

    const rejects = [
        `https://docs.google.com/document/d/e/${GPUB}/pub`, // the published shape is another kind
        `https://docs.google.com/forms/d/${GFILE}/edit`, // unknown product
        `https://docs.google.com/document/${GFILE}`, // missing /d/
        `https://docs.google.com/document/d/${GFILE}/copy`, // unknown tail
        "https://docs.google.com/document/d/short/edit", // under the id floor
        `https://docs.google.com.evil.com/document/d/${GFILE}/edit`, // lookalike host
        "https://docs.google.com/", // nothing
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(googleFileId(url)).toBeNull();
        });
    }
});

describe("googleFileCardParts", () => {
    it("should split the composite into product and file id", () => {
        expect(googleFileCardParts(`document/${GFILE}`)).toEqual({ product: "document", fileId: GFILE });
        expect(googleFileCardParts(`spreadsheets/${GFILE}`)).toEqual({ product: "spreadsheets", fileId: GFILE });
    });
});

describe("miroId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        [`https://miro.com/app/board/${MIRO}/`, MIRO],
        [`https://miro.com/app/board/${MIRO}`, MIRO],
        [`https://www.miro.com/app/board/${MIRO}/`, MIRO],
        [`https://miro.com/app/board/${MIRO}/?share_link_id=123`, MIRO],
        // A pasted live-embed URL is the same board.
        [`https://miro.com/app/live-embed/${MIRO}/`, MIRO],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(miroId(url)).toBe(expected);
        });
    }

    const rejects = [
        "https://miro.com/app/dashboard/", // not a board
        `https://miro.com/board/${MIRO}/`, // missing /app/
        "https://miro.com/app/board/", // no id
        `https://miro.com/app/board/${MIRO}/extra`, // extra segment
        `https://miro.com.evil.com/app/board/${MIRO}/`, // lookalike host
        "https://miro.com/app/board/ab=/", // under the id floor
        "https://miro.com/templates/kanban/", // marketing page
        `ftp://miro.com/app/board/${MIRO}/`, // wrong protocol
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(miroId(url)).toBeNull();
        });
    }
});

describe("linearId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        ["https://linear.app/birta/issue/MAR-186", "birta/issue/MAR-186"],
        [
            "https://linear.app/birta/issue/MAR-186/embed-provider-roadmap",
            "birta/issue/MAR-186/embed-provider-roadmap",
        ],
        ["https://linear.app/birta/issue/MAR-186?comment=abc", "birta/issue/MAR-186"],
        ["http://linear.app/some-org/issue/AB2-7/x", "some-org/issue/AB2-7/x"],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(linearId(url)).toBe(expected);
        });
    }

    const rejects = [
        "https://linear.app/birta/project/some-project", // not an issue
        "https://linear.app/birta/project/ABC-12", // a key-shaped segment under the wrong section
        "https://linear.app/issue/MAR-186", // missing org
        "https://linear.app/birta/issue/MAR186", // malformed key
        "https://linear.app/birta/issue/-186", // key must start with a letter
        "https://linear.app/birta/issue/MAR-186/slug/extra", // too deep
        "https://linear.app.evil.com/birta/issue/MAR-186", // lookalike host
        "https://linear.app/", // nothing
        "ftp://linear.app/birta/issue/MAR-186", // wrong protocol
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(linearId(url)).toBeNull();
        });
    }
});

describe("linearCardParts", () => {
    it("should split the composite into org, key, and optional slug", () => {
        expect(linearCardParts("birta/issue/MAR-186")).toEqual({ org: "birta", key: "MAR-186" });
        expect(linearCardParts("birta/issue/MAR-186/embed-provider-roadmap")).toEqual({
            org: "birta",
            key: "MAR-186",
            slug: "embed-provider-roadmap",
        });
    });
});

describe("codepenId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        ["https://codepen.io/chriscoyier/pen/AbCdEf", "chriscoyier/AbCdEf"],
        ["https://www.codepen.io/chriscoyier/pen/AbCdEf", "chriscoyier/AbCdEf"],
        // The pen's view variants and its embed URL name the same pen.
        ["https://codepen.io/chriscoyier/full/AbCdEf", "chriscoyier/AbCdEf"],
        ["https://codepen.io/chriscoyier/details/AbCdEf", "chriscoyier/AbCdEf"],
        ["https://codepen.io/chriscoyier/embed/AbCdEf?default-tab=result", "chriscoyier/AbCdEf"],
        // Team pens keep their team/ prefix in the id (CodePen's own URLs do).
        ["https://codepen.io/team/codepen/pen/PNaGbb", "team/codepen/PNaGbb"],
        ["https://codepen.io/team/codepen/embed/PNaGbb", "team/codepen/PNaGbb"],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(codepenId(url)).toBe(expected);
        });
    }

    const rejects = [
        "https://codepen.io/chriscoyier", // a profile, not a pen
        "https://codepen.io/chriscoyier/pens/public", // pen LIST, not a pen
        "https://codepen.io/chriscoyier/pen/", // no slug
        "https://codepen.io/chriscoyier/pen/AbCdEf/extra", // extra segment
        "https://codepen.io/team/codepen/pen/AbCdEf/extra", // extra team segment
        "https://codepen.io/team/codepen/pens/public", // team pen LIST
        "https://codepen.io.evil.com/chriscoyier/pen/AbCdEf", // lookalike host
        "https://codepen.io/chris%20coyier/pen/AbCdEf", // charset violation
        "ftp://codepen.io/chriscoyier/pen/AbCdEf", // wrong protocol
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(codepenId(url)).toBeNull();
        });
    }
});

describe("codesandboxId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        // Legacy short form, current /p/sandbox form, and the embed shape.
        ["https://codesandbox.io/s/new-react-sandbox-abc123", "new-react-sandbox-abc123"],
        ["https://codesandbox.io/p/sandbox/new-react-sandbox-abc123", "new-react-sandbox-abc123"],
        ["https://codesandbox.io/embed/abc123", "abc123"],
        ["https://www.codesandbox.io/s/abc123?file=/src/index.js", "abc123"],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(codesandboxId(url)).toBe(expected);
        });
    }

    const rejects = [
        "https://codesandbox.io/", // no path
        "https://codesandbox.io/s/", // no id
        "https://codesandbox.io/s/abc123/extra", // extra segment
        "https://codesandbox.io/p/abc123", // /p/ without /sandbox/
        "https://codesandbox.io/dashboard", // app page
        "https://codesandbox.io.evil.com/s/abc123", // lookalike host
        "ftp://codesandbox.io/s/abc123", // wrong protocol
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(codesandboxId(url)).toBeNull();
        });
    }
});

describe("stackblitzId — recognized URL forms", () => {
    const cases: Array<[string, string]> = [
        ["https://stackblitz.com/edit/vitejs-vite-abc123", "vitejs-vite-abc123"],
        ["https://www.stackblitz.com/edit/vitejs-vite-abc123", "vitejs-vite-abc123"],
        // ?file= is the editor's own state; the project id is the same.
        ["https://stackblitz.com/edit/vitejs-vite-abc123?file=src%2Fmain.ts", "vitejs-vite-abc123"],
    ];
    for (const [url, expected] of cases) {
        it(`${url} should extract ${expected}`, () => {
            expect(stackblitzId(url)).toBe(expected);
        });
    }

    const rejects = [
        "https://stackblitz.com/", // no path
        "https://stackblitz.com/edit/", // no id
        "https://stackblitz.com/edit/abc/extra", // extra segment
        // A github-import URL names a repo, not a stable project — the GitHub
        // card does not own this shape either (host differs), so it stays plain.
        "https://stackblitz.com/github/owner/repo",
        "https://stackblitz.com.evil.com/edit/abc123", // lookalike host
        "ftp://stackblitz.com/edit/abc123", // wrong protocol
    ];
    for (const url of rejects) {
        it(`${url} should return null`, () => {
            expect(stackblitzId(url)).toBeNull();
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
    it("a Vimeo video URL should resolve to the vimeo provider", () => {
        expect(recognizeProvider("https://vimeo.com/76979871")).toEqual({ kind: "vimeo", id: "76979871" });
    });
    it("a Drive file URL should resolve to the googledrive provider", () => {
        expect(recognizeProvider(`https://drive.google.com/file/d/${GFILE}/view`)).toEqual({
            kind: "googledrive",
            id: GFILE,
        });
    });
    it("the Google sharing-mode split: published URLs card as players, edit URLs as the info card", () => {
        // The same document, two sharing modes, two DIFFERENT kinds — the
        // published form is framable, the ordinary form never is (MAR-186).
        expect(recognizeProvider(`https://docs.google.com/document/d/e/${GPUB}/pub`)).toEqual({
            kind: "googledocs",
            id: GPUB,
        });
        expect(recognizeProvider(`https://docs.google.com/presentation/d/e/${GPUB}/pub`)).toEqual({
            kind: "googleslides",
            id: GPUB,
        });
        expect(recognizeProvider(`https://docs.google.com/spreadsheets/d/e/${GPUB}/pubhtml`)).toEqual({
            kind: "googlesheets",
            id: GPUB,
        });
        expect(recognizeProvider(`https://docs.google.com/document/d/${GFILE}/edit`)).toEqual({
            kind: "googlefile",
            id: `document/${GFILE}`,
        });
    });
    it("a Miro board URL should resolve to the miro provider", () => {
        expect(recognizeProvider(`https://miro.com/app/board/${MIRO}/`)).toEqual({ kind: "miro", id: MIRO });
    });
    it("a Linear issue URL should resolve to the linear provider", () => {
        expect(recognizeProvider("https://linear.app/birta/issue/MAR-186/embed-provider-roadmap")).toEqual({
            kind: "linear",
            id: "birta/issue/MAR-186/embed-provider-roadmap",
        });
    });
});

describe("vimeoId", () => {
    it.each([
        ["https://vimeo.com/1084537", "1084537"],
        ["https://www.vimeo.com/76979871", "76979871"],
        ["http://vimeo.com/347119375", "347119375"],
        ["https://player.vimeo.com/video/1084537", "1084537"],
        ["https://player.vimeo.com/video/1084537?h=abc&dnt=1", "1084537"],
    ])("should accept %s", (url, id) => {
        expect(vimeoId(url)).toBe(id);
    });

    it.each([
        "https://vimeo.com/channels/staffpicks/1084537", // non-bare shape
        "https://vimeo.com/1084537/settings", // trailing segment
        "https://vimeo.com/user12345678", // a profile, not a video
        "https://vimeo.com/123", // shorter than any real id
        "https://vimeo.com.evil.com/1084537", // lookalike host
        "https://player.vimeo.com/1084537", // missing /video/
        "ftp://vimeo.com/1084537", // wrong scheme
        "https://vimeo.com/", // no id
    ])("should reject %s", (url) => {
        expect(vimeoId(url)).toBeNull();
    });

    it("the player URL should carry Vimeo's do-not-track flag", () => {
        expect(vimeoEmbedUrl("1084537")).toBe("https://player.vimeo.com/video/1084537?dnt=1");
    });
});

describe("providerFor", () => {
    it("exactly the info-card providers should be usable without the network", () => {
        // Rung 0 of the render ladder: URL-derived cards that fetch nothing.
        for (const kind of ["github", "googlefile", "linear"] as const) {
            expect(providerFor(kind).needsNetwork, kind).toBe(false);
        }
        for (const kind of [
            "youtube", "vimeo", "loom", "figma",
            "googledrive", "googledocs", "googleslides", "googlesheets", "miro",
            "codepen", "codesandbox", "stackblitz",
        ] as const) {
            expect(providerFor(kind).needsNetwork, kind).toBe(true);
        }
    });
    it("card capabilities should encode the three facade shapes", () => {
        // Thumbnail facade: YouTube alone fetches a static thumbnail.
        expect(providerFor("youtube").thumbnailUrl).toBeDefined();
        // Branded facades: a player but no thumbnail.
        for (const kind of [
            "loom", "figma", "googledrive", "googledocs", "googleslides", "googlesheets", "miro",
            "codepen", "codesandbox", "stackblitz",
        ] as const) {
            expect(providerFor(kind).thumbnailUrl, kind).toBeUndefined();
            expect(providerFor(kind).playerUrl, kind).toBeDefined();
        }
        // Info cards: no player URL at all, so no code path to an iframe.
        for (const kind of ["github", "googlefile", "linear"] as const) {
            expect(providerFor(kind).playerUrl, kind).toBeUndefined();
            expect(providerFor(kind).aspect, kind).toBeUndefined();
        }
    });
    it("the sign-in hint should ride exactly the auth-wallable canvas providers", () => {
        // A blank video frame is an error; a blank Figma/Google/Miro frame is
        // routinely an auth wall the sandbox blocks by design — those get the
        // persistent open-externally hint.
        for (const kind of [
            "figma", "googledrive", "googledocs", "googleslides", "googlesheets", "miro",
            // A private pen/sandbox/project loads a legitimate frame showing
            // the provider's own locked state — same hint, same way out.
            "codepen", "codesandbox", "stackblitz",
        ] as const) {
            expect(providerFor(kind).mayNeedSignIn, kind).toBe(true);
        }
        for (const kind of ["youtube", "vimeo", "loom", "github", "googlefile", "linear"] as const) {
            expect(providerFor(kind).mayNeedSignIn, kind).toBeUndefined();
        }
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
    it("google embed URLs should target the endpoints each sharing mode supports", () => {
        // The exact Rung 2 endpoints from MAR-186's sharing-mode split.
        expect(googleDrivePreviewUrl(GFILE)).toBe(`https://drive.google.com/file/d/${GFILE}/preview`);
        expect(googleDocsEmbedUrl(GPUB)).toBe(`https://docs.google.com/document/d/e/${GPUB}/pub?embedded=true`);
        expect(googleSlidesEmbedUrl(GPUB)).toBe(`https://docs.google.com/presentation/d/e/${GPUB}/embed`);
        expect(googleSheetsEmbedUrl(GPUB)).toBe(`https://docs.google.com/spreadsheets/d/e/${GPUB}/pubhtml?widget=true`);
    });
    it("miro embed URL should target the login-free live-embed endpoint", () => {
        expect(miroEmbedUrl(MIRO)).toBe(`https://miro.com/app/live-embed/${MIRO}/`);
    });
    it("playground embed URLs should target each provider's embed endpoint", () => {
        expect(codepenEmbedUrl("chriscoyier/AbCdEf")).toBe(
            "https://codepen.io/chriscoyier/embed/AbCdEf?default-tab=result",
        );
        expect(codepenEmbedUrl("team/codepen/PNaGbb")).toBe(
            "https://codepen.io/team/codepen/embed/PNaGbb?default-tab=result",
        );
        expect(codesandboxEmbedUrl("abc123")).toBe("https://codesandbox.io/embed/abc123");
        expect(stackblitzEmbedUrl("vitejs-vite-abc123")).toBe(
            "https://stackblitz.com/edit/vitejs-vite-abc123?embed=1",
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
        expect(providerFor("googledrive").externalUrl(GFILE)).toBe(
            `https://drive.google.com/file/d/${GFILE}/view`,
        );
        // The googlefile canonical rebuilds the /d/ joint from the composite.
        expect(providerFor("googlefile").externalUrl(`document/${GFILE}`)).toBe(
            `https://docs.google.com/document/d/${GFILE}/edit`,
        );
        expect(providerFor("miro").externalUrl(MIRO)).toBe(`https://miro.com/app/board/${MIRO}/`);
        expect(providerFor("linear").externalUrl("birta/issue/MAR-186")).toBe(
            "https://linear.app/birta/issue/MAR-186",
        );
    });
});
