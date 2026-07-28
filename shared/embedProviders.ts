/**
 * shared/embedProviders.ts
 *
 * The pure core of URL-embed provider recognition (MAR-56/MAR-186), shared by
 * BOTH sides: the webview walks bare links through it to decide what cards,
 * and the extension re-runs it to validate a metadata request and derive the
 * oEmbed endpoint — the incoming URL only ever SELECTS a provider; every byte
 * of an outgoing request URL is rebuilt here from validated parts.
 *
 * No DOM, no network, no VS Code API — id extraction is pure string work,
 * unit-testable on its own, matching narrowly and rejecting everything else
 * (the discipline of pasteLink's detectPastedLinkTarget). Presentation
 * capabilities (labels, aspect, facade shape) stay webview-side in
 * webview/utils/embedProviders.ts, which re-exports this core.
 *
 * This module is also the single source for the provider HOST allowlists: the
 * webview CSP's img-src/frame-src grants (src/webviewHtml.ts) and the
 * extension's oEmbed endpoints all read from here — adding a provider is one
 * extractor plus its rows here, with no hand-duplicated host list to forget.
 */

/** The providers this pass understands. Widen the union to add one. */
export type EmbedKind = "youtube" | "vimeo" | "loom" | "figma" | "github";

/** A recognized embed: the provider kind and its stable id. */
export interface EmbedMatch {
    kind: EmbedKind;
    /**
     * Provider-specific id. A YouTube/Loom video id; a Figma `type/fileKey`
     * composite; a GitHub `owner/repo[/pull|issues/N | /blob/ref/path…]` path.
     * Opaque outside this module (except githubCardParts, which re-parses it).
     */
    id: string;
}

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** A Loom video id is exactly 32 lowercase hex characters. */
const LOOM_ID = /^[0-9a-f]{32}$/;

/** A Figma file key: strictly alphanumeric, permissive on length. */
const FIGMA_KEY = /^[A-Za-z0-9]{10,64}$/;

/** Parse a URL string, returning null for anything malformed. */
function parseUrl(raw: string): URL | null {
    try {
        return new URL(raw.trim());
    } catch {
        return null;
    }
}

/**
 * The canonical host of an http(s) URL: lowercased, `www.` stripped — or null
 * for a non-http(s) or malformed URL. Callers compare with strict `===`, which
 * is what defeats lookalike hosts (`github.com.evil.com` keeps its suffix).
 */
function canonicalHost(url: URL): string | null {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
    }
    return url.hostname.toLowerCase().replace(/^www\./, "");
}

/** Classify a host as a YouTube watch host, the youtu.be short host, or neither. */
function youtubeHostKind(hostname: string): "long" | "short" | null {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
        return "short";
    }
    if (
        host === "youtube.com" ||
        host === "m.youtube.com" ||
        host === "music.youtube.com" ||
        // The privacy-enhanced host the player itself uses; a pasted
        // youtube-nocookie link should get a card like any other YouTube link.
        host === "youtube-nocookie.com"
    ) {
        return "long";
    }
    return null;
}

/**
 * Extract the 11-char video id from any recognized YouTube URL shape, or null.
 * Handles `youtube.com/watch?v=ID` (with any extra query params), `youtu.be/ID`,
 * `youtube.com/embed/ID`, `youtube.com/shorts/ID`, `youtube.com/v/ID`, and the
 * `m.`/`music.`/`www.` host variants. A non-YouTube host, a wrong protocol, or a
 * path/param that doesn't yield a valid id all return null (no false positives).
 * Pure string work — exported for direct unit testing.
 */
