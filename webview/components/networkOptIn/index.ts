/**
 * webview/components/networkOptIn — the just-in-time "Enable network features"
 * affordance (MAR-179).
 *
 * Birta is offline by default (the master switch `birta.network.enabled` ships
 * off). A feature that would contact the network — paste-unfurl today — must
 * not silently do nothing when the switch is off: that loses the capability.
 * Instead, the moment the user does the thing that WOULD use the network, this
 * surfaces a small, quiet, dismissable affordance anchored at the relevant spot
 * offering to turn the master switch on.
 *
 * Design (docs/DESIGN_PRINCIPLES.md — "annotation is advisory, reversible, and
 * quiet"): it never blocks the paste/typing, never steals focus, and going away
 * is one click (× / Escape / outside). It reuses the codebase's existing chrome
 * — the anchored-placement engine (ui/anchoredPlacement) the link popup and
 * suggest menus use — rather than building a new positioning system, and a
 * content-guard-notice-style themed pill for the look.
 *
 * "Enable" writes the setting through the config write-back seam
 * (notifySetNetworkEnabled → the extension's `updateSettingRespectingScope`),
 * flips the in-session gate (`window.__i18n.network`) so the feature works for
 * the rest of the session without a reload, and runs the caller's `onEnable`
 * so the just-triggered action (e.g. the pasted link's title fetch) happens
 * immediately rather than only "going forward".
 *
 * "Don't nag": a dismissal suppresses the affordance for the rest of the
 * session (module-scoped flag) — the user said no, so we stop asking until the
 * next reload. Accepting does not suppress (there's nothing left to ask).
 */
