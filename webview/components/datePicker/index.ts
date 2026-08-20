/**
 * webview/components/datePicker/index.ts
 *
 * The calendar `/date` opens, built to the WAI-ARIA date-picker grid pattern.
 *
 * Lazily imported by the `insertDate` handler and never reached from the eager
 * graph (`webview/utils/katexLoader.ts` is the pattern), so a document that
 * never asks for a date does not load this module, the grid arithmetic beside
 * it, or anything they pull in. The stylesheet is the exception and is eager
 * whatever this file does, for the reason its own header gives.
 *
 * ## Why this one takes focus, when the pickers beside it do not
 *
 * The slash menu and the section-link picker deliberately leave focus in the
 * editor and claim the few keys they need in the capture phase, which is the
 * combobox pattern and avoids the whole question of giving focus back. A
 * calendar cannot do that, and the reason is the size of the claim rather than
 * a preference: a grid is navigated with both arrow axes, Page Up and Page
 * Down, Home and End, and every one of those already means something to a text
 * editor. Claiming all of them from the editor for as long as a popup is open
 * takes the document's own navigation away.
 *
 * So focus really moves, the grid is a real `role="grid"` with a roving
 * tabindex, and the cost is that focus has to come back correctly. That cost
 * is paid by the caller, in `dateInsert.ts`'s `refocus`, which this file reaches
 * through `onClose`. It is the failure this component is most likely to have:
 * a `contenteditable` that has been blurred
 * does not necessarily hold a usable selection when it is focused again, and
 * WebKit is stricter about it than Chromium. The insurance is a live test
 * rather than care: `e2e/datePicker` closes the picker and then TYPES, and
 * asserts the character landed in the block the caret started in, under both
 * engines.
 *
 * ## What it inserts
 *
 * Nothing, directly. It hands a `CalendarDate` to the `onPick` it was given,
 * which is the same callback the relative commands and Birta Writer Jot's
 * native picker all end at, so there is one insertion and one spelling of a
 * date no matter which of the three chose it.
 */