export function youtubeId(raw: string): string | null {
    const url = parseUrl(raw);
    if (!url) {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
    }
    const kind = youtubeHostKind(url.hostname);
    if (!kind) {
        return null;
    }

    let id: string | null = null;
    if (kind === "short") {
        // youtu.be/<id> — the id is the first path segment.
        id = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else {
        const segments = url.pathname.split("/").filter(Boolean);
        const [first, second] = segments;
        if (first === "watch") {
            id = url.searchParams.get("v");
        } else if (first === "embed" || first === "shorts" || first === "v") {
            id = second ?? null;
        } else if (url.searchParams.has("v")) {
            id = url.searchParams.get("v");
        }
    }

    return id && YOUTUBE_ID.test(id) ? id : null;
}

/** Build the static facade thumbnail URL for a YouTube id (host: i.ytimg.com). */
export function youtubeThumbnailUrl(id: string): string {
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** Build the privacy-mode player URL for a YouTube id (host: youtube-nocookie.com). */
export function youtubeEmbedUrl(id: string): string {
    return `https://www.youtube-nocookie.com/embed/${id}`;
}

/** A Vimeo video id: all digits (real ids run ~5–10; bounded for sanity). */
const VIMEO_ID = /^\d{4,12}$/;

/**
 * Extract the numeric video id from a Vimeo URL, or null. Accepts the
 * canonical `vimeo.com/<id>` and the player host `player.vimeo.com/video/<id>`
 * (any query params ignored). Channels, groups, showcases, and every other
 * path shape deliberately stay plain links. Exported for unit testing.
 */
export function vimeoId(raw: string): string | null {
    const url = parseUrl(raw);
    if (!url) {
        return null;
    }
    const host = canonicalHost(url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (host === "vimeo.com") {
        const [first, ...rest] = segments;
        return first !== undefined && rest.length === 0 && VIMEO_ID.test(first) ? first : null;
    }
    if (host === "player.vimeo.com") {
        const [first, second] = segments;
        return first === "video" && second !== undefined && VIMEO_ID.test(second) ? second : null;
    }
    return null;
}

/**
 * Build the player URL for a Vimeo id (host: player.vimeo.com). `dnt=1` is
 * Vimeo's do-not-track flag — no session cookies, no analytics from the frame
 * (the youtube-nocookie of this provider; MAR-186's directive).
 */
export function vimeoEmbedUrl(id: string): string {
    return `https://player.vimeo.com/video/${id}?dnt=1`;
}

/**
 * Extract the 32-hex video id from a Loom share or embed URL, or null.
 * Accepts `loom.com/share/<id>` and `loom.com/embed/<id>` (any query params,
 * e.g. the `?sid=` share links carry, are ignored). Exported for unit testing.
 */
export function loomId(raw: string): string | null {
    const url = parseUrl(raw);
    if (!url) {
        return null;
    }
    const host = canonicalHost(url);
    if (host !== "loom.com") {
        return null;
    }
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (first !== "share" && first !== "embed") {
        return null;
    }
    return second && LOOM_ID.test(second) ? second : null;
}

/** Build the player URL for a Loom id (host: www.loom.com). */
export function loomEmbedUrl(id: string): string {
    return `https://www.loom.com/embed/${id}`;
}

/** The Figma path types Embed Kit 2.0 serves. Legacy `file` normalizes to `design`. */
const FIGMA_TYPES = new Set(["design", "board", "slides", "deck", "proto", "file"]);

/**
 * Extract a `type/fileKey` composite id from a Figma URL, or null. Accepts
 * `figma.com/{design|board|slides|deck|proto|file}/<key>[/<title-slug>…]`;
 * the legacy `file` type is normalized to `design` here so the id always
 * targets a valid Embed Kit 2.0 path. Exported for unit testing.
 */
export function figmaId(raw: string): string | null {
    const url = parseUrl(raw);
    if (!url) {
        return null;
    }
    const host = canonicalHost(url);
    if (host !== "figma.com") {
        return null;
    }
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (!first || !FIGMA_TYPES.has(first) || !second || !FIGMA_KEY.test(second)) {
        return null;
    }
    const type = first === "file" ? "design" : first;
    return `${type}/${second}`;
}

/** Build the Embed Kit 2.0 iframe URL for a Figma `type/key` composite id. */
export function figmaEmbedUrl(id: string): string {
    return `https://embed.figma.com/${id}?embed-host=birta-writer`;
}

/** GitHub path segments: the conservative charset of owners/repos/refs. */
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * First-path-segment names that are GitHub product pages, not user accounts.
 * A miss here yields a harmless view-only card (caret still reveals the URL);
 * the strict shape matching below is the primary defense.
 */
const GITHUB_RESERVED = new Set([
    "about", "account", "apps", "codespaces", "collections", "contact",
    "customer-stories", "dashboard", "enterprise", "explore", "features",
    "issues", "join", "login", "marketplace", "new", "notifications", "orgs",
    "organizations", "pricing", "pulls", "readme", "search", "security",
    "settings", "site", "sponsors", "stars", "team", "topics", "trending",
]);

/**
 * Extract a joined-path id from a recognized GitHub URL, or null. Accepted
 * shapes only: `owner/repo`, `owner/repo/pull/N`, `owner/repo/issues/N`, and
 * `owner/repo/blob/ref/path…`. Everything else — reserved product pages,
 * `gist.github.com`, `/tree/…`, releases — returns null. Exported for testing.
 */
export function githubId(raw: string): string | null {
    const url = parseUrl(raw);
    if (!url) {
        return null;
    }
    const host = canonicalHost(url);
    if (host !== "github.com") {
        return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    // The `.`/`..` rejection is belt-and-braces: `new URL()` normalizes dot
    // segments out of pathname before we split, so none should ever arrive —
    // but the extractor must be safe on its own terms, not by relying on that
    // upstream side effect (adversarial-review finding, 2026-07-24).
    if (
        segments.length < 2 ||
        !segments.every((s) => GITHUB_SEGMENT.test(s) && !/^\.\.?$/.test(s))
    ) {
        return null;
    }
    const [owner, repo, section, fourth] = segments;
    if (GITHUB_RESERVED.has(owner.toLowerCase())) {
        return null;
    }
    if (segments.length === 2) {
        return `${owner}/${repo}`;
    }
    if (
        segments.length === 4 &&
        (section === "pull" || section === "issues") &&
        /^\d+$/.test(fourth)
    ) {
        return segments.join("/");
    }
    if (segments.length >= 5 && section === "blob") {
        return segments.join("/");
    }
    return null;
}

/** The display pieces of a GitHub card, derived from a githubId composite. */
export interface GithubCardParts {
    owner: string;
    repo: string;
    kind: "repo" | "pull" | "issue" | "blob";
    /** PR / issue number, when kind is pull or issue. */
    number?: string;
    /** File path (without the ref), when kind is blob. */
    path?: string;
}

/** Re-parse a githubId composite into its display pieces. Pure; unit-tested. */
export function githubCardParts(id: string): GithubCardParts {
    const [owner, repo, section, fourth, ...rest] = id.split("/");
    if (section === "pull") {
        return { owner, repo, kind: "pull", number: fourth };
    }
    if (section === "issues") {
        return { owner, repo, kind: "issue", number: fourth };
    }
    if (section === "blob") {
        return { owner, repo, kind: "blob", path: rest.join("/") };
    }
    return { owner, repo, kind: "repo" };
}

/** Per-kind id extractors, in recognition priority order. */
const EXTRACTORS: readonly { kind: EmbedKind; extract: (url: string) => string | null }[] = [
    { kind: "youtube", extract: youtubeId },
    { kind: "vimeo", extract: vimeoId },
    { kind: "loom", extract: loomId },
    { kind: "figma", extract: figmaId },
    { kind: "github", extract: githubId },
];

/**
 * Recognize which provider (if any) a bare link href points at. Returns the
 * provider kind and stable id, or null when no provider matches. Pure and
 * deterministic; both sides call this (the webview via its presentation
 * table's re-export, the extension to validate a metadata request).
 */
export function recognizeEmbed(url: string): EmbedMatch | null {
    for (const { kind, extract } of EXTRACTORS) {
        const id = extract(url);
        if (id) {
            return { kind, id };
        }
    }
    return null;
}

/**
 * The provider's canonical public page for an id — the external-open target,
 * and the URL an oEmbed endpoint is asked about (never the raw user string).
 */
export function canonicalEmbedUrl(kind: EmbedKind, id: string): string {
    switch (kind) {
        case "youtube": return `https://www.youtube.com/watch?v=${id}`;
        case "vimeo": return `https://vimeo.com/${id}`;
        case "loom": return `https://www.loom.com/share/${id}`;
        case "figma": return `https://www.figma.com/${id}`;
        case "github": return `https://github.com/${id}`;
    }
}

/**
 * The pinned host each provider's oEmbed endpoint lives on — provider-own
 * endpoints ONLY, never an aggregator (NETWORK_POSTURE invariant 5). GitHub
 * has no entry: its card is URL-derived and fetches nothing.
 */
export const OEMBED_HOSTS: Partial<Record<EmbedKind, string>> = {
    youtube: "www.youtube.com",
    vimeo: "vimeo.com",
    loom: "www.loom.com",
    figma: "www.figma.com",
};

/**
 * The provider-own oEmbed endpoint asking about `canonicalUrl`, or null for a
 * kind with no metadata source. The endpoint host must (and does — pinned by
 * test) equal OEMBED_HOSTS[kind].
 */
export function oembedEndpoint(kind: EmbedKind, canonicalUrl: string): string | null {
    const encoded = encodeURIComponent(canonicalUrl);
    switch (kind) {
        case "youtube": return `https://www.youtube.com/oembed?format=json&url=${encoded}`;
        case "vimeo": return `https://vimeo.com/api/oembed.json?url=${encoded}`;
        case "loom": return `https://www.loom.com/v1/oembed?url=${encoded}`;
        case "figma": return `https://www.figma.com/api/oembed?url=${encoded}`;
        case "github": return null;
    }
}

/**
 * The CSP grants the embed feature needs, consumed by src/webviewHtml.ts.
 * Exact hosts, no wildcards; emitted unconditionally there (CSP is fixed at
 * panel load — see the MAR-183 note at the use site). A grant PERMITS a
 * request; the offline-by-default guarantee lives in the gated code paths.
 */
export const EMBED_CSP_IMG_HOSTS: readonly string[] = ["https://i.ytimg.com"];
export const EMBED_CSP_FRAME_HOSTS: readonly string[] = [
    "https://www.youtube-nocookie.com",
    "https://player.vimeo.com",
    "https://www.loom.com",
    "https://embed.figma.com",
    // embed.figma.com 302-redirects into www.figma.com (the embed
    // interstitial, then the viewer itself). Without this grant the redirect
    // is CSP-blocked and every Figma embed rendered as a silent blank frame
    // (diagnosed 2026-07-27 — the frame chain ends at www.figma.com/design/…
    // with the live canvas).
    "https://www.figma.com",
];
