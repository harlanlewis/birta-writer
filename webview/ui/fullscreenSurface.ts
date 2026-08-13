/**
 * webview/ui/fullscreenSurface.ts
 *
 * The one fullscreen surface. Every "open this bigger" gesture over the
 * DOCUMENT — a diagram, a code block, an image, an embedded player — goes
 * through here, so they share an anatomy instead of four hand-rolled overlays
 * that drifted apart (the image one had never locked body scroll, and none but
 * the diagram used the shared dismiss layer).
 *
 * One preview is deliberately NOT one of these: the image picker's enlarge
 * (`showLightbox` in components/toolbar/imageInsertPanel.ts) opens from inside the
 * image-insert modal, not from the document. It has to stack above that modal
 * where this surface stacks below it, and its Escape has to return the user to
 * the picker rather than dismiss both. Folding it in needs an answer for a
 * fullscreen surface opened from within another modal, and there is not one
 * yet.
 *
 * ── The two questions ────────────────────────────────────────────────────
 *
 * Everything below falls out of asking two things about the content:
 *
 * 1. **Do we render its interior?** We render diagrams and code. We do NOT
 *    render an embedded player — Figma and YouTube put their own controls in
 *    their own corners, and anything we float over them is a collision waiting
 *    for a viewport size.
 * 2. **Is it a canvas, an object, or a sheet?** A diagram is a CANVAS:
 *    unbounded, pan/zoomable, carrying its own paper colour. A photo or a
 *    player is an OBJECT: bounded, with edges of its own. A code editor is a
 *    SHEET: a working surface you type into.
 *
 * ── Three grounds ────────────────────────────────────────────────────────
 *
 * - `canvas` — the backdrop IS the content's paper, edge to edge. No card, no
 *   radius, no shadow. Those say "a page floating on a surface", which is a
 *   lie about a thing that extends past the viewport the moment you zoom; and
 *   a card whose fill is the canvas colour on a scrim mixed from the same
 *   theme is a rectangle you cannot see (which is how this started).
 * - `scrim` — a neutral dark wash, the photo-viewer convention. An object has
 *   its own edges and wants contrast behind them, not a colour match.
 * - `sheet` — an opaque working surface filling the viewport, with the chrome
 *   band reserved rather than floated, because text must not run under
 *   buttons.
 *
 * ── One geography ────────────────────────────────────────────────────────
 *
 * The same four corners on every surface, and deliberately the same ones the
 * INLINE diagram pane uses, so going fullscreen does not relocate a control
 * the user just had their pointer on:
 *
 *     top-left      identity (what am I looking at)
 *     top-right     actions: view controls · hairline · modes · CLOSE LAST
 *     bottom-right  viewport navigation (pan pad, fit) — only where it pans
 *     bottom-left   nothing, deliberately
 *
 * Close is always the final item of the top-right cluster. That is the one
 * position a user should never have to look for.
 *
 * The clusters are positioned against the VIEWPORT, not the content — which
 * is what makes the embed case work with no branch in the code. A diagram
 * fills the viewport, so the cluster floats over it; a player is inset inside
 * it, so the identical coordinates put the cluster in the margin BESIDE the
 * player rather than over its controls. One rule, two right answers.
 */
import { IconX } from "./icons";
import { applyTooltip } from "./tooltip";
import { t } from "@/i18n";
import { lockBodyScroll, unlockBodyScroll, animateCloseLightbox, bindLightboxDismiss } from "@/utils";
import "./fullscreen.css";

export type FullscreenGround = "canvas" | "scrim" | "sheet";

export type FullscreenSurface = {
    /** The fixed overlay element. Owned here; callers rarely need it. */
    readonly overlay: HTMLElement;
    /** Where the caller puts the thing being shown. */
    readonly content: HTMLElement;
    /** The bottom-right navigation cluster. Empty (and invisible) until used. */
    readonly nav: HTMLElement;
    /**
     * Add a group of controls to the top-right cluster, before the group Close
     * lives in. Returns the group, for `setActionGroupHidden`.
     *
     * Groups rather than loose controls plus a manual separator, because the
     * divider is a statement about what is on either side of it. Drawn by hand
     * it outlives its neighbours: hiding the zoom controls in code mode left a
     * hairline dividing nothing from Close.
     */
    addActionGroup(...controls: HTMLElement[]): HTMLElement;
    /** Show or hide a group. Dividers recompute; only the gaps that separate
     *  two VISIBLE groups are drawn. */
    setActionGroupHidden(group: HTMLElement, hidden: boolean): void;
    /** Set the top-left identity text. */
    setTitle(text: string): void;
    /** Swap the ground after opening (a diagram lightbox flipping to code). */
    setGround(ground: FullscreenGround): void;
    /**
     * Paint a `canvas` ground from the content's own paper colour. Takes a CSS
     * value, so a caller can hand over a `var(--…)` and keep tracking the theme.
     */
    setCanvasColor(cssColor: string): void;
    /**
     * Synchronous teardown of the dismiss layer, then the close animation.
     * Idempotent: a second call during the fade does nothing.
     */
    close(): void;
    /**
     * The dismiss cleanup, exposed for owners that must tear a surface down
     * from the outside (a NodeView dying with its lightbox open). Null once a
     * close has begun.
     */
    dismissCleanup: (() => void) | null;
};

