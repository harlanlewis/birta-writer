/**
 * webview/components/unfurlOffer — the "use this title?" affordance for
 * paste-unfurl.
 *
 * Why this exists: a fetched page title arrives SECONDS after the paste, over
 * the network, and applying it rewrites text in the user's document and marks
 * the file dirty — at a moment the user is not watching and did not ask for
 * anything. docs/DESIGN_PRINCIPLES.md is explicit that "nothing changes the
 * file without consent" and that suggestions "apply on click, never
 * automatically". So the title is OFFERED here and the document is untouched
 * until the user takes it. `birta.pasteUnfurl.autoApply` restores the silent
 * upgrade for anyone who wants it, exactly as `birta.calc.autoInsert` does for
 * calc's advisory suggestion.
 *
 * Why not the caret-suggest menu calc uses: that infrastructure matches on the
 * text before the CARET and is synchronous. An unfurl reply is asynchronous and
 * belongs to a doc RANGE — by the time it lands the caret may be in another
 * paragraph entirely. So this borrows the shape of the sibling affordance that
 * already solves "anchored, async, dismissable, one at a time": the network
 * opt-in pill (components/networkOptIn), and the same shared chrome underneath
 * it (ui/anchoredPlacement).
 *
 * Quiet by construction: it never steals focus, never blocks typing, and goes
 * away on Escape, an outside click, the × button, or on its own after a few
 * seconds. Letting it fade is a "no" that costs nothing — the bare `[url](url)`
 * link the paste already inserted is the offline-safe result either way.
 */
