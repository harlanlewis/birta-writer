/**
 * webview/embedMeta.ts
 *
 * The webview-side embed-metadata store: which `kind:id`s have been asked for
 * an oEmbed title, what came back, and who is waiting to render it. Tiny and
 * eager-safe (no DOM, no card code) — the card chunk subscribes, the embed
 * plugin queues, messageHandlers routes replies.
 *
 * Discipline:
 *  - One ask per `kind:id` per webview session: pending entries dedupe
 *    in-flight requests; a failure (null reply, or the 15s backstop firing on
 *    a dropped reply) is CACHED — a dead endpoint is asked once, never per
 *    keystroke or reopen. The extension keeps its own promise cache across
 *    webview reloads.
 *  - Render-only: a resolved title reaches subscribers (card captions) via
 *    callback; nothing here can touch the document.
 *  - Bounded: the map is capped; overflow starts a fresh generation, exactly
 *    like the embed plugin's recognize cache.
 */
import { notifyResolveEmbedMeta } from "./messaging";
import { providerFor, type EmbedKind } from "./utils/embedProviders";

/** Mirror of unfurl's reply backstop: a dropped reply must not wait forever. */
const META_REPLY_TIMEOUT_MS = 15000;
const META_CACHE_LIMIT = 256;

interface MetaEntry {
    state: "pending" | "resolved" | "failed";
    title: string | null;
    waiters: Array<(title: string | null) => void>;
    timer: ReturnType<typeof setTimeout> | null;
    /** Has a request actually been posted? A subscriber can pre-register an
     * entry before the plugin's idle pass asks; the ask must still happen. */
    asked: boolean;
}

let entries = new Map<string, MetaEntry>();
/** requestId → entry key, to route `embedMetaResult` replies. */
let requests = new Map<string, string>();
let requestCounter = 0;

const keyOf = (kind: EmbedKind, id: string): string => `${kind}:${id}`;

/** Test seam: reset all session state. */
export function _resetEmbedMetaForTests(): void {
    for (const entry of entries.values()) {
        if (entry.timer) { clearTimeout(entry.timer); }
    }
    entries = new Map();
    requests = new Map();
    requestCounter = 0;
}

function settle(key: string, title: string | null): void {
    const entry = entries.get(key);
    if (!entry || entry.state !== "pending") {
        return;
    }
    if (entry.timer) { clearTimeout(entry.timer); }
    entry.timer = null;
    entry.state = title === null ? "failed" : "resolved";
    entry.title = title;
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const waiter of waiters) {
        waiter(title);
    }
}

/**
 * Ask for the titles of every metadata-capable embed in `embeds` that this
 * session hasn't asked about yet. Called from the embed plugin's idle pass —
 * never on the keystroke path — and cheap when everything is already known.
 */
export function queueEmbedMetaResolution(
    embeds: ReadonlyArray<{ match: { kind: EmbedKind; id: string }; href: string }>,
): void {
    for (const embed of embeds) {
        const { kind, id } = embed.match;
        if (!providerFor(kind).hasMetadata) {
            continue;
        }
        const key = keyOf(kind, id);
        const existing = entries.get(key);
        if (existing?.asked || (existing && existing.state !== "pending")) {
            continue;
        }
        if (!existing && entries.size >= META_CACHE_LIMIT) {
            _resetEmbedMetaForTests();
        }
        const entry: MetaEntry = existing ?? {
            state: "pending", title: null, waiters: [], timer: null, asked: false,
        };
        entry.asked = true;
        // The backstop: a dropped reply resolves to "no title" instead of
        // pending forever (and instead of re-asking per doc change).
        entry.timer = setTimeout(() => settle(key, null), META_REPLY_TIMEOUT_MS);
        entries.set(key, entry);
        const requestId = `embedmeta_${Date.now()}_${++requestCounter}`;
        requests.set(requestId, key);
        notifyResolveEmbedMeta(requestId, embed.href);
    }
}

/**
 * Subscribe a card caption to a `kind:id`'s title. A known answer calls back
 * SYNCHRONOUSLY (cache hit — the caption fills before first paint of the
 * card); a pending one calls back when the reply lands; an unasked one stays
 * silent until the plugin's idle pass asks (the callback is parked either way).
 */
export function subscribeEmbedMeta(
    kind: EmbedKind,
    id: string,
    apply: (title: string | null) => void,
): void {
    const entry = entries.get(keyOf(kind, id));
    if (!entry) {
        // Not asked yet: park a pre-registered entry so the eventual queue
        // pass reuses it and the reply reaches this subscriber. State stays
        // "pending" with no timer — the timer arms when the ask happens.
        entries.set(keyOf(kind, id), { state: "pending", title: null, waiters: [apply], timer: null, asked: false });
        return;
    }
    if (entry.state === "pending") {
        entry.waiters.push(apply);
        return;
    }
    apply(entry.title);
}

/** Route an `embedMetaResult` reply to its entry (messageHandlers). */
export function handleEmbedMetaResult(requestId: string, title: string | null): void {
    const key = requests.get(requestId);
    if (!key) {
        return;
    }
    requests.delete(requestId);
    settle(key, title);
}