export function openFullscreenSurface(opts: {
    ground: FullscreenGround;
    /** Top-left identity. Omit for a surface that needs none. */
    title?: string;
    /** Extra class on the overlay, for per-surface rules. */
    className?: string;
    /**
     * Runs once, synchronously, at the start of the close path — before the
     * fade. Write-back belongs here, not in an animationend handler.
     */
    onClose?: () => void;
}): FullscreenSurface {
    const overlay = document.createElement("div");
    overlay.className = `fs-surface fs-surface--${opts.ground}${opts.className ? ` ${opts.className}` : ""}`;
    // The overlay takes focus on open so the editor behind it stops receiving
    // keystrokes (MAR-267). It is a surface, not a control — no focus ring.
    overlay.tabIndex = -1;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    if (opts.title) overlay.setAttribute("aria-label", opts.title);

    const content = document.createElement("div");
    content.className = "fs-content";
    // `bindLightboxDismiss` treats a click on the OVERLAY as a backdrop click.
    // This wrapper covers the overlay edge to edge, so without this second
    // binding every backdrop click lands on it instead and dismisses nothing —
    // which is what happened to the image lightbox the moment its <img> stopped
    // being a direct child of the overlay. A surface whose content handles its
    // own drag (the diagram pane) calls preventDefault and never reaches here.
    content.addEventListener("mousedown", (e) => {
        if (e.target === content) surface.close();
    });

    const title = document.createElement("div");
    title.className = "fs-title";
    title.textContent = opts.title ?? "";

    const actions = document.createElement("div");
    actions.className = "fs-actions";
    actions.contentEditable = "false";

    const nav = document.createElement("div");
    nav.className = "fs-nav";
    nav.contentEditable = "false";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ui-btn fs-btn fs-btn--close";
    closeBtn.tabIndex = -1;
    closeBtn.innerHTML = IconX;
    closeBtn.setAttribute("aria-label", t("Close"));
    applyTooltip(closeBtn, t("Close"), { placement: "below" });

    // Close's own group, always last, and never divided from what precedes it:
    // the hairline separates the CALLER's groups from each other, and Close is
    // the terminal control that sits with the last of them. Its own group only
    // so a caller's groups have somewhere to be inserted before.
    const closeGroup = document.createElement("div");
    closeGroup.className = "fs-actions__group fs-actions__group--close";
    closeGroup.appendChild(closeBtn);
    actions.appendChild(closeGroup);

    /**
     * Mark every visible group after the first, which is what the CSS draws a
     * divider from. Recomputed rather than set once, because a group hidden by
     * a mode change must take its divider with it.
     */
    function syncDividers(): void {
        const visible = [...actions.querySelectorAll<HTMLElement>(".fs-actions__group")]
            .filter((group) => !group.hidden && group !== closeGroup);
        visible.forEach((group, i) => group.toggleAttribute("data-divided", i > 0));
    }

    overlay.append(content, title, actions, nav);
    document.body.appendChild(overlay);
    overlay.focus();
    lockBodyScroll();

    const surface: FullscreenSurface = {
        overlay,
        content,
        nav,
        dismissCleanup: null,
        addActionGroup(...controls) {
            const group = document.createElement("div");
            group.className = "fs-actions__group";
            group.append(...controls);
            actions.insertBefore(group, closeGroup);
            syncDividers();
            return group;
        },
        setActionGroupHidden(group, hidden) {
            group.hidden = hidden;
            syncDividers();
        },
        setTitle(text) {
            title.textContent = text;
            overlay.setAttribute("aria-label", text);
        },
        setGround(ground) {
            overlay.classList.remove("fs-surface--canvas", "fs-surface--scrim", "fs-surface--sheet");
            overlay.classList.add(`fs-surface--${ground}`);
        },
        setCanvasColor(cssColor) {
            overlay.style.setProperty("--fs-canvas", cssColor);
        },
        close() {
            // Already closing: the dismiss layer is torn down synchronously on
            // the first call, so a second Escape during the fade is a no-op
            // rather than a second write-back.
            if (!surface.dismissCleanup) return;
            surface.dismissCleanup();
            surface.dismissCleanup = null;
            opts.onClose?.();
            unlockBodyScroll();
            animateCloseLightbox(overlay, () => {});
        },
    };

    surface.dismissCleanup = bindLightboxDismiss(overlay, closeBtn, () => surface.close());
    return surface;
}
