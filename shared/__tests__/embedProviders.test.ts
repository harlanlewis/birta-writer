/**
 * The shared embed-provider core: canonical URLs, oEmbed endpoints, and the
 * host invariants the extension's fetch allowlist rests on. Recognition
 * itself (accept/reject per URL shape) is exhaustively pinned in
 * webview/__tests__/embedProviders.test.ts through the re-exports; these
 * tests cover what the extraction ADDED for the extension side.
 */
import { describe, it, expect } from "vitest";
import {
    canonicalEmbedUrl,
    EMBED_CSP_FRAME_HOSTS,
    EMBED_CSP_IMG_HOSTS,
    OEMBED_HOSTS,
    oembedEndpoint,
    recognizeEmbed,
    type EmbedKind,
} from "../embedProviders";

const KINDS: EmbedKind[] = [
    "youtube", "vimeo", "loom", "figma", "github",
    "googledrive", "googledocs", "googleslides", "googlesheets", "googlefile",
    "miro", "linear",
];

/** Real-shaped ids, one per kind — used by every round-trip loop below. */
const IDS: Record<EmbedKind, string> = {
    youtube: "dQw4w9WgXcQ",
    vimeo: "1084537",
    loom: "0123456789abcdef0123456789abcdef",
    figma: "design/AbCdEf123456",
    github: "owner/repo",
    googledrive: "1AbCdEfGhIjKlMnOpQrStUvWxYz01234",
    googledocs: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googleslides: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googlesheets: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googlefile: "document/1AbCdEfGhIjKlMnOpQrStUvWxYz01234",
    miro: "uXjVO5X2CWo=",
    linear: "birta/issue/MAR-186/embed-provider-roadmap",
};

describe("canonicalEmbedUrl", () => {
    it("should build the provider's public page from kind + id", () => {
        expect(canonicalEmbedUrl("youtube", "dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(canonicalEmbedUrl("loom", "a".repeat(32))).toBe(`https://www.loom.com/share/${"a".repeat(32)}`);
        expect(canonicalEmbedUrl("figma", "design/AbCdEf123456")).toBe("https://www.figma.com/design/AbCdEf123456");
        expect(canonicalEmbedUrl("github", "owner/repo/pull/42")).toBe("https://github.com/owner/repo/pull/42");
        expect(canonicalEmbedUrl("googledrive", IDS.googledrive)).toBe(
            `https://drive.google.com/file/d/${IDS.googledrive}/view`,
        );
        expect(canonicalEmbedUrl("googledocs", IDS.googledocs)).toBe(
            `https://docs.google.com/document/d/e/${IDS.googledocs}/pub`,
        );
        // The PAGE, not the widget: no ?widget/?embedded params on a canonical
        // URL — external-open must land on the provider's readable page.
        expect(canonicalEmbedUrl("googlesheets", IDS.googlesheets)).toBe(
            `https://docs.google.com/spreadsheets/d/e/${IDS.googlesheets}/pubhtml`,
        );
        expect(canonicalEmbedUrl("googlefile", "document/1AbCdEfGhIjKlMnOpQrStUvWxYz01234")).toBe(
            "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz01234/edit",
        );
        expect(canonicalEmbedUrl("miro", IDS.miro)).toBe(`https://miro.com/app/board/${IDS.miro}/`);
        expect(canonicalEmbedUrl("linear", IDS.linear)).toBe(`https://linear.app/${IDS.linear}`);
    });

    it("every canonical URL should re-recognize as its own kind and id", () => {
        // The extension rebuilds request URLs from recognize → canonical; the
        // pair must round-trip or a valid card could fail its metadata lookup.
        for (const kind of KINDS) {
            const match = recognizeEmbed(canonicalEmbedUrl(kind, IDS[kind]));
            expect(match).toEqual({ kind, id: IDS[kind] });
        }
    });
});

describe("oembedEndpoint", () => {
    it("should target the provider's own endpoint with the canonical URL encoded", () => {
        const url = canonicalEmbedUrl("youtube", "dQw4w9WgXcQ");
        expect(oembedEndpoint("youtube", url)).toBe(
            `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
        );
        const loomUrl = canonicalEmbedUrl("loom", "f".repeat(32));
        expect(oembedEndpoint("loom", loomUrl)).toBe(
            `https://www.loom.com/v1/oembed?url=${encodeURIComponent(loomUrl)}`,
        );
        const figmaUrl = canonicalEmbedUrl("figma", "design/AbCdEf123456");
        expect(oembedEndpoint("figma", figmaUrl)).toBe(
            `https://www.figma.com/api/oembed?url=${encodeURIComponent(figmaUrl)}`,
        );
    });

    it("miro should target its provider-own oEmbed endpoint", () => {
        const url = canonicalEmbedUrl("miro", IDS.miro);
        expect(oembedEndpoint("miro", url)).toBe(
            `https://miro.com/api/v1/oembed?url=${encodeURIComponent(url)}`,
        );
    });

    it("kinds with no metadata source should return null", () => {
        // GitHub/Linear/googlefile cards are URL-derived and fetch nothing;
        // Google exposes no oEmbed for Docs/Slides/Sheets/Drive.
        for (const kind of [
            "github", "googledrive", "googledocs", "googleslides", "googlesheets", "googlefile", "linear",
        ] as const) {
            expect(oembedEndpoint(kind, canonicalEmbedUrl(kind, IDS[kind])), kind).toBeNull();
        }
    });

    it("every endpoint's host should equal its OEMBED_HOSTS pin", () => {
        // The extension's allowlist check compares against OEMBED_HOSTS; an
        // endpoint drifting to another host must fail loudly here, not there.
        for (const kind of KINDS) {
            const endpoint = oembedEndpoint(kind, canonicalEmbedUrl(kind, IDS[kind]));
            const pinned = OEMBED_HOSTS[kind];
            if (endpoint === null) {
                expect(pinned).toBeUndefined();
            } else {
                expect(new URL(endpoint).hostname).toBe(pinned);
                expect(new URL(endpoint).protocol).toBe("https:");
            }
        }
    });
});

describe("CSP host lists", () => {
    it("should be exact https origins with no wildcards", () => {
        for (const host of [...EMBED_CSP_IMG_HOSTS, ...EMBED_CSP_FRAME_HOSTS]) {
            expect(host.startsWith("https://")).toBe(true);
            expect(host.includes("*")).toBe(false);
            // A full origin, parseable, with no path.
            expect(new URL(host).pathname).toBe("/");
        }
    });
});