import { notifySetPasteUnfurlAutoApply } from "@/messaging";
import { t } from "@/i18n";
import { computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";
import "./unfurlOffer.css";

/** Viewport rect of an anchor (matches DOMRect's edges), for placement. */
interface AnchorRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface UnfurlOfferOptions {
    /** The fetched page title being offered as the link's text. */
    title: string;
    /**
     * Viewport rect of the bare link to anchor under. Null when it couldn't be
     * measured (detached view / jsdom) — the offer still shows and works, it
     * just skips positioning.
     */
    anchorRect: AnchorRect | null;
    /** Apply the title to the document. Runs for both "Use title" and "Always". */
    onAccept: () => void;
}

/**
 * How long the offer waits before fading. Long enough to notice and act on,
 * short enough that an ignored offer doesn't linger over the text. Declining by
 * doing nothing is the safe default: the bare link stays.
 */
const OFFER_TIMEOUT_MS = 12000;

// One offer at a time: a second unfurl landing while one is open replaces it,
// so the surface never stacks. Module singleton, mirroring the editor-view
// singleton exception in AGENTS.md.
let current: { el: HTMLElement; dispose: () => void } | null = null;

/** Tear down the live offer (idempotent). */
function closeCurrent(): void {
    if (!current) { return; }
    current.dispose();
    current.el.remove();
    current = null;
}

/** The "always" row's label — a function so i18n resolves at build time. */
function alwaysLabel(): string {
    return t("Always use fetched titles");
}

/**
 * Offer `title` as the text for a just-unfurled link. The caller has already
 * inserted the bare `[url](url)`, so declining needs no cleanup.
 */
export function offerUnfurlTitle(opts: UnfurlOfferOptions): void {
    if (typeof document === "undefined") { return; }
    closeCurrent();

    const el = document.createElement("div");
    el.className = "ui-notice unfurl-offer";
    el.setAttribute("role", "status");
    // Announced without interrupting, matching the network opt-in pill.
    el.setAttribute("aria-live", "polite");

    const row = document.createElement("div");
    row.className = "unfurl-offer__row";

    const label = document.createElement("span");
    label.className = "unfurl-offer__title";
    // The title is plain text from a fetched page: assign via textContent so it
    // can never be interpreted as markup here.
    label.textContent = opts.title;
    label.title = opts.title; // full text on hover when the pill truncates it

    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "ui-btn ui-btn--accent unfurl-offer__accept";
    acceptBtn.textContent = t("Use title");
    acceptBtn.title = t("Replace the link text with this page title");

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "ui-btn ui-btn--icon ui-notice__dismiss unfurl-offer__dismiss";
    dismissBtn.setAttribute("aria-label", t("Keep the plain link"));
    dismissBtn.textContent = "×";

    row.append(label, acceptBtn, dismissBtn);

    // Second row, mirroring calc's "Always insert result": the settings escape
    // hatch lives with the suggestion that prompted it, so the user never has to
    // go hunting for why they're being asked.
    const alwaysBtn = document.createElement("button");
    alwaysBtn.type = "button";
    alwaysBtn.className = "ui-btn unfurl-offer__always";
    alwaysBtn.textContent = alwaysLabel();
    alwaysBtn.title = t("Apply fetched titles without asking (birta.pasteUnfurl.autoApply)");

    el.append(row, alwaysBtn);
    document.body.appendChild(el);

    /** Decline: the bare link the paste inserted is already the right answer. */
    function dismiss(): void {
        closeCurrent();
    }

    function accept(): void {
        opts.onAccept();
        closeCurrent();
    }

    function acceptAlways(): void {
        // Flip the in-session gate first so a second unfurl already in flight
        // applies silently, then persist through the write-back seam.
        if (window.__i18n) { window.__i18n.pasteUnfurlAutoApply = true; }
        notifySetPasteUnfurlAutoApply(true);
        accept();
    }

    // mousedown + preventDefault so clicking never moves the editor selection
    // (same contract as the network opt-in pill and ui/foldEllipsis).
    const onButton = (button: HTMLElement, run: () => void): void => {
        button.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            run();
        });
    };
    onButton(acceptBtn, accept);
    onButton(dismissBtn, dismiss);
    onButton(alwaysBtn, acceptAlways);

    // Escape and an outside click both mean "no" — and "no" here costs nothing,
    // so neither needs a confirmation.
    const onKeydown = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
            e.stopPropagation();
            dismiss();
        }
    };
    const onOutside = (e: MouseEvent): void => {
        if (!el.contains(e.target as Node)) { dismiss(); }
    };
    document.addEventListener("keydown", onKeydown, true);
    // Deferred a tick so a click that happens to land in the same frame the
    // reply arrives doesn't dismiss the offer before it is even seen.
    let outsideBound = false;
    const bindOutside = (): void => {
        if (outsideBound) { return; }
        outsideBound = true;
        document.addEventListener("mousedown", onOutside);
    };
    const outsideTimer = setTimeout(bindOutside, 0);
    const fadeTimer = setTimeout(() => {
        if (current?.el === el) { closeCurrent(); }
    }, OFFER_TIMEOUT_MS);

    current = {
        el,
        dispose: () => {
            clearTimeout(outsideTimer);
            clearTimeout(fadeTimer);
            document.removeEventListener("keydown", onKeydown, true);
            if (outsideBound) { document.removeEventListener("mousedown", onOutside); }
        },
    };

    // Placement is best-effort: an unmeasurable rect leaves the offer
    // unpositioned but fully functional.
    if (opts.anchorRect) {
        try {
            const placed = computeAnchoredPosition(
                opts.anchorRect,
                { width: el.offsetWidth, height: el.offsetHeight },
                viewportSize(),
            );
            el.style.top = `${placed.top + window.scrollY}px`;
            el.style.left = `${placed.left + window.scrollX}px`;
        } catch {
            /* positioning is best-effort; the offer is still usable */
        }
    }

    requestAnimationFrame(() => el.classList.add("unfurl-offer--visible"));
}

/** Whether an offer is currently shown (test/inspection helper). */
export function isUnfurlOfferOpen(): boolean {
    return current !== null;
}

/** Reset the module's state — for unit tests only. */
export function __resetUnfurlOfferForTests(): void {
    closeCurrent();
}
