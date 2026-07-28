/**
 * webview/utils/embedProviders.ts
 *
 * The PRESENTATION half of embed providers (MAR-56, generalized in MAR-186):
 * what each provider's card looks like — facade shape, aspect, labels, which
 * gates apply. The pure recognition core (extractors, canonical URLs, oEmbed
 * endpoints, CSP host lists) lives in shared/embedProviders.ts, shared with
 * the extension, and is re-exported here so webview consumers and tests keep
 * one import path.
 *
 * PROVIDERS is the single extension seam: each row declares the provider's
 * presentation capabilities (thumbnail, player iframe, aspect, labels, whether
 * it needs the network, whether it has an oEmbed metadata source). The plugin
 * and the card builder read from here — adding a provider is one extractor in
 * the shared core plus one row here.
 *
 * Labels are literal English strings used as t() keys by the (lazy) card
 * module; keeping them literal here keeps every key extractable.
 */

import {
    canonicalEmbedUrl,
    figmaEmbedUrl,
    loomEmbedUrl,
    recognizeEmbed,
    vimeoEmbedUrl,
    youtubeEmbedUrl,
    youtubeThumbnailUrl,
    type EmbedKind,
    type EmbedMatch,
} from "../../shared/embedProviders";

export {
    canonicalEmbedUrl,
    figmaEmbedUrl,
    figmaId,
    githubCardParts,
    githubId,
    loomEmbedUrl,
    loomId,
    vimeoEmbedUrl,
    vimeoId,
    youtubeEmbedUrl,
    youtubeId,
    youtubeThumbnailUrl,
    type EmbedKind,
    type EmbedMatch,
    type GithubCardParts,
} from "../../shared/embedProviders";

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
    /**
     * False for providers whose card is built from the URL alone and performs
     * zero requests — those render even with the master network switch off
     * (the switch gates requests, not rendering; see webviewHtml.ts's CSP note).
     */
    needsNetwork: boolean;
    /**
     * True when the provider has an oEmbed endpoint the extension can ask for
     * a title (shared/embedProviders.ts oembedEndpoint). Rides the same
     * consent pair as the card itself — render-only data, no extra switch.
     */
    hasMetadata: boolean;
    /** CSS aspect-ratio for the player frame ("16 / 9", "4 / 3"). */
    aspect?: string;
    /** Facade thumbnail URL (fetched at render — network providers only). */
    thumbnailUrl?: (id: string) => string;
    /**
     * Click-time iframe src. Deliberately WITHOUT autoplay: a webview's
     * activation never delegates into a freshly created cross-origin iframe,
     * so a requested autoplay is blocked and providers spin on a black frame
     * instead of showing their play UI (observed with Vimeo, 2026-07-27). The
     * facade click loads the provider's real player; its own play button is a
     * genuine in-frame gesture that always works.
     */
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

/** The provider table — the single place a provider's presentation lives. */
const PROVIDERS: readonly EmbedProvider[] = [
    {
        kind: "youtube",
        name: "YouTube",
        needsNetwork: true,
        hasMetadata: true,
        aspect: "16 / 9",
        thumbnailUrl: youtubeThumbnailUrl,
        playerUrl: youtubeEmbedUrl,
        externalUrl: (id) => canonicalEmbedUrl("youtube", id),
        openLabel: "Open on YouTube",
        activateLabel: "Play video",
        playerTitle: "YouTube video player",
    },
    {
        kind: "vimeo",
        name: "Vimeo",
        needsNetwork: true,
        hasMetadata: true,
        aspect: "16 / 9",
        playerUrl: vimeoEmbedUrl,
        externalUrl: (id) => canonicalEmbedUrl("vimeo", id),
        openLabel: "Open on Vimeo",
        activateLabel: "Play video",
        playerTitle: "Vimeo video player",
    },
    {
        kind: "loom",
        name: "Loom",
        needsNetwork: true,
        hasMetadata: true,
        aspect: "16 / 9",
        playerUrl: loomEmbedUrl,
        externalUrl: (id) => canonicalEmbedUrl("loom", id),
        openLabel: "Open on Loom",
        activateLabel: "Play video",
        playerTitle: "Loom video player",
    },
    {
        kind: "figma",
        name: "Figma",
        needsNetwork: true,
        hasMetadata: true,
        aspect: "4 / 3",
        playerUrl: figmaEmbedUrl,
        externalUrl: (id) => canonicalEmbedUrl("figma", id),
        openLabel: "Open in Figma",
        activateLabel: "Load Figma preview",
        activateIcon: "preview",
        playerTitle: "Figma embed",
    },
    {
        kind: "github",
        name: "GitHub",
        needsNetwork: false,
        hasMetadata: false,
        externalUrl: (id) => canonicalEmbedUrl("github", id),
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
 * Recognize which provider (if any) a bare link href points at — the shared
 * core's recognizeEmbed under its historical webview name. Callers that need
 * per-URL memoization use the embed plugin's cache (MAR-215) on top of this.
 */
export const recognizeProvider: (url: string) => EmbedMatch | null = recognizeEmbed;
