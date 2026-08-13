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
 *  - A DISCONNECTED service costs zero. No message is posted for it at all:
 *    the locked state is derived here from the connection map, so a document
 *    with thirty links to an unconnected service makes thirty cards and no
 *    requests.
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
/**
 * Which connectors the user has connected, as the extension last reported.
 * Empty means nothing is connected, which is both the correct default and the
 * quiet one: before the first `connectorStateChanged` arrives, every card is
 * locked and no request is made.
 */
let connected: Record<string, boolean> = {};
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
    connected = {};
    dismissed = new Set();
}

/**
 * Record the extension's connection map. The caller re-gates the embed
 * decorations afterwards, which rebuilds every card against the new map — that
 * rebuild, not a subscriber list, is how a freshly connected service unlocks
 * the cards already on screen.
 *
 * Cached answers are dropped, because a connect or disconnect changes what
 * every one of them would have been.
 */
export function setConnectorStates(states: Record<string, boolean>): void {
    connected = states;
    for (const entry of entries.values()) {
        if (entry.timer) { clearTimeout(entry.timer); }
    }
    entries = new Map();
    requests = new Map();
}

/** Has the user connected the service behind this provider? */
export function connectorConnected(connector: string): boolean {
    return connected[connector] === true;
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
 * Ask for the cards of every connector-capable embed in `embeds` whose service
 * is connected and which this session has not asked about. Called from the
 * embed plugin's idle pass, never on the keystroke path.
 */
export function queueEmbedCardResolution(
    embeds: ReadonlyArray<{ match: { kind: EmbedKind; id: string }; href: string }>,
): void {
    for (const embed of embeds) {
        const { kind, id } = embed.match;
        const connector = connectorForEmbedKind(kind);
        // No connector, or one the user has not connected: no message, no
        // fetch. The card renders its locked state from the map alone.
        if (!connector || !connectorConnected(connector)) {
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
 * calls back at all (there is no connector chrome for it). An unconnected
 * service calls back SYNCHRONOUSLY with `locked`, derived here and costing no
 * message. A known answer likewise calls back synchronously; a pending one
 * calls back when the reply lands.
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
    if (!connectorConnected(connector)) {
        apply({ state: "locked", connector });
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
