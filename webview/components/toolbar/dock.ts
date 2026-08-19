/**
 * The formatting dock: every control that edits the document, in a strip at
 * the window's bottom leading corner, under the `formattingInBottomDock`
 * arrangement (shared/hostProfile.ts).
 *
 * It is a second HOLDER for the toolbar's items, not a second toolbar. The
 * same `.tb-item` wrappers `index.ts` built once are re-parented into it, so
 * every listener, tooltip and active-state binding survives the move, exactly
 * as they survive a zone change on the top bar. Nothing here knows what any
 * item is.
 *
 * Two states, and the toggle is the whole of the chrome:
 *
 *     collapsed   [T]
 *     expanded    [T] | P⌄ B I ⋯
 *
 * A serif T because the row is about text, and because a letter survives being
 * drawn at chrome size where a glyph for "formatting" would not. The chevron
 * appears on hover and points the way the click goes, which is the only thing
 * about the state a first-time reader has to be told.
 *
 * The expanded row scrolls horizontally rather than collapsing into an
 * overflow menu: the set is fixed and opinionated, so there is no tail to
 * demote, and a narrow window should let you reach the last control rather
 * than reorganise the row under you. `overflow-x: auto` computes `overflow-y`
 * to `auto` as well, so the row would clip the four dropdowns that open out of
 * it; `MENU_CLIP_ATTR` is the declaration that sends them to viewport
 * coordinates instead, and `placeMenu` is the one reader.
 */
import { IconChevronRight } from "@/ui/icons";
import { t } from "@/i18n";
import { MENU_CLIP_ATTR } from "@/ui/anchoredPlacement";
import { getWebviewState, setWebviewState } from "@/messaging";
import { bindActivate } from "@/ui/dom";
import { applyTooltip } from "@/ui/tooltip";
import type { ToolbarItemId } from "./registry";
import "./dock.css";

/** The view-state key the expanded flag rides on. */
const STATE_KEY = "formattingDockExpanded";

export interface FormattingDock {
    /** The dock element, already appended to the body. */
    el: HTMLElement;
    /** Re-parent `ids`' wrappers into the row, in the order given. */
    render: (ids: readonly ToolbarItemId[]) => void;
    /** Whether the row is showing. */
    isExpanded: () => boolean;
    /** Tear down the listeners and remove the element (tests). */
    dispose: () => void;
}

export interface FormattingDockDeps {
    /** Every built item wrapper, keyed by id. Read on render; never rebuilt. */
    items: Partial<Record<ToolbarItemId, HTMLElement>>;
}

/**
 * Whether the row was left open. Defaults to CLOSED: the dock replaces a
 * setting that used to decide whether the editing controls existed at all, and
 * the answer a first run should give is the quiet one. A saved `true` is
 * honoured, so the choice survives a relaunch without being a preference
 * anybody has to go and find.
 */
function readExpanded(): boolean {
    return getWebviewState()?.[STATE_KEY] === true;
}

function writeExpanded(expanded: boolean): void {
    setWebviewState({ ...(getWebviewState() ?? {}), [STATE_KEY]: expanded });
}

export function createFormattingDock({ items }: FormattingDockDeps): FormattingDock {
    const el = document.createElement("div");
    el.className = "tb-dock";

    // Built by hand rather than through createButton, because the label and the
    // tooltip depend on the state and have to change with it: createButton
    // applies its tooltip once and keeps no handle. Placed ABOVE, the only
    // side with room at the bottom edge of the window.
    const toggle = document.createElement("button");
    toggle.className = "ui-btn tb-btn tb-dock-toggle";
    const toggleTip = applyTooltip(toggle, "", { placement: "above" });
    bindActivate(toggle, () => setExpanded(!expanded));
    const glyph = document.createElement("span");
    glyph.className = "tb-dock-glyph";
    glyph.textContent = "T";
    const chevron = document.createElement("span");
    chevron.className = "tb-dock-chevron";
    chevron.innerHTML = IconChevronRight;
    toggle.append(glyph, chevron);

    // A presentational rule between the toggle and the row, hidden with the
    // row: collapsed, the corner is one button and a divider beside nothing
    // would read as a row that failed to draw.
    const divider = document.createElement("span");
    divider.className = "tb-dock-divider";
    divider.setAttribute("aria-hidden", "true");

    const row = document.createElement("div");
    row.className = "tb-dock-row tb-zone";
    // The declaration that sends this row's dropdowns to viewport coordinates
    // (webview/ui/anchoredPlacement.ts). It belongs to the box that clips.
    row.setAttribute(MENU_CLIP_ATTR, "");

    el.append(toggle, divider, row);
    document.body.appendChild(el);

    let expanded = readExpanded();

    function paint(): void {
        el.dataset["expanded"] = String(expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
        // The label says what the click DOES, which is the opposite of the
        // state; the glyph and the chevron already say which state it is in.
        const label = expanded ? t("Hide formatting controls") : t("Show formatting controls");
        toggle.setAttribute("aria-label", label);
        toggleTip.setText(label);
    }

    function setExpanded(next: boolean): void {
        if (next === expanded) { return; }
        expanded = next;
        paint();
        writeExpanded(next);
    }

    paint();

    return {
        el,
        render(ids: readonly ToolbarItemId[]): void {
            row.replaceChildren();
            for (const id of ids) {
                const item = items[id];
                if (item) { row.appendChild(item); }
            }
        },
        isExpanded: () => expanded,
        dispose(): void { el.remove(); },
    };
}
