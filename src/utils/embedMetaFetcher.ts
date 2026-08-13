/**
 * src/utils/embedMetaFetcher.ts
 *
 * Extension-side oEmbed title resolution for embed cards (MAR-186's metadata
 * rung; the first slice of MAR-198's card resolver). Rung 1 of the network
 * posture: a URL the user typed, asked about at ITS OWN provider's oEmbed
 * endpoint. Render-only — the title decorates a card caption and is never
 * written to the document — so it rides the existing consent pair
 * (`birta.network.enabled` && `birta.embeds.enabled`) with no extra switch.
 *
 * Hardening, stricter than paste-unfurl's fetch:
 *  - The webview's URL string only SELECTS a provider: it is re-recognized
 *    here (shared/embedProviders.ts) and the outgoing request URL is rebuilt
 *    entirely from validated parts — kind + extracted id → canonical URL →
 *    pinned provider endpoint. An unrecognized URL fetches nothing.
 *  - The endpoint host must equal its OEMBED_HOSTS pin, and passes the SSRF
 *    guard (belt-and-braces; the hosts are compile-time constants).
 *  - `redirect: "manual"` and ANY 3xx is a failure: oEmbed endpoints answer
 *    canonical URLs directly, so a redirect is a reason to stop, not follow.
 *  - JSON content-type required, body capped, title schema-checked and
 *    sanitized (control chars stripped, length-capped) before it crosses to
 *    the webview.
 *
 * Caching (MAR-198 invariant 10): in-memory only, per extension-host session.
 * The PROMISE is cached, which dedupes concurrent identical requests for
 * free; failures resolve to null and stay cached (negative cache) so a dead
 * endpoint is asked once, not once per reopen.
 */
import { readBirtaSetting } from "../config";
import { reportError } from "../errorSink";
import { isPubliclyRoutableUrl } from "./urlGuard";
import { sanitizeTitle } from "./openGraph";
import { readCappedText } from "./cappedRead";
import {
    canonicalEmbedUrl,
    embedProviderEnabled,
    OEMBED_HOSTS,
    oembedEndpoint,
    recognizeEmbed,
    type EmbedMatch,
} from "../../shared/embedProviders";

/** Same total-time bound as unfurl: enhancement must never hang the host. */
const EMBED_META_TIMEOUT_MS = 5000;
/** oEmbed JSON is tiny; 256 KB is generous headroom, not a real budget. */
const EMBED_META_MAX_BYTES = 256 * 1024;
/** Session cache bound; overflow starts a fresh generation. */
const CACHE_LIMIT = 200;

let cache = new Map<string, Promise<string | null>>();

/** Test seam: drop the session cache between cases. */
export function _resetEmbedMetaCacheForTests(): void {
    cache = new Map();
}

/**
 * Resolve the oEmbed title for a recognized provider URL, or null on any
 * failure or closed gate. Never throws, never toasts (console error sink).
 *
 * `networkOverride` bridges the just-in-time opt-in's async settings write,
 * exactly like unfurl's `_networkWriteInFlight` — pass it through from the
 * provider so the accepting click's own cards resolve immediately.
 */
export function fetchEmbedTitle(
    url: string,
    opts: { networkOverride?: boolean } = {},
): Promise<string | null> {
    // Defense in depth (MAR-179): the webview never posts when either gate is
    // off; both are re-checked here so a stale or rogue message cannot fetch.
    // Checked BEFORE the cache so a disabled feature costs nothing and a later
    // enable isn't poisoned by cached "gate closed" nulls.
    const networkOn = opts.networkOverride ?? readBirtaSetting("networkEnabled");
    if (!networkOn || !readBirtaSetting("embedsEnabled")) {
        return Promise.resolve(null);
    }
    const match = recognizeEmbed(url);
    if (!match) {
        return Promise.resolve(null);
    }
    // Same defense in depth, one level finer: the webview does not queue a
    // resolution for a provider switched off in the roster, so reaching here
    // with one means a stale or rogue message. Checked after recognition
    // because the roster is keyed by kind, and still before the cache so a
    // later re-enable is not poisoned by a cached "gate closed" null.
    if (!embedProviderEnabled(match.kind, readBirtaSetting("embedProviders"))) {
        return Promise.resolve(null);
    }
    const key = `${match.kind}:${match.id}`;
    const hit = cache.get(key);
    if (hit) {
        return hit;
    }
    const pending = fetchTitleForMatch(match).catch((e) => {
        reportError("resolveEmbedMeta", e);
        return null;
    });
    if (cache.size >= CACHE_LIMIT) {
        cache = new Map();
    }
    cache.set(key, pending);
    return pending;
}

async function fetchTitleForMatch(match: EmbedMatch): Promise<string | null> {
    const endpoint = oembedEndpoint(match.kind, canonicalEmbedUrl(match.kind, match.id));
    if (!endpoint) {
        return null;
    }
    const parsed = new URL(endpoint);
    // Belt-and-braces: the endpoint is built from constants, but verify the
    // pin and the guard anyway — this function must be safe on its own terms.
    if (parsed.protocol !== "https:" || parsed.hostname !== OEMBED_HOSTS[match.kind]) {
        return null;
    }
    if (!(await isPubliclyRoutableUrl(parsed))) {
        return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_META_TIMEOUT_MS);
    try {
        const res = await globalThis.fetch(parsed.href, {
            signal: controller.signal,
            // oEmbed endpoints answer canonical URLs directly; a redirect is a
            // reason to stop, not to follow (no credentialed hops to protect,
            // but also no reason to widen the request surface).
            redirect: "manual",
            headers: {
                accept: "application/json",
                "user-agent": "Birta-Writer/embed-meta",
            },
        });
        if (!res.ok) {
            return null;
        }
        const contentType = res.headers.get("content-type");
        if (!contentType || !/json/i.test(contentType)) {
            return null;
        }
        const body = await readCappedText(res, EMBED_META_MAX_BYTES);
        const data: unknown = JSON.parse(body);
        const title = (data as { title?: unknown } | null)?.title;
        return typeof title === "string" ? sanitizeTitle(title) : null;
    } catch (e) {
        // Offline, DNS failure, abort-on-timeout, malformed JSON, etc.
        reportError("resolveEmbedMeta", e);
        return null;
    } finally {
        clearTimeout(timer);
    }
}
