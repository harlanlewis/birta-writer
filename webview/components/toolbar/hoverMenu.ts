/**
 * The shared hover lifecycle for a toolbar dropdown. Every toolbar dropdown
 * (Format, Font, Settings, Checks, Debug, ⋯ overflow) opens on hover, positions
 * itself with placeMenu, and must hold open while the pointer crosses the small
 * gap between the button and the menu. Extracting it here means all menus behave
 * identically and a new one is correct by construction — the gap-bridge bug that
 * once affected only the Debug menu can't recur, because there's one code path.
 */
import { placeMenu, MENU_GAP } from "./menuPlacement";

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
}

/**
 * Wire `wrap`'s hover to open/close `menu`, positioned relative to `button`.
 * `wrap` must contain both `button` and `menu` in the DOM. Returns a disposer
 * that removes the listeners and clears any pending timer.
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
): () => void {
    const hideDelay = options.hideDelayMs ?? 0;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelHide = (): void => {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    };
    const isOpen = (): boolean => menu.style.display === "flex";
    const open = (): void => {
        cancelHide();
        options.onOpen?.();
        menu.style.display = "flex";
        placeMenu(button, menu);
        button.setAttribute("aria-expanded", "true");
        // Marks the wrap so its ::after gap-bridge is live only while open.
        wrap.classList.add("tb-menu-open");
    };
    const close = (): void => {
        cancelHide();
        menu.style.display = "none";
        button.setAttribute("aria-expanded", "false");
        wrap.classList.remove("tb-menu-open");
    };
    const scheduleHide = (): void => {
        cancelHide();
        hideTimer = setTimeout(close, hideDelay);
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

    wrap.addEventListener("mouseenter", open);
    wrap.addEventListener("mouseleave", scheduleHide);
    menu.addEventListener("mouseenter", cancelHide);
    button.addEventListener("keydown", onButtonKeydown);
    menu.addEventListener("keydown", onMenuKeydown);
    wrap.addEventListener("focusout", onWrapFocusout);

    return (): void => {
        cancelHide();
        wrap.removeEventListener("mouseenter", open);
        wrap.removeEventListener("mouseleave", scheduleHide);
        menu.removeEventListener("mouseenter", cancelHide);
        button.removeEventListener("keydown", onButtonKeydown);
        menu.removeEventListener("keydown", onMenuKeydown);
        wrap.removeEventListener("focusout", onWrapFocusout);
    };
}
