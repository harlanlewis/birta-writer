/**
 * webview/utils/embedProviders.ts
 *
 * Pure URL → embed-provider recognition (MAR-56, generalized in MAR-186). Given
 * the href of a bare autolink, decide whether it points at a supported provider
 * and, if so, extract the stable id needed to render a card. No DOM, no network —
 * id extraction is pure string work, so the whole surface is unit-testable and
 * shares the discipline of pasteLink.ts's detectPastedLinkTarget /
 * calc.ts's detectCalcExpression: match narrowly, reject everything else.
 *
 * PROVIDERS is the single extension seam: each row declares the provider's id
 * extraction and its presentation capabilities (thumbnail, player iframe,
 * aspect, labels, whether it needs the network at all). The plugin, the card
 * builder, and the CSP host list all read from here — adding a provider is one
 * row plus its pure extractor, with no change to the decoration mechanism.
 *
 * Labels are literal English strings used as t() keys by the (lazy) card
 * module; keeping them literal here keeps every key extractable.
 */

/** The providers this pass understands. Widen the union to add one. */
export type EmbedKind = "youtube" | "loom" | "figma" | "github";

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

/**
 * One provider's capabilities — the single place its behavior is declared.
 * Optional fields encode the card shape: `thumbnailUrl` → thumbnail facade
 * (YouTube), `playerUrl` without `thumbnailUrl` → branded facade (Loom/Figma),
 * neither → info card (GitHub).
 */
export interface EmbedProvider {
    kind: EmbedKind;
    /** Display name, shown on branded facades ("Loom", "Figma"). */
    name: string;
    extractId: (url: string) => string | null;
    /**
     * False for providers whose card is built from the URL alone and performs
     * zero requests — those render even with the master network switch off
     * (the switch gates requests, not rendering; see webviewHtml.ts's CSP note).
     */
    needsNetwork: boolean;
    /** CSS aspect-ratio for the player frame ("16 / 9", "4 / 3"). */
    aspect?: string;
    /** Facade thumbnail URL (fetched at render — network providers only). */
    thumbnailUrl?: (id: string) => string;
    /** Click-time iframe src (autoplay included where it applies). */
    playerUrl?: (id: string) => string;
    /** Canonical external URL when the original source URL is unavailable. */
    externalUrl: (id: string) => string;
    /** t() key for the external-open button ("Open on YouTube"). */
    openLabel: string;
    /** t() key for the facade's activate overlay ("Play video"). */
    activateLabel?: string;
    /**
     * Overlay glyph for the activate button. "play" (the default) is a media
     * triangle — honest for video; an interactive canvas (Figma) uses
     * "preview" so the affordance doesn't promise playback.
     */
    activateIcon?: "play" | "preview";
    /** t() key for the player iframe's title attribute. */
    playerTitle?: string;
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

/**
 * The provider table — the single place a provider is registered. Ordered; the
 * first row whose extractId returns an id wins.
 */
const PROVIDERS: readonly EmbedProvider[] = [
    {
        kind: "youtube",
        name: "YouTube",
        extractId: youtubeId,
        needsNetwork: true,
        aspect: "16 / 9",
        thumbnailUrl: youtubeThumbnailUrl,
        playerUrl: (id) => `${youtubeEmbedUrl(id)}?autoplay=1`,
        externalUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
        openLabel: "Open on YouTube",
        activateLabel: "Play video",
        playerTitle: "YouTube video player",
    },
    {
        kind: "loom",
        name: "Loom",
        extractId: loomId,
        needsNetwork: true,
        aspect: "16 / 9",
        playerUrl: (id) => `${loomEmbedUrl(id)}?autoplay=1`,
        externalUrl: (id) => `https://www.loom.com/share/${id}`,
        openLabel: "Open on Loom",
        activateLabel: "Play video",
        playerTitle: "Loom video player",
    },
    {
        kind: "figma",
        name: "Figma",
        extractId: figmaId,
        needsNetwork: true,
        aspect: "4 / 3",
        playerUrl: figmaEmbedUrl,
        externalUrl: (id) => `https://www.figma.com/${id}`,
        openLabel: "Open in Figma",
        activateLabel: "Load Figma preview",
        activateIcon: "preview",
        playerTitle: "Figma embed",
    },
    {
        kind: "github",
        name: "GitHub",
        extractId: githubId,
        needsNetwork: false,
        externalUrl: (id) => `https://github.com/${id}`,
        openLabel: "Open on GitHub",
    },
];

const PROVIDER_BY_KIND = new Map(PROVIDERS.map((p) => [p.kind, p]));

/** Look up a provider's capability row by kind. */
export function providerFor(kind: EmbedKind): EmbedProvider {
    // The map is total over EmbedKind by construction.
    return PROVIDER_BY_KIND.get(kind)!;
}

/**
 * Recognition cache. The embed plugin re-walks every bare-link paragraph on
 * selection changes (reveal-on-caret needs the selection), so without a cache
 * every caret move re-parses every bare URL through up to four `new URL()`
 * calls — measurable on link-heavy documents (perf review, 2026-07-24). The
 * result for a given href never changes within a session (the table is
 * static), so a memo makes repeat walks O(1) per link. Bounded: cleared
 * wholesale when full — simpler than LRU, and a working set over 512 distinct
 * hrefs in one document is already pathological.
 */
const RECOGNIZE_CACHE = new Map<string, EmbedMatch | null>();
const RECOGNIZE_CACHE_MAX = 512;

/**
 * Recognize which provider (if any) a bare link href points at. Returns the
 * provider kind and stable id, or null when no provider matches. Pure and
 * deterministic (memoized) — the plugin calls this while walking bare-link
 * paragraphs. Callers must treat the returned match as read-only.
 */
export function recognizeProvider(url: string): EmbedMatch | null {
    const cached = RECOGNIZE_CACHE.get(url);
    if (cached !== undefined) {
        return cached;
    }
    let match: EmbedMatch | null = null;
    for (const provider of PROVIDERS) {
        const id = provider.extractId(url);
        if (id) {
            match = { kind: provider.kind, id };
            break;
        }
    }
    if (RECOGNIZE_CACHE.size >= RECOGNIZE_CACHE_MAX) {
        RECOGNIZE_CACHE.clear();
    }
    RECOGNIZE_CACHE.set(url, match);
    return match;
}
