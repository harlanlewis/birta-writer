/**
 * webview/embedConnector.ts
 *
 * The webview-side connector store (MAR-198): which services the user has
 * connected, which `kind:id`s have been asked for an authenticated card, what
 * came back, and which connect affordances the reader has waved away.
 *
 * Sibling of embedMeta.ts, and deliberately separate from it. An oEmbed title
 * is an unauthenticated request about a public URL; a connector card carries a
 * credential. Keeping the two stores apart keeps the second one's gating
 * legible instead of hidden inside a shared code path.
 *
 * Discipline:
 *  - A card is asked for whether or not the service is connected, because most
 *    of them are public and a public read carries no credential. This module
 *    once short-circuited to `locked` from the connection map and posted no
 *    message at all, which made the extension's anonymous read unreachable:
 *    the gate that decides whether to contact a provider is the embeds switch,
 *    not the connection, and it is checked on the extension side too.
 *  - A provider with NO connector still costs zero here: no message, no chrome.
 *    That is the only free case, and it is free because there is nothing to ask.
 *  - One ask per `kind:id` per session, with the same dropped-reply backstop
 *    embedMeta uses. Failures are cached; a dead endpoint is asked once.
 *  - Render-only: results reach card bodies through a callback, and nothing
 *    here can touch the document.
 *  - Quiet at scale: dismissing a connect affordance suppresses it for that
 *    connector for the rest of the session, so one document full of locked
 *    links nags once rather than once per card.
 *
 * Nothing in this module has a field a credential could occupy, which is the
 * webview's half of "the webview never sees a credential".
 */
import { notifyConnectService, notifyResolveEmbedCard } from "./messaging";
import { connectorForEmbedKind, type EmbedCardResult } from "../shared/connectors";
import type { EmbedKind } from "./utils/embedProviders";

/** Mirror of embedMeta's reply backstop: a dropped reply must not wait forever. */
const CARD_REPLY_TIMEOUT_MS = 15000;
const CARD_CACHE_LIMIT = 256;

interface CardEntry {
    state: "pending" | "settled";
    result: EmbedCardResult | null;
    waiters: Array<(result: EmbedCardResult | null) => void>;
    timer: ReturnType<typeof setTimeout> | null;
    asked: boolean;
}

let entries = new Map<string, CardEntry>();
/** requestId → entry key, to route `embedCardResult` replies. */
let requests = new Map<string, string>();
let requestCounter = 0;
/** Connectors whose connect affordance the reader dismissed this session. */
let dismissed = new Set<string>();

const keyOf = (kind: EmbedKind, id: string): string => `${kind}:${id}`;

/** Test seam: reset all session state. */
export function _resetEmbedConnectorForTests(): void {
    for (const entry of entries.values()) {
        if (entry.timer) { clearTimeout(entry.timer); }
    }
    entries = new Map();
    requests = new Map();
    requestCounter = 0;
    dismissed = new Set();
}

/**
 * A connect or disconnect happened: drop every cached answer, because it
 * changes what all of them would have been. The caller re-gates the embed
 * decorations afterwards, which rebuilds every card and re-asks — that rebuild,
 * not a subscriber list, is how a freshly connected service upgrades the cards
 * already on screen.
 *
 * The map itself is deliberately NOT stored. Nothing here decides anything from
 * the connection any more: the extension answers `locked` when a read comes
 * back not-visible, and that answer is a fact about the resource rather than
 * about the account. Keeping a mirror of it would only invite a second, staler
 * source of truth for a question this module no longer asks.
 */
export function setConnectorStates(_states: Record<string, boolean>): void {
    for (const entry of entries.values()) {
        if (entry.timer) { clearTimeout(entry.timer); }
    }
    entries = new Map();
    requests = new Map();
}

/** Has the reader waved away this connector's connect affordance this session? */
export function connectorDismissed(connector: string): boolean {
    return dismissed.has(connector);
}

/** Suppress this connector's connect affordance for the rest of the session. */
export function dismissConnector(connector: string): void {
    dismissed.add(connector);
}

/** Ask the extension to run the connect flow for one service. */
export function requestConnect(connector: string): void {
    notifyConnectService(connector);
}

/**
 * Ask for the cards of every connector-capable embed in `embeds` this session
 * has not asked about, connected or not. Called from the embed plugin's idle
 * pass, never on the keystroke path.
 *
 * Deliberately NOT gated on the connection: the extension reads a public
 * resource anonymously, and gating here would make that unreachable. The
 * consent gates that decide whether to contact the provider at all (network,
 * embeds, this provider) are re-checked extension-side before any request.
 */
export function queueEmbedCardResolution(
    embeds: ReadonlyArray<{ match: { kind: EmbedKind; id: string }; href: string }>,
): void {
    for (const embed of embeds) {
        const { kind, id } = embed.match;
        const connector = connectorForEmbedKind(kind);
        // No connector at all: nothing to ask, no chrome to render.
        if (!connector) {
            continue;
        }
        const key = keyOf(kind, id);
        const existing = entries.get(key);
        if (existing?.asked) {
            continue;
        }
        if (!existing && entries.size >= CARD_CACHE_LIMIT) {
            entries = new Map();
            requests = new Map();
        }
        const entry: CardEntry = existing ?? {
            state: "pending", result: null, waiters: [], timer: null, asked: false,
        };
        entry.asked = true;
        entry.timer = setTimeout(() => settle(key, null), CARD_REPLY_TIMEOUT_MS);
        entries.set(key, entry);
        const requestId = `embedcard_${Date.now()}_${++requestCounter}`;
        requests.set(requestId, key);
        notifyResolveEmbedCard(requestId, embed.href);
    }
}

function settle(key: string, result: EmbedCardResult | null): void {
    const entry = entries.get(key);
    if (!entry || entry.state !== "pending") {
        return;
    }
    if (entry.timer) { clearTimeout(entry.timer); }
    entry.timer = null;
    entry.state = "settled";
    entry.result = result;
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const waiter of waiters) {
        waiter(result);
    }
}

/**
 * Subscribe a card to its connector result. A provider with no connector never
 * calls back at all (there is no connector chrome for it). A known answer calls
 * back synchronously; a pending one calls back when the reply lands.
 *
 * `locked` is NOT derived here any more. It is the extension's answer to a read
 * that came back not-visible, which is a different fact from "not connected":
 * a public repository resolves `ready` with no connection at all, and deriving
 * the lock from the connection map would have shown a connect offer on cards
 * that never needed one.
 */
export function subscribeEmbedCard(
    kind: EmbedKind,
    id: string,
    apply: (result: EmbedCardResult | null) => void,
): void {
    const connector = connectorForEmbedKind(kind);
    if (!connector) {
        return;
    }
    const entry = entries.get(keyOf(kind, id));
    if (!entry) {
        // Not asked yet: park a pre-registered entry so the plugin's idle pass
        // reuses it and the reply reaches this card. No timer — it arms when
        // the ask happens.
        entries.set(keyOf(kind, id), {
            state: "pending", result: null, waiters: [apply], timer: null, asked: false,
        });
        return;
    }
    if (entry.state === "pending") {
        entry.waiters.push(apply);
        return;
    }
    apply(entry.result);
}

/** Route an `embedCardResult` reply to its entry (messageHandlers). */
export function handleEmbedCardResult(requestId: string, result: EmbedCardResult | null): void {
    const key = requests.get(requestId);
    if (!key) {
        return;
    }
    requests.delete(requestId);
    settle(key, result);
}