import "./datePicker.css";
import { type CalendarDate, addDays, formatCalendarDate, sameCalendarDate } from "@/utils/dateFormat";
import { t } from "@/i18n";
import { EDGE_MARGIN, computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";
import { trackEditorReflow } from "@/ui/editorReflow";
import { watchOutsidePress } from "@/ui/outsidePress";
import { IconChevronLeft, IconChevronRight } from "@/ui/icons";
import {
    DAYS_IN_WEEK,
    addMonthsClamped,
    dayLabel,
    endOfWeek,
    firstDayOfWeek,
    isInMonth,
    monthGrid,
    monthYearLabel,
    resolvedLocale,
    startOfWeek,
    weekdayNames,
} from "./grid";

/** An anchor rectangle in viewport coordinates. */
export interface CaretRect {
    left: number;
    top: number;
    bottom: number;
}

export interface DatePickerOptions {
    /**
     * The editor's content box, which is what a reflow is watched ON.
     *
     * Not the popup: `trackEditorReflow`'s ResizeObserver exists to notice the
     * CONTENT changing shape, which is what a window resize does, and a fixed
     * popup does not change shape when the window does. Watching the popup
     * would also feed the observer its own output, since placement writes a
     * height onto it.
     */
    readonly content: HTMLElement;
    /**
     * Where to hang the popup: the caret, in viewport coordinates.
     *
     * A function rather than a rectangle, because the answer changes. The
     * popup is `position: fixed`, so a document scrolled under it moves the
     * caret while leaving the popup where it was. Re-running a placement
     * against a rectangle captured at open would recompute the same answer and
     * look like re-anchoring without being it, so the caller is asked for the
     * caret's CURRENT box each time instead.
     */
    readonly anchor: () => CaretRect;
    /** The day the grid opens on and marks as today. */
    readonly today: CalendarDate;
    /**
     * Called with the chosen day, always AFTER `onClose`, so the caller has
     * already given focus back and the insertion lands in a focused editor.
     * Not called at all when the picker is dismissed.
     */
    readonly onPick: (date: CalendarDate) => void;
    /** Called on every close, pick or dismiss, to give the editor back. */
    readonly onClose: () => void;
    /** Overridden only by tests; production reads the runtime's own locale. */
    readonly locale?: string;
}

/**
 * One picker at a time. A second `/date` while one is open replaces it rather
 * than stacking, which is the section-link picker's rule and for the same
 * reason: two grids would both be claiming the arrow keys.
 */
let active: { close: () => void } | null = null;

export function openDatePicker(opts: DatePickerOptions): void {
    active?.close();

    const locale = opts.locale ?? resolvedLocale();
    const weekStart = firstDayOfWeek(locale);
    // The day the roving tabindex sits on. It starts on today, which is both
    // the most likely pick and the one place a user can orient from.
    let focused: CalendarDate = opts.today;
    let closed = false;

    const root = document.createElement("div");
    root.className = "ui-card date-picker";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", t("Choose a date"));

    // ── Header: month/year, and the four steppers ──
    const header = document.createElement("div");
    header.className = "date-picker__header";

    const headingId = "date-picker-heading";
    const heading = document.createElement("h2");
    heading.className = "ui-heading date-picker__month";
    heading.id = headingId;
    // Polite rather than assertive, and on the heading rather than a separate
    // region: paging through months is a self-announcing action, so the name
    // of the month that arrived is the whole of what a reader needs.
    heading.setAttribute("aria-live", "polite");

    const stepper = (label: string, icon: string, months: number): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-btn ui-btn--icon date-picker__step";
        btn.innerHTML = icon;
        btn.setAttribute("aria-label", label);
        btn.title = label;
        btn.addEventListener("click", () => {
            // Focus STAYS on the button, which is what the pattern requires and
            // what stops a second Enter inserting a date: Enter on a button
            // fires click, so moving focus into the grid here would leave the
            // next Enter landing on a day cell and picking it.
            setFocused(addMonthsClamped(focused, months));
        });
        return btn;
    };

    const prevMonth = stepper(t("Previous month"), IconChevronLeft, -1);
    const nextMonth = stepper(t("Next month"), IconChevronRight, 1);
    header.append(prevMonth, heading, nextMonth);

    // ── Grid ──
    const table = document.createElement("table");
    table.className = "date-picker__grid";
    table.setAttribute("role", "grid");
    table.setAttribute("aria-labelledby", headingId);

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.setAttribute("role", "row");
    for (const name of weekdayNames(weekStart, locale)) {
        const th = document.createElement("th");
        th.setAttribute("role", "columnheader");
        th.setAttribute("scope", "col");
        // `abbr` is what a screen reader announces for the column, so the
        // abbreviated heading on screen does not have to be the spoken one.
        th.setAttribute("abbr", name.long);
        th.textContent = name.short;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    table.append(thead, tbody);

    // ── Footer: the one shortcut worth a button ──
    const footer = document.createElement("div");
    footer.className = "date-picker__footer";
    const todayBtn = document.createElement("button");
    todayBtn.type = "button";
    todayBtn.className = "ui-btn ui-btn--chip date-picker__today";
    todayBtn.textContent = t("Today");
    todayBtn.addEventListener("click", () => pick(opts.today));
    const preview = document.createElement("span");
    preview.className = "date-picker__preview";
    footer.append(todayBtn, preview);

    root.append(header, table, footer);
    document.body.appendChild(root);

    /** Every day cell currently drawn, in grid order, with the day it holds. */
    let cells: Array<{ el: HTMLTableCellElement; day: CalendarDate }> = [];
    // Declared before `close()` reads them. Nothing calls `close` synchronously
    // today, so this is not a live bug; it is the TDZ a future synchronous
    // dismissal path would otherwise walk into.
    let offOutside: (() => void) | undefined;
    let offReflow: (() => void) | undefined;
    /** The month those cells were built for, so a move within it can reuse them. */
    let drawnMonth = "";

    /**
     * Builds the month's cells. Called only when the DISPLAYED MONTH changes,
     * never on every arrow key.
     *
     * Rebuilding on each keystroke is the obvious implementation and is worse
     * for the reader it matters most to: it destroys the focused element, so
     * focus falls to the body and is then put back, and a screen reader is
     * handed a focus change into nothing between every day and the next. Within
     * a month only the roving marks move, and the element the user is on stays
     * the same element throughout.
     */
    function drawMonth(): void {
        tbody.textContent = "";
        cells = [];
        for (const week of monthGrid(focused.year, focused.month, weekStart)) {
            const tr = document.createElement("tr");
            tr.setAttribute("role", "row");
            for (const day of week) {
                const td = document.createElement("td");
                td.setAttribute("role", "gridcell");
                td.className = "date-picker__day";
                td.textContent = String(day.day);
                td.setAttribute("aria-label", dayLabel(day, locale));
                if (sameCalendarDate(day, opts.today)) {
                    td.setAttribute("aria-current", "date");
                    td.classList.add("date-picker__day--today");
                }
                if (!isInMonth(day, focused.year, focused.month)) {
                    td.classList.add("date-picker__day--outside");
                }
                td.addEventListener("click", () => pick(day));
                tr.appendChild(td);
                cells.push({ el: td, day });
            }
            tbody.appendChild(tr);
        }
        drawnMonth = `${focused.year}-${focused.month}`;
    }

    /** Moves the roving tabindex and the selection onto the focused day. */
    function syncRovingMarks(): void {
        for (const { el, day } of cells) {
            const isFocused = sameCalendarDate(day, focused);
            // Exactly one cell is in the tab sequence, so Tab leaves the grid
            // rather than walking 42 days.
            el.tabIndex = isFocused ? 0 : -1;
            // The grid's own selection, which here is the day the keyboard is
            // on, since a picker that inserts on Enter has no other notion of
            // a selected day.
            el.setAttribute("aria-selected", isFocused ? "true" : "false");
        }
    }

    function render(): void {
        heading.textContent = monthYearLabel(focused.year, focused.month, locale);
        preview.textContent = formatCalendarDate(focused, locale);
        if (drawnMonth !== `${focused.year}-${focused.month}`) { drawMonth(); }
        syncRovingMarks();
    }

    function setFocused(date: CalendarDate): void {
        focused = date;
        render();
    }

    function focusActiveCell(): void {
        const cell = cells.find((c) => c.el.tabIndex === 0)?.el;
        if (!cell) { return; }
        // `preventScroll` because the browser's own scroll-to-focus would move
        // the DOCUMENT behind the popup, which is not what a keystroke inside a
        // calendar should do.
        cell.focus({ preventScroll: true });
        // Which leaves the popup's own scroller, where it has one: a window too
        // short for the calendar gets `overflow-y: auto` above, and a day
        // arrowed to below the fold would otherwise be focused off screen.
        if (root.scrollHeight > root.clientHeight) {
            // `cell.offsetTop` is already relative to `root`, which is the
            // offsetParent because the popup is positioned, and that is the
            // same origin `scrollTop` uses. Subtracting the popup's own
            // placement coordinate would mix two coordinate spaces and drive
            // every cell to the top (`langPicker.ts` is the same idiom).
            const cellTop = cell.offsetTop;
            const cellBottom = cellTop + cell.offsetHeight;
            if (cellTop < root.scrollTop) {
                root.scrollTop = cellTop;
            } else if (cellBottom > root.scrollTop + root.clientHeight) {
                root.scrollTop = cellBottom - root.clientHeight;
            }
        }
    }

    function pick(date: CalendarDate): void {
        close();
        opts.onPick(date);
    }

    function close(): void {
        if (closed) { return; }
        closed = true;
        active = null;
        offOutside?.();
        offReflow?.();
        document.removeEventListener("keydown", onKeydown, true);
        root.remove();
        opts.onClose();
    }

    /**
     * Escape is handled here rather than through the escape-layer stack
     * (`ui/escapeLayers.ts`), and the difference is which surface owns focus.
     * That stack exists for surfaces that stay open while the EDITOR holds
     * focus and key routing, so it can decide which of several open surfaces a
     * bare Escape belongs to. This picker holds focus itself, so the question
     * it answers cannot arise: a keystroke reaching a cell is unambiguously
     * this surface's. The guard below is what makes that true, by ignoring
     * anything that lands outside the popup.
     *
     * Note what is deliberately NOT here: no `mousedown` `preventDefault` on
     * the container. A surface that must keep the caret in the document needs
     * one, but this one has already taken focus on purpose, so a press on a
     * day cell moves focus between two cells of a grid the user is already in.
     * Suppressing the default would fight the roving tabindex instead of
     * protecting anything. `e2e/datePicker` presses a day cell with a real
     * mouse in both engines and checks the insertion lands where the caret was.
     */
    function onKeydown(e: KeyboardEvent): void {
        // Only while focus is inside the picker. A keystroke anywhere else is
        // the editor's, and this listener is on `document` in the capture
        // phase so that the grid's arrows are never seen by a ProseMirror
        // keymap first.
        if (!root.contains(document.activeElement)) { return; }

        const step = (days: number): void => {
            e.preventDefault();
            setFocused(addDays(focused, days));
            focusActiveCell();
        };
        const jumpMonths = (months: number): void => {
            e.preventDefault();
            setFocused(addMonthsClamped(focused, months));
            focusActiveCell();
        };

        switch (e.key) {
            case "ArrowLeft": return step(-1);
            case "ArrowRight": return step(1);
            case "ArrowUp": return step(-DAYS_IN_WEEK);
            case "ArrowDown": return step(DAYS_IN_WEEK);
            case "Home":
                e.preventDefault();
                setFocused(startOfWeek(focused, weekStart));
                return focusActiveCell();
            case "End":
                e.preventDefault();
                setFocused(endOfWeek(focused, weekStart));
                return focusActiveCell();
            // Shift turns a month step into a year step, which is the pattern's
            // way of reaching a distant date without a year field.
            case "PageUp": return jumpMonths(e.shiftKey ? -12 : -1);
            case "PageDown": return jumpMonths(e.shiftKey ? 12 : 1);
            case "Enter":
            case " ":
                // Only from a day cell. On a stepper button Enter and Space are
                // the button's own activation, and stealing them would make the
                // steppers insert a date.
                if (document.activeElement?.getAttribute("role") !== "gridcell") { return; }
                e.preventDefault();
                return pick(focused);
            case "Escape":
                e.preventDefault();
                e.stopPropagation();
                return close();
            case "Tab":
                // A focus trap, because the picker is modal to the keyboard
                // while it is open: Tab out of a popup floating over a
                // contenteditable puts the caret somewhere nobody chose.
                return trapTab(e);
            default:
        }
    }

    function trapTab(e: KeyboardEvent): void {
        const stops: HTMLElement[] = [prevMonth, nextMonth, todayBtn];
        const activeCell = cells.find((c) => c.el.tabIndex === 0)?.el;
        if (activeCell) { stops.splice(2, 0, activeCell); }
        const i = stops.indexOf(document.activeElement as HTMLElement);
        if (i === -1) { return; }
        e.preventDefault();
        const next = e.shiftKey
            ? (i - 1 + stops.length) % stops.length
            : (i + 1) % stops.length;
        stops[next]?.focus({ preventScroll: true });
    }

    render();

    /**
     * Places the popup against the caret, re-reading where the caret IS rather
     * than where it was (docs/DESIGN_PRINCIPLES.md, "A surface anchored to
     * something that moves must re-anchor"). Dismissing on scroll is the other
     * permitted answer and is wrong here, because the wheel is reachable while
     * the grid holds focus and closing on it would throw away a half-finished
     * pick.
     *
     * `maxHeight` is applied, not discarded: where neither side has room the
     * placement returns the height that actually exists, and a popup taller
     * than that puts its footer out of reach.
     */
    function place(): void {
        const at = opts.anchor();
        // Release any constraint a previous placement applied BEFORE measuring.
        // `offsetHeight` reports what the element currently is, so measuring a
        // squeezed popup would feed its clamped height back in as its natural
        // one, and the next placement would read a popup that now fits and
        // release the clamp it still needs.
        //
        // The scroll offset is carried across the release. Clearing the clamp
        // makes the popup briefly non-overflowing, which the browser answers by
        // clamping `scrollTop` to 0, and `place()` runs from a capture-phase
        // scroll listener that hears the popup's OWN scroller: without this, a
        // wheel inside a squeezed calendar would snap it back to the top.
        const keptScroll = root.scrollTop;
        root.style.maxHeight = "";
        root.style.overflowY = "";
        const size = { width: root.offsetWidth, height: root.offsetHeight };
        const pos = computeAnchoredPosition(
            { left: at.left, right: at.left, top: at.top, bottom: at.bottom },
            size,
            viewportSize(),
        );

        root.style.left = `${pos.left}px`;
        // Clamped into the visible band by this surface, not by the placement.
        // `computeAnchoredPosition` clamps `left`, and clamps `top` only from
        // ABOVE: its flip-up branch returns `anchor.top - gap - height`, which
        // for a caret scrolled below the viewport is a coordinate off the
        // bottom of the screen. Every other consumer hides when the anchor
        // leaves view and never meets that number. This one does not hide, so
        // clamping is the obligation that choice carries: an unclamped popup
        // here is invisible while still holding focus and trapping Tab.
        const view = viewportSize();
        const lowest = Math.max(view.top ?? 0, view.height - EDGE_MARGIN - size.height);
        root.style.top = `${Math.max(view.top ?? 0, Math.min(pos.top, lowest))}px`;
        // Re-applied only where it actually constrains. `maxHeight` is always
        // a number, so applying it unconditionally gives every popup a scroll
        // container it does not need, and a scroller changes what focusing a
        // cell means.
        if (pos.maxHeight < size.height) {
            root.style.maxHeight = `${pos.maxHeight}px`;
            root.style.overflowY = "auto";
            root.scrollTop = keptScroll;
        }

        // `anchoredPlacement` also reports `anchorInView`, and its contract
        // offers hiding when the anchor scrolls away. This surface declines
        // that, and the reason is focus rather than state: hiding would keep
        // everything the user had chosen, but it would leave keyboard focus
        // inside a `display: none` element, which is a worse place to be than
        // beside a caret you cannot see. The surfaces that do hide are the ones
        // that DECORATE something visible and never hold focus.
        //
        // Declining the hide is what obliges the clamp above, and the two are
        // one decision: every other consumer is spared an off-screen
        // coordinate by disappearing before it can be used.
    }

    place();

    offReflow = trackEditorReflow(opts.content, place);
    offOutside = watchOutsidePress([root], close);
    document.addEventListener("keydown", onKeydown, true);
    active = { close };
    focusActiveCell();
}
