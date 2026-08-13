/**
 * The toolbar's menu-row and button vocabulary: the shapes every dropdown in
 * this component is built from. They hold no toolbar state and reach nothing
 * outside `webview/ui`, so every menu module composes them rather than
 * re-authoring a row.
 *
 * Three row idioms, and the distinction between them is semantic, not
 * decorative: a leading checkmark for a selection out of a set, an accent fill
 * for "the caret is inside this container", a switch for an independent
 * persistent on/off. Picking the wrong one makes the menu lie about what the
 * row does.
 */
import { createButton } from "@/ui/dom";

export function btn(
    icon: string,
    title: string,
    onClick: () => void,
    extraClass = "",
): HTMLButtonElement {
    return createButton({
        className: `ui-btn tb-btn${extraClass ? " " + extraClass : ""}`,
        icon,
        title,
        onClick,
    });
}

/**
 * A dropdown trigger button — the shared shape behind every hover-menu opener
 * (Format, Font, Settings, Checks, ⋯). Its mousedown is swallowed:
 * preventDefault so it never fires an action or starts a text selection,
 * stopPropagation so it never reaches the editor. Deliberately carries no
 * tooltip — a tooltip would open in the same spot as the menu and overlap it.
 */
export function createMenuTrigger(opts: {
    html?: string;
    text?: string;
    className?: string;
    ariaLabel?: string;
}): HTMLButtonElement {
    const el = document.createElement("button");
    el.className = opts.className ?? "ui-btn tb-btn tb-fmt-btn";
    if (opts.html !== undefined) { el.innerHTML = opts.html; }
    if (opts.text !== undefined) { el.textContent = opts.text; }
    if (opts.ariaLabel) { el.setAttribute("aria-label", opts.ariaLabel); }
    el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    return el;
}

/** A horizontal menu divider — the shared separator idiom for every dropdown. */
export function makeSep(): HTMLElement {
    const sep = document.createElement("div");
    sep.className = "ui-menu-divider tb-menu-sep";
    sep.setAttribute("role", "separator");
    return sep;
}

/** A selectable/checkable menu row. */
export interface CheckItem {
    el: HTMLElement;
    /** The label span, e.g. to apply a per-row font preview. */
    label: HTMLElement;
    /** Show/hide the leading check and set aria-checked. */
    setChecked: (on: boolean) => void;
}

/**
 * A checkable menu row: a leading ✓ (shown when checked) + a label. The shared
 * checkmark treatment for every toolbar menu with selectable state — Checks
 * (multi-toggle), Font and Format (single-select) — so they look identical.
 */
export function createCheckItem(label: string): CheckItem {
    const el = document.createElement("div");
    el.className = "ui-menu-row tb-fmt-item tb-check-item";
    el.setAttribute("role", "menuitemcheckbox");
    const mark = document.createElement("span");
    mark.className = "menu-check";
    mark.setAttribute("aria-hidden", "true");
    const labelEl = document.createElement("span");
    labelEl.className = "tb-check-label";
    labelEl.textContent = label;
    el.append(mark, labelEl);
    return {
        el,
        label: labelEl,
        setChecked: (on: boolean): void => {
            el.classList.toggle("tb-check-item--on", on);
            el.setAttribute("aria-checked", on ? "true" : "false");
        },
    };
}

/** A menu row whose active state is shown by filling the row (no leading check). */
export interface FillItem {
    el: HTMLElement;
    setActive: (on: boolean) => void;
}

/**
 * A fill-idiom menu row: a label whose active state is an accent-filled row (the
 * `.tb-list-item--on` treatment shared by the Lists/Quote/Code pickers), not a
 * leading checkmark. The Format (P / H1–H6) menu uses this so it reads the same
 * as the other container pickers — a single-select where the current row lights.
 */
export function createFillItem(label: string): FillItem {
    const el = document.createElement("div");
    el.className = "ui-menu-row tb-fmt-item tb-fmt-fill-item";
    el.setAttribute("role", "menuitemradio");
    el.setAttribute("aria-checked", "false");
    el.textContent = label;
    return {
        el,
        setActive: (on: boolean): void => {
            el.classList.toggle("tb-fmt-item--on", on);
            el.setAttribute("aria-checked", on ? "true" : "false");
        },
    };
}

/**
 * A switch menu row: a label on the left and an on/off switch on the right. Used
 * by the Checks menu (proofreading) and the Lists menu's task-sink preference,
 * where the row is an independent on/off, not a selection from a set — so a
 * switch reads truer than a checkmark (and truer than the accent fill, which
 * means "the caret is in this container" on the rows above it). The row itself
 * is role=switch (the track/knob are decorative) so the menu's Enter/Space
 * handling activates it without a duplicate focus stop. Same CheckItem shape as
 * createCheckItem, so callers treat the two interchangeably.
 *
 * `iconHtml` adds the same 14px leading icon slot the Lists rows use, so a
 * switch dropped into an icon menu keeps that column aligned; menus without
 * icons (Checks) omit it.
 */
export function createSwitchItem(label: string, iconHtml?: string): CheckItem {
    const el = document.createElement("div");
    el.className = "ui-menu-row tb-fmt-item tb-switch-item";
    el.setAttribute("role", "switch");
    // Off until a caller paints it — the aria state has to agree with the
    // visuals, and the --on class starts unset (a default of "true" told a
    // screen reader "on" while the track rendered off, for the window before
    // the first repaint).
    el.setAttribute("aria-checked", "false");
    const labelEl = document.createElement("span");
    labelEl.className = "tb-switch-item-label";
    labelEl.textContent = label;
    const track = document.createElement("span");
    track.className = "tb-switch";
    track.setAttribute("aria-hidden", "true");
    track.appendChild(document.createElement("span")).className = "tb-switch-knob";
    if (iconHtml) {
        const iconEl = document.createElement("span");
        iconEl.className = "tb-list-item-icon";
        iconEl.innerHTML = iconHtml;
        el.appendChild(iconEl);
    }
    el.append(labelEl, track);
    return {
        el,
        label: labelEl,
        setChecked: (on: boolean): void => {
            el.classList.toggle("tb-switch-item--on", on);
            el.setAttribute("aria-checked", on ? "true" : "false");
        },
    };
}
