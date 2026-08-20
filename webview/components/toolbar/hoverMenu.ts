/**
 * The shared open/close lifecycle for a toolbar dropdown. Every toolbar
 * dropdown (Format, Font, Settings, Checks, Debug, ⋯ overflow) positions itself
 * with placeMenu and shares one code path here, so all menus behave identically
 * and a new one is correct by construction — the gap-bridge bug that once
 * affected only the Debug menu can't recur.
 *
 * WHICH gesture opens one is the surface's (`barMenusOnClick`,
 * shared/hostProfile.ts), and the two halves have different failure modes.
 * On hover the menu must hold open while the pointer crosses the small gap
 * between the button and the menu. On click it must close on a press
 * anywhere else, INCLUDING another menu's trigger; nothing about a pointer
 * leaving does it, so `ui/outsidePress.ts` stands in for the mouseleave.
 */
import { placeMenu, MENU_CLIP_ATTR, MENU_GAP } from "@/ui/anchoredPlacement";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { watchOutsidePress } from "@/ui/outsidePress";
import { hostArranges } from "../../../shared/hostProfile";

export interface HoverMenuOptions {
    /** Runs immediately before the menu is shown — e.g. repaint checkmarks. */
    onOpen?: () => void;
    /**
     * Grace period before hiding once the pointer leaves the wrap. Defaults to
     * 0 (instant): the button→menu gap is bridged by a transparent CSS strip
     * (`.tb-fmt-wrap.tb-menu-open::after`, sized to MENU_GAP) so the pointer
     * never leaves the wrap while crossing it — no timer is needed to hold the
     * menu open. Leaving the wrap for real closes it at once, so switching
     * between adjacent dropdowns never briefly stacks them.
     */
    hideDelayMs?: number;
    /**
     * Hover-intent delay before OPENING on hover (mouse only — keyboard opens
     * are always instant). Guards against menus flashing open while the cursor
     * merely sweeps across the bar. Leaving before it elapses cancels the open.
     */
    openDelayMs?: number;
}

export interface HoverMenuHandle {
    /**
     * THE close path for this menu — the only one that unregisters the
     * Escape layer and resets aria-expanded/tb-menu-open. Item handlers
     * that dismiss the menu after a pick must call this, never hide the
     * menu element directly (a direct `style.display = "none"` leaks the
     * layer entry, and the next editor-focused Escape dies on it).
     */
    close: () => void;
    /** Removes the listeners and clears any pending timer. */
    dispose: () => void;
}

/**
 * Wire `wrap`'s hover to open/close `menu`, positioned relative to `button`.
 * `wrap` must contain both `button` and `menu` in the DOM. Returns the shared
 * `close` (for item handlers that dismiss after a pick) and a `dispose` that
 * removes the listeners and clears any pending timer.
 *
 * Keyboard: Enter/Space toggles the menu from the trigger (ArrowDown/ArrowUp
 * always open), arrows rove focus over the menu's rows, Enter/Space activates
 * the focused row by replaying the mousedown its handlers listen for, and
 * Escape (or tabbing out of the wrap) closes and restores trigger focus.
 * Hover-opening never moves focus — the editor selection stays untouched.
 */
