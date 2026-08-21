/**
 * webview/utils/dateFormat.ts
 *
 * What a date INSERTION is: a civil date, and the characters it spells.
 *
 * Two decisions live here, and both are settled deliberately rather than left
 * to whatever the platform does by default.
 *
 * 1. A day is a civil date, never an instant.
 *
 * `CalendarDate` carries year/month/day and no time and no zone, because
 * "today" is a question about a wall calendar rather than about a point on the
 * timeline. Every conversion from an instant reads LOCAL components
 * (`getFullYear`/`getMonth`/`getDate`), so today is the user's today. The trap
 * this shape exists to close is `toISOString()`, which is UTC: for a user east
 * or west of Greenwich it names yesterday or tomorrow for part of every day,
 * and it is the obvious thing to reach for. Once a value is a `CalendarDate`
 * there is no zone left in it to get wrong, so the mistake can only be made in
 * this file, and `dateFormat.test.ts` pins it under two real zones either side
 * of UTC rather than under whichever one the test runner happens to sit in.
 *
 * 2. The spelling follows the reader's regional locale, and asks for a NAMED
 *    month.
 *
 * There is no format setting, by request. That forbids a preference; it does
 * not by itself decide between pinning one spelling and following the host, so
 * the host wins: how a date is written is a regional convention, and a reader
 * in London writing `20 Aug 2026` is not expressing a preference that a US
 * default would be overriding, they are writing their language.
 *
 * The options are spelled out (`month: "short"`) rather than taken from
 * `dateStyle: "medium"`, and that is the whole of the difference between a
 * date a stranger can read and one they can only guess at. `dateStyle` resolves
 * to an all-numeric form in a number of locales, where `20.08.2026` and
 * `2026/08/20` leave a reader to work out which field is the day. Asking for
 * the month by name gets one wherever CLDR has one. Where CLDR has no
 * abbreviated month name, which is the case for a few locales including Czech
 * and Finnish, it yields a number and that IS the local convention for a short
 * date, so it stands rather than being worked around. The two are compared in
 * `dateFormat.test.ts`, which is the record; what that check pins is the
 * ORDERING, that spelling the month out loses to `dateStyle` in no locale and
 * beats it in several.
 *
 * The locale is a parameter everywhere, defaulting to the runtime's own
 * resolved locale, so every rule above is exercised against fixed locales in
 * tests and read from the environment in exactly one place.
 */

/**
 * A day on a wall calendar: no time, no zone, `month` 1-12.
 *
 * Deliberately not a `Date`. A `Date` is an instant and carries a zone with
 * it, which is the thing a date insertion must not depend on.
 */
export interface CalendarDate {
    readonly year: number;
    /** 1-12, unlike `Date.getMonth()`. */
    readonly month: number;
    readonly day: number;
}

/**
 * Noon, not midnight, whenever a `CalendarDate` needs to become a `Date` to
 * be formatted or to have days added to it.
 *
 * Noon is twelve hours clear of either edge of a day, so no clock shift can
 * push it across a day boundary. It is defence in depth rather than a fix for
 * a demonstrated failure, and saying which matters: `Date.prototype.setDate`
 * preserves the local time-of-day fields and re-normalizes, so a nonexistent
 * local midnight on a spring-forward date resolves FORWARD within the same
 * day, and day arithmetic built on midnight survives the zones tried in
 * `dateFormat.test.ts`. The reason to keep noon anyway is that the property
 * holding is a fact about one method's normalization rule rather than about
 * the calendar, and every other operation here would have to re-derive it.
 */
function atNoon(date: CalendarDate): Date {
    return new Date(date.year, date.month - 1, date.day, 12);
}

/** The civil date `instant` falls on, in the runtime's LOCAL zone. */
export function toCalendarDate(instant: Date): CalendarDate {
    return {
        year: instant.getFullYear(),
        month: instant.getMonth() + 1,
        day: instant.getDate(),
    };
}

/**
 * `date` moved by `days`, normalized (month and year roll over, leap years
 * included). The arithmetic runs through the runtime's own calendar rather
 * than counting milliseconds, so a month's length is never assumed.
 */
export function addDays(date: CalendarDate, days: number): CalendarDate {
    const shifted = atNoon(date);
    shifted.setDate(shifted.getDate() + days);
    return toCalendarDate(shifted);
}

/** Whether two civil dates name the same day. */
export function sameCalendarDate(a: CalendarDate, b: CalendarDate): boolean {
    return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * The characters a date insertion puts in the document.
 *
 * The one formatter both surfaces use. Birta Writer's native picker
 * reports the day it was given and never spells it, so the app and the editor
 * cannot drift into two spellings of the same date.
 */
export function formatCalendarDate(date: CalendarDate, locale?: string): string {
    return new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
    }).format(atNoon(date));
}

/**
 * The offsets in days behind the named relative commands.
 *
 * Yesterday is here alongside the two that were asked for, because the three
 * are one gesture and a writer logging a day's work reaches backwards at least
 * as often as forwards. It costs a registry row and no machinery. It is
 * search-revealed rather than browsable, like its two siblings, so the cost of
 * being wrong about that is a row nobody finds rather than a row in the way.
 */
export const RELATIVE_DAY_OFFSETS = {
    today: 0,
    tomorrow: 1,
    yesterday: -1,
} as const;

export type RelativeDay = keyof typeof RELATIVE_DAY_OFFSETS;

/** The civil date a relative command names, against `now`. */
export function relativeCalendarDate(which: RelativeDay, now: Date): CalendarDate {
    return addDays(toCalendarDate(now), RELATIVE_DAY_OFFSETS[which]);
}