import type { EditorView } from "@/pm";
import { notifySetNetworkEnabled } from "@/messaging";
import { t } from "@/i18n";
import { computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";
import "./networkOptIn.css";

/** Viewport rect of an anchor (matches DOMRect's edges), for placement. */
interface AnchorRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface NetworkOptInOptions {
    /** The message shown before the Enable button, e.g. "Fetch link title?". */
    label: string;
    /**
     * The viewport rect to anchor the affordance below/above — usually the
     * range of the just-pasted link, measured with view.coordsAtPos. Null when
     * measurement failed (detached view / jsdom): the affordance still shows
     * and functions, it just skips positioning rather than being suppressed.
     */
    anchorRect: AnchorRect | null;
    /**
     * Run after the master switch is enabled (setting written + in-session gate
     * flipped). Lets the caller complete the just-triggered action now — e.g.
     * fire the pasted link's unfurl — instead of only applying going forward.
     */
    onEnable: () => void;
}

// One affordance at a time: a second paste while one is open replaces it, so
// the surface never stacks. Module singleton, mirroring the editor-view
// singleton exception in CLAUDE.md ("singletons like the editor view").
let current: { el: HTMLElement; dispose: () => void } | null = null;

// "Don't nag": once dismissed, stay quiet for the rest of the session. Reset
// only on reload (a fresh webview) or the test hook below. Accepting does not
// set this — there's nothing left to offer once network is on.
let suppressedForSession = false;

/** Tear down the live affordance (idempotent). */
function closeCurrent(): void {
    if (!current) { return; }
    current.dispose();
    current.el.remove();
    current = null;
}

/**
 * Whether an opt-in would be offered right now: only when the master switch is
 * off (offline) and the user hasn't already dismissed one this session. Pure
 * and exported so the decision is unit-testable without the DOM.
 */
export function shouldOfferNetworkOptIn(): boolean {
    return !(window.__i18n?.network ?? false) && !suppressedForSession;
}

/**
 * Show the opt-in affordance anchored at `opts.anchorRect`. A no-op when the
 * master switch is already on or the user dismissed one this session (so the
 * caller can always call it unconditionally after inserting the plain link).
 */
export function offerNetworkOptIn(opts: NetworkOptInOptions): void {
    if (typeof document === "undefined") { return; }
    if (!shouldOfferNetworkOptIn()) { return; }

    // Replace any live affordance — only one at a time.
    closeCurrent();

    const el = document.createElement("div");
    el.className = "network-optin";
    el.setAttribute("role", "status");
    // aria-live polite: announced without interrupting, matching the guard notice.
    el.setAttribute("aria-live", "polite");

    const label = document.createElement("span");
    label.className = "network-optin__label";
    label.textContent = opts.label;

    const enableBtn = document.createElement("button");
    enableBtn.type = "button";
    enableBtn.className = "network-optin__enable";
    enableBtn.textContent = t("Enable");
    // Scope transparency (MAR-184): the write lands in user settings unless a
    // workspace value already exists, so say what accepting actually does.
    enableBtn.title = t("Turns on network features (birta.network.enabled) — applies in all your workspaces");

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "network-optin__dismiss";
    dismissBtn.setAttribute("aria-label", t("Dismiss"));
    dismissBtn.textContent = "×"; // ×

    el.append(label, enableBtn, dismissBtn);
    document.body.appendChild(el);

    /** Dismiss WITHOUT enabling: closes and suppresses for the session. */
    function dismiss(): void {
        suppressedForSession = true;
        closeCurrent();
    }

    /** Accept: write the setting, flip the in-session gate, run onEnable. */
    function enable(): void {
        // Persist the master switch through the write-back seam. The extension
        // owns the settings write (scope-respecting), exactly like the toolbar
        // controls; this is the intent message.
        notifySetNetworkEnabled(true);
        // Flip the in-session gate so the feature works immediately for the rest
        // of this session — the config-change broadcast does NOT recompose the
        // webview (no reload), so without this the just-pasted link and any
        // paste before the next reload would still be treated as offline.
        if (window.__i18n) {
            window.__i18n.network = true;
        }
        // Complete the just-triggered action now (e.g. fetch the pasted link's
        // title) rather than only applying to future pastes.
        opts.onEnable();
        // Not a dismissal — do NOT set the suppress flag; network is on now, so
        // shouldOfferNetworkOptIn() is already false and nothing more is offered.
        //
        // Instead of vanishing, the pill becomes a short-lived confirmation:
        // embed cards compose at editor creation (MAR-183), so a user who
        // enabled network for a provider link would otherwise see nothing
        // happen and read the feature as broken. Say what to expect.
        label.textContent = t("Network on — embed cards appear when a file is (re)opened");
        enableBtn.remove();
        dismissBtn.remove();
        el.classList.add("network-optin--confirmed");
        setTimeout(() => {
            // Only fade the confirmation if a newer affordance hasn't replaced it.
            if (current?.el === el) { closeCurrent(); }
        }, 6000);
    }

    // Pointer handlers use mousedown + preventDefault so the click never moves
    // the editor selection (the caret stays where the paste left it).
    enableBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        enable();
    });
    dismissBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
    });

    // Escape dismisses (quiet exit); an outside click dismisses too. Both are
    // the "no" answer, so they suppress for the session.
    const onKeydown = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
            e.stopPropagation();
            dismiss();
        }
    };
    const onOutside = (e: MouseEvent): void => {
        if (!el.contains(e.target as Node)) {
            dismiss();
        }
    };
    document.addEventListener("keydown", onKeydown, true);
    // Bubble phase, deferred a tick so the paste's own click doesn't immediately
    // dismiss it (the affordance is opened synchronously inside handlePaste).
    let outsideBound = false;
    const bindOutside = (): void => {
        if (outsideBound) { return; }
        outsideBound = true;
        document.addEventListener("mousedown", onOutside);
    };
    const outsideTimer = setTimeout(bindOutside, 0);

    current = {
        el,
        dispose: () => {
            clearTimeout(outsideTimer);
            document.removeEventListener("keydown", onKeydown, true);
            if (outsideBound) { document.removeEventListener("mousedown", onOutside); }
        },
    };

    // Place it (when a rect was measured). Positioning is best-effort — a
    // missing rect or a measurement throw in a detached/jsdom view leaves the
    // affordance unpositioned but still fully functional (the buttons work).
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
            /* positioning is best-effort; the affordance is still usable */
        }
    }

    // Fade in on the next frame (see the CSS transition).
    requestAnimationFrame(() => el.classList.add("network-optin--visible"));
}

/** Whether an affordance is currently shown (test/inspection helper). */
export function isNetworkOptInOpen(): boolean {
    return current !== null;
}

/** Reset the module's session state — for unit tests only. */
export function __resetNetworkOptInForTests(): void {
    closeCurrent();
    suppressedForSession = false;
}
