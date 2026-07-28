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

const KINDS: EmbedKind[] = ["youtube", "vimeo", "loom", "figma", "github"];

describe("canonicalEmbedUrl", () => {
    it("should build the provider's public page from kind + id", () => {
        expect(canonicalEmbedUrl("youtube", "dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(canonicalEmbedUrl("loom", "a".repeat(32))).toBe(`https://www.loom.com/share/${"a".repeat(32)}`);
        expect(canonicalEmbedUrl("figma", "design/AbCdEf123456")).toBe("https://www.figma.com/design/AbCdEf123456");
        expect(canonicalEmbedUrl("github", "owner/repo/pull/42")).toBe("https://github.com/owner/repo/pull/42");
    });

    it("every canonical URL should re-recognize as its own kind and id", () => {
        // The extension rebuilds request URLs from recognize → canonical; the
        // pair must round-trip or a valid card could fail its metadata lookup.
        const ids: Record<EmbedKind, string> = {
            youtube: "dQw4w9WgXcQ",
            vimeo: "1084537",
            loom: "0123456789abcdef0123456789abcdef",
            figma: "design/AbCdEf123456",
            github: "owner/repo",
        };
        for (const kind of KINDS) {
            const match = recognizeEmbed(canonicalEmbedUrl(kind, ids[kind]));
            expect(match).toEqual({ kind, id: ids[kind] });
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

    it("a kind with no metadata source should return null", () => {
        expect(oembedEndpoint("github", canonicalEmbedUrl("github", "owner/repo"))).toBeNull();
    });

    it("every endpoint's host should equal its OEMBED_HOSTS pin", () => {
        // The extension's allowlist check compares against OEMBED_HOSTS; an
        // endpoint drifting to another host must fail loudly here, not there.
        for (const kind of KINDS) {
            const endpoint = oembedEndpoint(kind, canonicalEmbedUrl(kind, "x"));
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
