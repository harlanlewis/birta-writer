/**
 * webview/components/datePicker/grid.ts
 *
 * The calendar's arithmetic and its vocabulary, with no DOM in it.
 *
 * Everything the grid needs to be DRAWN is computed here and tested here, so
 * the module beside this one is only markup, focus and keys. The split is what
 * makes the interesting half (which day sits in which cell, in a locale that
 * starts its week on Saturday, across a leap February) answerable without a
 * browser.
 *
 * This file rides the lazy chunk with the picker, so nothing here is paid for
 * by a document that never asks for a date.
 */
import { type CalendarDate, addDays } from "@/utils/dateFormat";

/** Days per row. Named because a bare 7 in index arithmetic reads as noise. */
export const DAYS_IN_WEEK = 7;

/**
 * Rows in the drawn grid, fixed rather than fitted to the month.
 *
 * A month needs five rows or six depending on its length and which weekday it
 * opens on. Drawing whichever it needs makes the popup change height as you
 * page through it, which moves every cell out from under the pointer and, when
 * the popup opens upward from a caret near the bottom of the window, moves the
 * whole surface. Six rows always is one row of padding in some months and a
 * grid that never moves in any of them.
 */
export const WEEKS_IN_GRID = 6;

/**
 * The weekday a locale's week starts on, as `Date.getDay()` numbers it
 * (0 Sunday through 6 Saturday).
 *
 * `Intl.Locale`'s week info answers this, in ISO numbering (1 Monday through
 * 7 Sunday), so the `% 7` is the conversion between the two conventions and
 * not a bounds check. It is spelled two ways across the runtimes this editor
 * targets, a `getWeekInfo()` method and an older `weekInfo` accessor, so both
 * are read. Only one of the two is live on any given engine, so neither branch
 * is reachable from a test on the other.
 *
 * Where neither exists the answer is Monday: it is what ISO 8601 specifies and
 * what most locales use, which makes it the least wrong single answer
 * available to a runtime that cannot say. `datePickerGrid.test.ts` reaches
 * this only through a locale tag that will not construct, which is the throw
 * path; a runtime that answers with no week info at all is not reachable from
 * a test and is defence rather than something pinned.
 */
export function firstDayOfWeek(locale?: string): number {
    interface WeekInfo { firstDay: number }
    interface MaybeWeekInfo {
        getWeekInfo?: () => WeekInfo;
        weekInfo?: WeekInfo;
    }
    try {
        const resolved = new Intl.Locale(locale ?? resolvedLocale()) as unknown as MaybeWeekInfo;
        const info = typeof resolved.getWeekInfo === "function"
            ? resolved.getWeekInfo()
            : resolved.weekInfo;
        if (info && typeof info.firstDay === "number") {
            return info.firstDay % DAYS_IN_WEEK;
        }
    } catch {
        // A locale tag the runtime will not construct falls through to the floor.
    }
    return 1;
}

/** The runtime's own resolved locale, read in exactly one place. */
export function resolvedLocale(): string {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
}

/**
 * The six-by-seven block of days for `year`/`month`, starting on the locale's
 * first weekday and padded at both ends with the neighbouring months' days.
 *
 * The padding days are real dates rather than blanks, because a calendar whose
 * corners are empty cannot be arrowed across: pressing Left on the first of
 * the month has to land somewhere, and the day before it is the only answer
 * that is not a special case.
 */
export function monthGrid(year: number, month: number, weekStart: number): CalendarDate[][] {
    const firstOfMonth: CalendarDate = { year, month, day: 1 };
    const firstWeekday = new Date(year, month - 1, 1, 12).getDay();
    // How far back the grid opens: the distance from the month's first weekday
    // to the locale's week start, wrapped into 0-6.
    const lead = (firstWeekday - weekStart + DAYS_IN_WEEK) % DAYS_IN_WEEK;
    const start = addDays(firstOfMonth, -lead);
    const weeks: CalendarDate[][] = [];
    for (let row = 0; row < WEEKS_IN_GRID; row++) {
        const week: CalendarDate[] = [];
        for (let col = 0; col < DAYS_IN_WEEK; col++) {
            week.push(addDays(start, row * DAYS_IN_WEEK + col));
        }
        weeks.push(week);
    }
    return weeks;
}

/** Whether `date` belongs to the month the grid is showing. */
export function isInMonth(date: CalendarDate, year: number, month: number): boolean {
    return date.year === year && date.month === month;
}

/**
 * `date` moved by whole months, clamped to the target month's length.
 *
 * Clamping is what Page Up on the 31st has to do: the month before may have no
 * 31st, and the alternative to clamping is the runtime's own overflow, which
 * silently rolls into the month after the one the user asked for. Landing on
 * the 30th is the answer every calendar gives.
 */
export function addMonthsClamped(date: CalendarDate, months: number): CalendarDate {
    const target = new Date(date.year, date.month - 1 + months, 1, 12);
    const year = target.getFullYear();
    const month = target.getMonth() + 1;
    return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/** How many days `month` has, leap years included. */
export function daysInMonth(year: number, month: number): number {
    return new Date(year, month, 0, 12).getDate();
}

/** The first day of `date`'s week, given the locale's week start. */
export function startOfWeek(date: CalendarDate, weekStart: number): CalendarDate {
    const weekday = new Date(date.year, date.month - 1, date.day, 12).getDay();
    return addDays(date, -((weekday - weekStart + DAYS_IN_WEEK) % DAYS_IN_WEEK));
}

/** The last day of `date`'s week, given the locale's week start. */
export function endOfWeek(date: CalendarDate, weekStart: number): CalendarDate {
    return addDays(startOfWeek(date, weekStart), DAYS_IN_WEEK - 1);
}

/** The weekday column headings, short for display and long for a reader. */
export function weekdayNames(
    weekStart: number,
    locale?: string,
): ReadonlyArray<{ short: string; long: string }> {
    // 2024-01-07 was a Sunday, so offsetting from it by a weekday number gives
    // that weekday whatever the locale's week start turns out to be.
    const sunday = new Date(2024, 0, 7, 12);
    const shortFmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const longFmt = new Intl.DateTimeFormat(locale, { weekday: "long" });
    const names: Array<{ short: string; long: string }> = [];
    for (let i = 0; i < DAYS_IN_WEEK; i++) {
        const day = new Date(sunday);
        day.setDate(sunday.getDate() + ((weekStart + i) % DAYS_IN_WEEK));
        names.push({ short: shortFmt.format(day), long: longFmt.format(day) });
    }
    return names;
}

/** The heading over the grid, naming the month and year in `locale`. */
export function monthYearLabel(year: number, month: number, locale?: string): string {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" })
        .format(new Date(year, month - 1, 1, 12));
}

/** A day cell's accessible name: the full date, spoken rather than abbreviated. */
export function dayLabel(date: CalendarDate, locale?: string): string {
    return new Intl.DateTimeFormat(locale, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    }).format(new Date(date.year, date.month - 1, date.day, 12));
}
