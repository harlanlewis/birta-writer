/**
 * ui/toast.ts: the webview's transient corner and edge messages, in one place.
 *
 * A toast is news (docs/DESIGN_PRINCIPLES.md, "advisory, reversible, quiet"):
 * something happened, here is what, it goes on its own. Nothing here is a
 * control the user has to deal with: a message that has to be ACTED on
 * belongs in the document or in the host's own chrome.
 *
 * A message may last as long as the thing it is about (`persist`), and then
 * its owner is what takes it away, with `hide`. That is still news rather
 * than state: it says what is happening and offers nothing to do about it,
 * and when the thing it reports ends there is nothing left behind.
 *
 * One element per SURFACE, reused. The surface class is what carries placement
 * and how long the message lives is what carries urgency, so two callers
 * wanting messages in two different corners get two surfaces and one
 * implementation. Reuse rather than a fresh node per message is deliberate:
 * a burst of vetoes must leave one pill on screen rather than a stack of them.
 *
 * The `aria-live` clear-then-set is load-bearing and easy to lose. A live
 * region announces on CHANGE, so writing an identical string into a node that
 * already holds it is silent to a screen reader, which is exactly the repeat
 * case (the same veto twice).
 *
 * Whether a message announces at all is the caller's, for the same reason its
 * tone and dwell are. A message that REWRITES itself while nothing happened,
 * a line following a process that is still running, would otherwise be read
 * out on every rewrite, which is worse than silence; what announces such a
 * thing is its own control, once. The attribute is written on every call,
 * because the node outlives any one message and a surface's first message
 * would otherwise decide for every message after it.
 */

/** What the message IS, which is what colours it. */
export type ToastTone = "info" | "error";

export interface ToastOptions {
    /**
     * The surface class, which owns placement. Also the identity of the
     * reused node: two calls with the same surface share one element.
     */
    readonly surface: string;
    readonly tone?: ToastTone;
    /** How long before it fades. Ignored when `persist` is set. */
    readonly dwellMs?: number;
    /** Whether a click takes it away early. */
    readonly dismissible?: boolean;
    /**
     * Hold it until the caller calls `hide`, because what it reports is still
     * going on. The caller owns taking it away; a surface left holding one of
     * these says something that is no longer true.
     */
    readonly persist?: boolean;
    /** Whether a screen reader is told. Default yes; see the header. */
    readonly announce?: boolean;
}

/** Long enough to read a short sentence without pinning the corner. */
const DEFAULT_DWELL_MS = 4000;

interface LiveToast {
    readonly el: HTMLElement;
    timer?: ReturnType<typeof setTimeout>;
    /**
     * Read at click time rather than at build time. The node outlives any one
     * message, so a listener attached only for a dismissible message would
     * still be there for the next one, and a surface's FIRST message would
     * silently decide the behaviour of every message after it.
     */
    dismissible: boolean;
}

const live = new Map<string, LiveToast>();

function build(surface: string): LiveToast {
    const el = document.createElement("div");
    el.className = `ui-notice ${surface}`;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    const entry: LiveToast = { el, dismissible: false };
    // A toast goes on its own; this is only for somebody who has read it and
    // wants the corner back. Whether the pointer reaches it at all is the
    // surface class's decision.
    el.addEventListener("mousedown", (e) => {
        if (!entry.dismissible) { return; }
        e.preventDefault();
        hide(surface);
    });
    document.body.appendChild(el);
    return entry;
}

/** Take the message off screen, leaving the node for the next one. */
export function hide(surface: string): void {
    const entry = live.get(surface);
    if (!entry) { return; }
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.el.classList.remove(`${surface}--visible`);
}

/**
 * Show `message` on `surface`, replacing whatever that surface was saying.
 *
 * Returns the element, for a caller that has to read it back; callers should
 * not hold on to it, since the next message reuses the same node.
 */
export function showToast(message: string, opts: ToastOptions): HTMLElement | null {
    if (typeof document === "undefined") { return null; }
    let entry = live.get(opts.surface);
    if (!entry || !entry.el.isConnected) {
        entry = build(opts.surface);
        live.set(opts.surface, entry);
    }
    entry.dismissible = opts.dismissible ?? false;
    const { el } = entry;
    el.classList.toggle("ui-notice--error", opts.tone === "error");
    // A message a click cannot take away must not take the click. Otherwise
    // the corner it sits in stops being the document's for as long as it is
    // up, which for a message that follows a running process is its whole
    // life. Written per call, like aria-live and for the same reason.
    el.classList.toggle("ui-notice--static", !entry.dismissible);
    el.setAttribute("aria-live", opts.announce === false ? "off" : "polite");
    // See the header: a live region is silent on a rewrite of the same string.
    el.textContent = "";
    el.textContent = message;
    el.classList.add(`${opts.surface}--visible`);
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!opts.persist) {
        entry.timer = setTimeout(() => {
            el.classList.remove(`${opts.surface}--visible`);
        }, opts.dwellMs ?? DEFAULT_DWELL_MS);
    }
    return el;
}
