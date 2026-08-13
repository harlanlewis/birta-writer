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
export type EmbedKind =
    | "youtube"
    | "vimeo"
    | "loom"
    | "figma"
    | "github"
    | "googledrive"
    | "googledocs"
    | "googleslides"
    | "googlesheets"
    | "googlefile"
    | "miro"
    | "linear"
    | "codepen"
    | "codesandbox"
    | "stackblitz";

/** A recognized embed: the provider kind and its stable id. */
export interface EmbedMatch {
    kind: EmbedKind;
    /**
     * Provider-specific id. A YouTube/Loom video id; a Figma `type/fileKey`
     * composite; a GitHub `owner/repo[/pull|issues/N | /blob/ref/path…]` path;
     * a Google `product/fileId` composite; a Linear `org/issue/KEY[/slug]`
     * path. Opaque outside this module, except the exported *CardParts
     * re-parsers (githubCardParts, googleFileCardParts, linearCardParts).
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

/**
 * Parse `raw` and pin it to one canonical host — the shared prologue of every
 * single-host extractor. Null for malformed, non-http(s), or any other host.
 * Multi-host providers (YouTube, Vimeo) keep their own host dispatch.
 */
function hostUrl(raw: string, host: string): URL | null {
    const url = parseUrl(raw);
    return url && canonicalHost(url) === host ? url : null;
}

/** The URL's non-empty path segments, in order. */
function pathSegments(url: URL): string[] {
    return url.pathname.split("/").filter(Boolean);
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
    const url = hostUrl(raw, "loom.com");
    if (!url) {
        return null;
    }
    const [first, second] = pathSegments(url);
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
    const url = hostUrl(raw, "figma.com");
    if (!url) {
        return null;
    }
    const [first, second] = pathSegments(url);
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

/**
 * A Google Drive/Docs file id: the charset Google uses, bounded. Real ids run
 * ~28–44 characters; the floor keeps short path words ("e", "edit") out.
 */
const GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * A publish-to-web token (the `/d/e/` path form). Same charset, much longer
 * than a file id (currently `2PACX-…`, ~86 chars); the prefix itself is not
 * pinned so a format rev doesn't silently kill every published card.
 */
const GOOGLE_PUB_ID = /^[A-Za-z0-9_-]{30,300}$/;

/**
 * Extract the file id from a Google Drive file URL, or null. Accepts
 * `drive.google.com/file/d/<id>` with an optional `view`/`preview`/`edit`
 * tail, and the legacy `drive.google.com/open?id=<id>`. Folders, shared
 * drives, and every other Drive surface stay plain links. The PREVIEW iframe
 * built from this id is Google's supported no-auth embed for public files;
 * an `/edit` UI URL is never framed (X-Frame-Options), only re-derived to
 * `/preview` at click time. Exported for unit testing.
 */
export function googleDriveId(raw: string): string | null {
    const url = hostUrl(raw, "drive.google.com");
    if (!url) {
        return null;
    }
    const segments = pathSegments(url);
    const [first, second, third, fourth] = segments;
    if (first === "file" && second === "d" && third && GOOGLE_FILE_ID.test(third)) {
        if (segments.length === 3) {
            return third;
        }
        if (segments.length === 4 && (fourth === "view" || fourth === "preview" || fourth === "edit")) {
            return third;
        }
        return null;
    }
    if (segments.length === 1 && first === "open") {
        const id = url.searchParams.get("id");
        return id && GOOGLE_FILE_ID.test(id) ? id : null;
    }
    return null;
}

/** Build the click-time preview iframe URL for a Drive file id. */
export function googleDrivePreviewUrl(id: string): string {
    return `https://drive.google.com/file/d/${id}/preview`;
}

/** The docs.google.com products whose non-published URLs get the info card. */
const GOOGLE_PRODUCTS = new Set(["document", "presentation", "spreadsheets"]);

/**
 * The shared shape of every publish-to-web URL:
 * `docs.google.com/<product>/d/e/<token>/<tail>`. Only the published `/d/e/`
 * form is framable without auth; the tails differ per product.
 */
function googlePublishedId(raw: string, product: string, tails: readonly string[]): string | null {
    const url = hostUrl(raw, "docs.google.com");
    if (!url) {
        return null;
    }
    const segments = pathSegments(url);
    if (segments.length !== 5) {
        return null;
    }
    const [first, second, third, id, tail] = segments;
    if (first !== product || second !== "d" || third !== "e" || !tails.includes(tail)) {
        return null;
    }
    return GOOGLE_PUB_ID.test(id) ? id : null;
}

/** Extract the publish-to-web token from a published Google Doc URL, or null. */
export function googleDocsPubId(raw: string): string | null {
    return googlePublishedId(raw, "document", ["pub"]);
}

/** Build the published-Doc embed URL (Google's own `?embedded=true` form). */
export function googleDocsEmbedUrl(id: string): string {
    return `https://docs.google.com/document/d/e/${id}/pub?embedded=true`;
}

/**
 * Extract the publish-to-web token from a published Slides URL, or null.
 * Accepts the `/pub` link Google hands out and the `/embed` form its own
 * snippet uses — both carry the same token.
 */
export function googleSlidesPubId(raw: string): string | null {
    return googlePublishedId(raw, "presentation", ["pub", "embed"]);
}

/** Build the published-Slides embed URL (Google's own `/embed` endpoint). */
export function googleSlidesEmbedUrl(id: string): string {
    return `https://docs.google.com/presentation/d/e/${id}/embed`;
}

/** Extract the publish-to-web token from a published Sheets URL, or null. */
export function googleSheetsPubId(raw: string): string | null {
    return googlePublishedId(raw, "spreadsheets", ["pubhtml"]);
}

/** Build the published-Sheets embed URL (Google's own widget form). */
export function googleSheetsEmbedUrl(id: string): string {
    return `https://docs.google.com/spreadsheets/d/e/${id}/pubhtml?widget=true`;
}

/**
 * Extract a `product/fileId` composite from an ORDINARY (non-published)
 * docs.google.com URL, or null: `/{document|presentation|spreadsheets}/d/<id>`
 * with an optional `edit`/`view`/`preview` tail. These URLs answer with
 * X-Frame-Options: SAMEORIGIN, so the kind built on this id is the info card —
 * there is deliberately no code path from here to an iframe. Exported for
 * unit testing.
 */
export function googleFileId(raw: string): string | null {
    const url = hostUrl(raw, "docs.google.com");
    if (!url) {
        return null;
    }
    const segments = pathSegments(url);
    const [product, second, id, tail] = segments;
    if (!product || !GOOGLE_PRODUCTS.has(product) || second !== "d") {
        return null;
    }
    // The published form (`/d/e/<token>/…`) is a different kind; the file-id
    // floor already rejects the bare "e" segment, but be explicit.
    if (!id || id === "e" || !GOOGLE_FILE_ID.test(id)) {
        return null;
    }
    if (segments.length === 3) {
        return `${product}/${id}`;
    }
    if (segments.length === 4 && (tail === "edit" || tail === "view" || tail === "preview")) {
        return `${product}/${id}`;
    }
    return null;
}

/** The display pieces of a Google info card, from a googleFileId composite. */
export interface GoogleFileCardParts {
    product: "document" | "presentation" | "spreadsheets";
    fileId: string;
}

/** Re-parse a googleFileId composite into its display pieces. Pure; unit-tested. */
export function googleFileCardParts(id: string): GoogleFileCardParts {
    const [product, fileId] = id.split("/");
    return { product: product as GoogleFileCardParts["product"], fileId };
}

/**
 * A Miro board id as it appears in the URL path: URL-safe base64-ish,
 * typically with a trailing `=` (a percent-encoded `%3D` stays a plain link —
 * narrow matching over normalization).
 */
const MIRO_BOARD_ID = /^[A-Za-z0-9_=-]{8,64}$/;

/**
 * Extract the board id from a Miro URL, or null. Accepts
 * `miro.com/app/board/<id>` and the live-embed form
 * `miro.com/app/live-embed/<id>` (any query params ignored). Exported for
 * unit testing.
 */
export function miroId(raw: string): string | null {
    const url = hostUrl(raw, "miro.com");
    if (!url) {
        return null;
    }
    const segments = pathSegments(url);
    if (segments.length !== 3) {
        return null;
    }
    const [first, second, third] = segments;
    if (first !== "app" || (second !== "board" && second !== "live-embed")) {
        return null;
    }
    return MIRO_BOARD_ID.test(third) ? third : null;
}

/**
 * Build the live-embed URL for a Miro board id — Miro's login-free pan/zoom
 * view for boards shared publicly (host: miro.com).
 *
 * `autoplay=true` skips Miro's own preloader, which otherwise puts a second
 * "See the board" click between the user and the canvas. The click on our
 * facade IS the consent to load, so the preloader gates something already
 * agreed to. The name is Miro's and it is misleading here: the parameter
 * chooses whether the board opens directly, and nothing on the board is
 * played that would not be played once it is open.
 */
export function miroEmbedUrl(id: string): string {
    return `https://miro.com/app/live-embed/${id}/?autoplay=true`;
}

/** CodePen path segments: usernames and pen slugs are URL-safe word chars. */
const CODEPEN_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Extract a `user/slug` composite id from a CodePen pen URL, or null. Accepts
 * `codepen.io/{user}/{pen|full|details|embed}/{slug}` — the pen's view
 * variants and its embed URL all name the same pen — and the team form
 * `codepen.io/team/{team}/{view}/{slug}`, whose id keeps the `team/` prefix
 * because CodePen's own embed and pen URLs keep it. Exported for unit testing.
 */
export function codepenId(raw: string): string | null {
    const url = hostUrl(raw, "codepen.io");
    if (!url) {
        return null;
    }
    let segments = pathSegments(url);
    let owner = segments[0] ?? "";
    if (segments.length === 4 && owner === "team") {
        owner = `team/${segments[1]}`;
        segments = segments.slice(1);
    }
    if (segments.length !== 3) {
        return null;
    }
    const [user, view, slug] = segments;
    if (view !== "pen" && view !== "full" && view !== "details" && view !== "embed") {
        return null;
    }
    return CODEPEN_SEGMENT.test(user) && CODEPEN_SEGMENT.test(slug) ? `${owner}/${slug}` : null;
}

/** A CodePen composite id split at its LAST slash: the owner path (a user,
 * or `team/{team}`) and the pen slug. */
function codepenIdParts(id: string): { owner: string; slug: string } {
    const cut = id.lastIndexOf("/");
    return { owner: id.slice(0, cut), slug: id.slice(cut + 1) };
}

/**
 * Build the embed URL for a CodePen id (host: codepen.io).
 * `default-tab=result` opens on the rendered output — the reading-flow
 * default; the embed's own tab bar still reaches the code panes.
 */
export function codepenEmbedUrl(id: string): string {
    const { owner, slug } = codepenIdParts(id);
    return `https://codepen.io/${owner}/embed/${slug}?default-tab=result`;
}

/** CodeSandbox sandbox ids: URL-safe word chars (legacy short ids and slugs). */
const CODESANDBOX_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Extract a sandbox id from a CodeSandbox URL, or null. Accepts the legacy
 * `codesandbox.io/s/{id}`, the current `codesandbox.io/p/sandbox/{id}`, and
 * the embed shape `codesandbox.io/embed/{id}`. Exported for unit testing.
 */
export function codesandboxId(raw: string): string | null {
    const url = hostUrl(raw, "codesandbox.io");
    if (!url) {
        return null;
    }
    const segments = pathSegments(url);
    const [first, second, third] = segments;
    if ((first === "s" || first === "embed") && segments.length === 2) {
        return CODESANDBOX_ID.test(second) ? second : null;
    }
    if (first === "p" && second === "sandbox" && segments.length === 3) {
        return CODESANDBOX_ID.test(third) ? third : null;
    }
    return null;
}

/** Build the embed URL for a CodeSandbox id (host: codesandbox.io). */
export function codesandboxEmbedUrl(id: string): string {
    return `https://codesandbox.io/embed/${id}`;
}

/** StackBlitz project ids: URL-safe word chars. */
const STACKBLITZ_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Extract a project id from a StackBlitz editor URL, or null. Accepts
 * `stackblitz.com/edit/{id}` (query params like `?file=` are the editor's
 * own state and ignored). GitHub-import URLs (`/github/{owner}/{repo}`) are
 * deliberately not recognized: they name a repo, not a stable project, and
 * the GitHub card already owns that link shape. Exported for unit testing.
 */
export function stackblitzId(raw: string): string | null {
    const url = hostUrl(raw, "stackblitz.com");
    if (!url) {
        return null;
    }
    const segments = pathSegments(url);
    if (segments.length !== 2 || segments[0] !== "edit") {
        return null;
    }
    return STACKBLITZ_ID.test(segments[1]) ? segments[1] : null;
}

/** Build the embedded-layout URL for a StackBlitz project (host: stackblitz.com). */
export function stackblitzEmbedUrl(id: string): string {
    return `https://stackblitz.com/edit/${id}?embed=1`;
}

/** A Linear issue key: team key + number (`MAR-186`). */
const LINEAR_ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Linear path segments: the conservative charset of org and title slugs. */
const LINEAR_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Extract a joined-path id from a Linear issue URL, or null. Accepted shape:
 * `linear.app/<org>/issue/<KEY-123>[/<title-slug>]` — nothing else (projects,
 * documents, views stay plain links). The slug rides along in the id so the
 * info card can show a human title without any network. Exported for testing.
 */
export function linearId(raw: string): string | null {
    const url = hostUrl(raw, "linear.app");
    if (!url) {
        return null;
    }
    const segments = pathSegments(url);
    if (segments.length < 3 || segments.length > 4) {
        return null;
    }
    // The `.`/`..` rejection matches githubId's: `new URL()` normalizes dot
    // segments away before the split, but the extractor must be safe on its
    // own terms rather than rely on that upstream side effect.
    if (segments.some((s) => /^\.\.?$/.test(s))) {
        return null;
    }
    const [org, section, key, slug] = segments;
    if (section !== "issue" || !LINEAR_SEGMENT.test(org) || !LINEAR_ISSUE_KEY.test(key)) {
        return null;
    }
    if (segments.length === 4 && !LINEAR_SEGMENT.test(slug)) {
        return null;
    }
    return segments.join("/");
}

/** The display pieces of a Linear info card, from a linearId composite. */
export interface LinearCardParts {
    org: string;
    /** The issue key, e.g. "MAR-186". */
    key: string;
    /** The hyphenated title slug, when the URL carried one. */
    slug?: string;
}

/** Re-parse a linearId composite into its display pieces. Pure; unit-tested. */
export function linearCardParts(id: string): LinearCardParts {
    const [org, , key, slug] = id.split("/");
    return slug ? { org, key, slug } : { org, key };
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
    const url = hostUrl(raw, "github.com");
    if (!url) {
        return null;
    }
    const segments = pathSegments(url);
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
    { kind: "googledrive", extract: googleDriveId },
    // Published (`/d/e/`) shapes before the ordinary-file shape: the shapes are
    // disjoint, but the framable kind must never lose a URL to the info card.
    { kind: "googledocs", extract: googleDocsPubId },
    { kind: "googleslides", extract: googleSlidesPubId },
    { kind: "googlesheets", extract: googleSheetsPubId },
    { kind: "googlefile", extract: googleFileId },
    { kind: "miro", extract: miroId },
    { kind: "linear", extract: linearId },
    { kind: "codepen", extract: codepenId },
    { kind: "codesandbox", extract: codesandboxId },
    { kind: "stackblitz", extract: stackblitzId },
];

/**
 * Every provider kind, in recognition order. Derived from EXTRACTORS rather
 * than written out again, so the roster cannot drift from what the recognizer
 * can actually match: a kind absent here is a kind no URL resolves to.
 * `embedProviderContributions.test.ts` walks this to pin one contributed
 * setting per provider.
 */
export const EMBED_KINDS: readonly EmbedKind[] = EXTRACTORS.map(({ kind }) => kind);

/** Setting key, under the `birta.` prefix, for one provider's switch. */
export function embedProviderSettingKey(kind: EmbedKind): string {
    return `embeds.providers.${kind}`;
}

/**
 * Is this one provider switched on (birta.embeds.providers.<kind>)?
 *
 * The roster is a layer BENEATH the two consent gates, never a replacement for
 * them: `birta.network.enabled` still governs every request and
 * `birta.embeds.enabled` still governs whether cards exist at all. This only
 * answers which providers the user wants among those already permitted, which
 * is why it is safe for an absent entry to mean ON.
 *
 * Absent means ON deliberately. VS Code merges the contributed per-provider
 * defaults, so a live read is normally complete; a PARTIAL map means a webview
 * booted before a provider existed, and failing closed there would silently
 * blank every card the user already had. Failing open costs nothing the
 * consent gates were not already holding.
 */
export function embedProviderEnabled(
    kind: EmbedKind,
    providers: Record<string, boolean> | undefined,
): boolean {
    return providers?.[kind] !== false;
}

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
        case "googledrive": return `https://drive.google.com/file/d/${id}/view`;
        case "googledocs": return `https://docs.google.com/document/d/e/${id}/pub`;
        case "googleslides": return `https://docs.google.com/presentation/d/e/${id}/pub`;
        case "googlesheets": return `https://docs.google.com/spreadsheets/d/e/${id}/pubhtml`;
        case "googlefile": {
            // The composite is `product/fileId`; the `/d/` joint is rebuilt.
            const { product, fileId } = googleFileCardParts(id);
            return `https://docs.google.com/${product}/d/${fileId}/edit`;
        }
        case "miro": return `https://miro.com/app/board/${id}/`;
        case "linear": return `https://linear.app/${id}`;
        case "codepen": {
            const { owner, slug } = codepenIdParts(id);
            return `https://codepen.io/${owner}/pen/${slug}`;
        }
        case "codesandbox": return `https://codesandbox.io/s/${id}`;
        case "stackblitz": return `https://stackblitz.com/edit/${id}`;
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
    miro: "miro.com",
    codepen: "codepen.io",
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
        case "miro": return `https://miro.com/api/v1/oembed?url=${encoded}`;
        case "codepen": return `https://codepen.io/api/oembed?format=json&url=${encoded}`;
        // Google exposes no oEmbed for Docs/Slides/Sheets/Drive; the Linear
        // and googlefile cards are URL-derived and fetch nothing by design.
        // CodeSandbox and StackBlitz publish no stable provider-own oEmbed
        // worth pinning; their cards stay title-less rather than guessing.
        case "github":
        case "googledrive":
        case "googledocs":
        case "googleslides":
        case "googlesheets":
        case "googlefile":
        case "linear":
        case "codesandbox":
        case "stackblitz":
            return null;
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
    // Google preview/published endpoints serve from these two hosts directly;
    // inner content frames (googleusercontent.com) are the CHILD document's
    // own frames, which our frame-src does not govern.
    "https://drive.google.com",
    "https://docs.google.com",
    "https://miro.com",
    // The playground embeds serve their embed documents from their apex
    // hosts; the preview/runtime inside each is the CHILD document's own
    // frame (cdpn.io, csb.app, webcontainer hosts), which our frame-src
    // does not govern.
    "https://codepen.io",
    "https://codesandbox.io",
    "https://stackblitz.com",
];