export function wireHoverMenu(
    wrap: HTMLElement,
    button: HTMLElement,
    menu: HTMLElement,
    options: HoverMenuOptions = {},
): HoverMenuHandle {
    /**
     * How long a hide waits, so the pointer can cross the gap to the menu.
     *
     * Zero for a menu whose wrap can carry the CSS bridge, which is every menu
     * in the top bar. Inside a clipping container the menu is positioned in
     * viewport coordinates (`placeMenu`, `MENU_CLIP_ATTR`) and the bridge is
     * clipped away with everything else that leaves the box, so the pointer
     * really does leave the wrap on the way in and a timer is what holds the
     * menu. `menu.mouseenter` cancels the hide, so the delay only has to
     * outlast the crossing, never the reading.
     *
     * Asked at hide time and NOT at construction, which is the trap: every
     * item is built before it is parented into its holder, so a `closest` call
     * here in the body runs against an element with no ancestors at all and
     * answers "not clipped" for every menu there is.
     */
    const hideDelayMs = (): number =>
        options.hideDelayMs ?? (button.closest(`[${MENU_CLIP_ATTR}]`) ? 160 : 0);
    const openDelay = options.openDelayMs ?? 140;
    /**
     * Asked once, at wiring time, and read by both the listener set-up at the
     * bottom and the open path above it. Two reads could not disagree in the
     * product, where the declaration is injected before the bundle evaluates,
     * but a test that swaps the profile between them would wire a hover menu
     * that registers a click surface's outside-press watcher.
     */
    const onClickSurface = hostArranges("barMenusOnClick");
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    // Escape-layer unregister handle (null while closed): a hover-opened
    // menu leaves focus in the editor, where Escape routes through the
    // layer stack (blockKeys) — registering makes that Escape close the
    // menu instead of block-selecting under it.
    let escapeOff: (() => void) | null = null;
    // Outside-press unregister handle (null while closed). Only ever set
    // under `barMenusOnClick`; see the `open` path below.
    let outsideOff: (() => void) | null = null;

    const cancelHide = (): void => {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    };
    const cancelOpen = (): void => {
        if (openTimer !== null) {
            clearTimeout(openTimer);
            openTimer = null;
        }
    };
    const isOpen = (): boolean => menu.style.display === "flex";

    const open = (): void => {
        cancelHide();
        cancelOpen();
        options.onOpen?.();
        menu.style.display = "flex";
        placeMenu(button, menu);
        button.setAttribute("aria-expanded", "true");
        // Marks the wrap so its ::after gap-bridge is live only while open.
        wrap.classList.add("tb-menu-open");
        escapeOff ??= registerEscapeLayer(close);
        // Only under `barMenusOnClick`: a hover menu already closes the moment
        // the pointer leaves its wrap, so there is no state left for an
        // outside press to resolve. The wrap holds both the trigger and the
        // menu, so one element covers both halves.
        if (onClickSurface) { outsideOff ??= watchOutsidePress([wrap], close); }
    };
    const close = (): void => {
        escapeOff?.();
        escapeOff = null;
        outsideOff?.();
        outsideOff = null;
        cancelHide();
        cancelOpen();
        menu.style.display = "none";
        button.setAttribute("aria-expanded", "false");
        wrap.classList.remove("tb-menu-open");
    };
    const scheduleHide = (): void => {
        cancelOpen(); // a pending hover-open is abandoned when the pointer leaves
        cancelHide();
        hideTimer = setTimeout(close, hideDelayMs());
    };
    // Hover open, gated by an intent delay so a cursor sweeping across the bar
    // doesn't flash menus. Already-open (from an adjacent switch) opens at once.
    const scheduleOpen = (): void => {
        cancelHide();
        // A disabled trigger (read-only dims every mutating item's buttons)
        // opens nothing: the menu would offer rows the trigger already says
        // are unavailable, and its rows are disabled with it.
        if (isOpen() || openTimer !== null) { return; }
        if (button instanceof HTMLButtonElement && button.disabled) { return; }
        openTimer = setTimeout(() => { openTimer = null; open(); }, openDelay);
    };

    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    // Publish the JS gap constant to CSS so the ::after bridge sizes itself from
    // the single source of truth (MENU_GAP), never a hardcoded duplicate.
    wrap.style.setProperty("--tb-menu-gap", `${MENU_GAP}px`);

    // Activatable rows: menu items are mousedown-wired divs, plus any real
    // buttons a menu embeds (e.g. the font-size stepper, overflowed tb-btns).
    const rows = (): HTMLElement[] =>
        Array.from(menu.querySelectorAll<HTMLElement>(".tb-fmt-item, button"))
            .filter((el) => !el.hidden && el.style.display !== "none");
    const focusRow = (el: HTMLElement | undefined): void => {
        if (el) {
            el.tabIndex = -1;
            el.focus();
        }
    };

    const onButtonKeydown = (e: KeyboardEvent): void => {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            if (isOpen() && (e.key === "Enter" || e.key === " ")) {
                close();
            } else {
                open();
                focusRow(rows()[e.key === "ArrowUp" ? rows().length - 1 : 0]);
            }
        } else if (e.key === "Escape" && isOpen()) {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };
    const onMenuKeydown = (e: KeyboardEvent): void => {
        const list = rows();
        const idx = list.indexOf(e.target as HTMLElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            const delta = e.key === "ArrowDown" ? 1 : -1;
            focusRow(list[(idx + delta + list.length) % list.length]);
        } else if (e.key === "Enter" || e.key === " ") {
            // preventDefault also suppresses the native keyboard click a
            // focused <button> row would fire, so the action runs once.
            e.preventDefault();
            e.stopPropagation();
            (e.target as HTMLElement).dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
            );
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
            button.focus();
        }
    };
    const onWrapFocusout = (e: FocusEvent): void => {
        if (isOpen() && !(e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget))) {
            close();
        }
    };

    /**
     * Where the surface says its bar menus open on click, the pointer opens
     * nothing (`barMenusOnClick`, shared/hostProfile.ts).
     *
     * The trigger's own mousedown is already swallowed by `createMenuTrigger`,
     * so the toggle rides on `click`, which still arrives. Everything else is
     * unchanged: the same `open`/`close` pair, the same Escape layer, the same
     * keyboard path, and closing still happens on focusout and on Escape.
     *
     * A press anywhere else closes it through `watchOutsidePress`, which is a
     * listener of its own and not the Escape layer. The layer stack answers
     * the Escape KEY and nothing else, so a click surface that leaned on it
     * for this held every menu it had ever opened on screen at once.
     */
    const onClick = (e: MouseEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        if (isOpen()) { close(); } else { open(); }
    };

    if (onClickSurface) {
        button.addEventListener("click", onClick);
    } else {
        wrap.addEventListener("mouseenter", scheduleOpen);
        wrap.addEventListener("mouseleave", scheduleHide);
        menu.addEventListener("mouseenter", cancelHide);
    }
    button.addEventListener("keydown", onButtonKeydown);
    menu.addEventListener("keydown", onMenuKeydown);
    wrap.addEventListener("focusout", onWrapFocusout);

    return {
        close,
        dispose: (): void => {
            escapeOff?.();
            escapeOff = null;
            outsideOff?.();
            outsideOff = null;
            cancelHide();
            cancelOpen();
            button.removeEventListener("click", onClick);
            wrap.removeEventListener("mouseenter", scheduleOpen);
            wrap.removeEventListener("mouseleave", scheduleHide);
            menu.removeEventListener("mouseenter", cancelHide);
            button.removeEventListener("keydown", onButtonKeydown);
            menu.removeEventListener("keydown", onMenuKeydown);
            wrap.removeEventListener("focusout", onWrapFocusout);
        },
    };
}
