/**
 * The shared hover lifecycle for a toolbar dropdown. Every toolbar dropdown
 * (Format, Font, Settings, Checks, Debug, ⋯ overflow) opens on hover, positions
 * itself with placeMenu, and must hold open while the pointer crosses the small
 * gap between the button and the menu. Extracting it here means all menus behave
 * identically and a new one is correct by construction — the gap-bridge bug that
 * once affected only the Debug menu can't recur, because there's one code path.
 */
import { placeMenu } from "./menuPlacement";

export interface HoverMenuOptions {
    /** Runs immediately before the menu is shown — e.g. repaint checkmarks. */
    onOpen?: () => void;
    /**
     * Grace period before hiding once the pointer leaves the wrap. Covers the
     * dead space of the button→menu gap (the menu is absolutely positioned just
     * outside the wrap's box); the menu's own hover cancels it. Default 100ms.
     */
    hideDelayMs?: number;
}

/**
 * Wire `wrap`'s hover to open/close `menu`, positioned relative to `button`.
 * `wrap` must contain both `button` and `menu` in the DOM. Returns a disposer
 * that removes the listeners and clears any pending timer.
 */
export function wireHoverMenu(
    wrap: HTMLElement,
    button: HTMLElement,
    menu: HTMLElement,
    options: HoverMenuOptions = {},
): () => void {
    const hideDelay = options.hideDelayMs ?? 100;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelHide = (): void => {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    };
    const open = (): void => {
        cancelHide();
        options.onOpen?.();
        menu.style.display = "flex";
        placeMenu(button, menu);
    };
    const scheduleHide = (): void => {
        cancelHide();
        hideTimer = setTimeout(() => { menu.style.display = "none"; }, hideDelay);
    };

    wrap.addEventListener("mouseenter", open);
    wrap.addEventListener("mouseleave", scheduleHide);
    menu.addEventListener("mouseenter", cancelHide);

    return (): void => {
        cancelHide();
        wrap.removeEventListener("mouseenter", open);
        wrap.removeEventListener("mouseleave", scheduleHide);
        menu.removeEventListener("mouseenter", cancelHide);
    };
}
