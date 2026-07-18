/**
 * webview/utils/embedProviders.ts
 *
 * Pure URL → embed-provider recognition (MAR-56). Given the href of a bare
 * autolink, decide whether it points at a supported media provider and, if so,
 * extract the stable id needed to render a facade card. No DOM, no network — id
 * extraction is pure string work, so the whole surface is unit-testable and
 * shares the discipline of pasteLink.ts's detectPastedLinkTarget /
 * calc.ts's detectCalcExpression: match narrowly, reject everything else.
 *
 * This pass ships YOUTUBE only. The provider table is the extension seam: adding
 * Vimeo or GitHub later is a new PROVIDERS entry with its own pure extractId,
 * with no change to the plugin, the decoration mechanism, or the CSP-gating
 * logic (each provider's hosts would join the additive CSP list the same way).
 */

/** The providers this pass understands. Widen the union to add one. */
export type EmbedKind = "youtube";

/** A recognized embed: the provider kind and its stable media id. */
export interface EmbedMatch {
    kind: EmbedKind;
    /** Provider-specific id (a YouTube 11-char video id). */
    id: string;
}

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Parse a URL string, returning null for anything malformed. */
function parseUrl(raw: string): URL | null {
    try {
        return new URL(raw.trim());
    } catch {
        return null;
    }
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

/** One provider: its kind and the pure function that pulls an id from a URL. */
interface ProviderEntry {
    kind: EmbedKind;
    extractId: (url: string) => string | null;
}

/**
 * The provider table — the single place a new provider is registered. Ordered;
 * the first entry whose extractId returns an id wins. Adding Vimeo/GitHub later
 * is one more row here plus its own pure extractId.
 */
const PROVIDERS: readonly ProviderEntry[] = [
    { kind: "youtube", extractId: youtubeId },
];

/**
 * Recognize which provider (if any) a bare link href points at. Returns the
 * provider kind and stable id, or null when no provider matches. Pure and
 * deterministic — the plugin calls this while walking bare-link paragraphs.
 */
export function recognizeProvider(url: string): EmbedMatch | null {
    for (const provider of PROVIDERS) {
        const id = provider.extractId(url);
        if (id) {
            return { kind: provider.kind, id };
        }
    }
    return null;
}
