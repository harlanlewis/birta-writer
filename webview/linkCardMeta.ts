/**
 * webview/linkCardMeta.ts
 *
 * The webview-side link-card metadata store, the sibling of embedMeta.ts
 * keyed by URL: which pages have been asked for their title and
 * description, what came back, and who is waiting to render it. Eager-safe
 * (no DOM, no card code); the card chunk subscribes, the embed plugin
 * queues, messageHandlers routes replies.
 *
 * Same discipline as the embed store: one ask per URL per session (pending
 * entries dedupe, a null reply or the reply backstop is CACHED as failed, so
 * a dead page is asked once), render-only (a resolved card reaches
 * subscribers by callback and never the document), and bounded (overflow
 * sheds the settled entries and keeps the pending ones).
 */
import type { LinkCardMeta } from "../shared/messages";
import { notifyResolveLinkCard } from "./messaging";

const REPLY_TIMEOUT_MS = 15000;
const CACHE_LIMIT = 256;

interface Entry {
    state: "pending" | "resolved" | "failed";
    card: LinkCardMeta | null;
    waiters: Array<(card: LinkCardMeta | null) => void>;
    timer: ReturnType<typeof setTimeout> | null;
    asked: boolean;
}

let entries = new Map<string, Entry>();
let requests = new Map<string, string>();
let requestCounter = 0;

/** Test seam: reset all session state. */
export function _resetLinkCardMetaForTests(): void {
    for (const entry of entries.values()) {
        if (entry.timer) { clearTimeout(entry.timer); }
    }
    entries = new Map();
    requests = new Map();
    requestCounter = 0;
}

/** The bound: a session that renders many distinct pages sheds the answered
 * and failed entries and keeps the pending ones, whose waiters and request
 * ids are still owed a settle. */
function evictSettled(): void {
    for (const [href, entry] of entries) {
        if (entry.state !== "pending") {
            entries.delete(href);
        }
    }
}

function settle(href: string, card: LinkCardMeta | null): void {
    const entry = entries.get(href);
    if (!entry || entry.state !== "pending") {
        return;
    }
    if (entry.timer) { clearTimeout(entry.timer); }
    entry.timer = null;
    entry.state = card === null ? "failed" : "resolved";
    entry.card = card;
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const waiter of waiters) {
        waiter(card);
    }
}

/** Ask for every href this session has not asked about yet. Called from the
 * embed plugin's idle pass, never on the keystroke path. */
export function queueLinkCardResolution(hrefs: Iterable<string>): void {
    for (const href of hrefs) {
        const existing = entries.get(href);
        if (existing?.asked || (existing && existing.state !== "pending")) {
            continue;
        }
        if (!existing && entries.size >= CACHE_LIMIT) {
            evictSettled();
        }
        const entry: Entry = existing ?? {
            state: "pending", card: null, waiters: [], timer: null, asked: false,
        };
        entry.asked = true;
        entry.timer = setTimeout(() => settle(href, null), REPLY_TIMEOUT_MS);
        entries.set(href, entry);
        const requestId = `linkcard_${Date.now()}_${++requestCounter}`;
        requests.set(requestId, href);
        notifyResolveLinkCard(requestId, href);
    }
}

/** Subscribe a card to its href's metadata: a known answer calls back
 * synchronously, a pending one when the reply lands, an unasked one when
 * the plugin's idle pass asks. */
export function subscribeLinkCardMeta(href: string, apply: (card: LinkCardMeta | null) => void): void {
    const entry = entries.get(href);
    if (!entry) {
        entries.set(href, { state: "pending", card: null, waiters: [apply], timer: null, asked: false });
        return;
    }
    if (entry.state === "pending") {
        entry.waiters.push(apply);
        return;
    }
    apply(entry.card);
}

/** Route a `linkCardResult` reply to its entry (messageHandlers). */
export function handleLinkCardResult(requestId: string, card: LinkCardMeta | null): void {
    const href = requests.get(requestId);
    if (!href) {
        return;
    }
    requests.delete(requestId);
    settle(href, card);
}
