/**
 * What a date insertion is worth pinning: that "today" is the user's today
 * rather than Greenwich's, and that the spelling stays readable in a locale
 * nobody on this project runs.
 *
 * Both are things a green suite would happily lie about. The zone arm would
 * pass on a runner sitting in UTC whatever the code did, so it MOVES the
 * runner's zone to two real ones either side of UTC and asserts the answers
 * disagree with UTC in the direction each zone implies. The locale arm compares
 * against the option set we did not choose, so it fails if that choice ever
 * stops buying anything.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
    type CalendarDate,
    addDays,
    formatCalendarDate,
    relativeCalendarDate,
    sameCalendarDate,
    toCalendarDate,
} from "../utils/dateFormat";

const REAL_TZ = process.env.TZ;

/** Runs `body` with the process in `zone`, restoring whatever was there. */
function inZone<T>(zone: string, body: () => T): T {
    process.env.TZ = zone;
    try {
        return body();
    } finally {
        if (REAL_TZ === undefined) { delete process.env.TZ; } else { process.env.TZ = REAL_TZ; }
    }
}

describe("toCalendarDate", () => {
    afterEach(() => {
        if (REAL_TZ === undefined) { delete process.env.TZ; } else { process.env.TZ = REAL_TZ; }
    });

    // The instant is deliberately late in the UTC day: 23:30Z is still the
    // 20th in London and already the 21st anywhere far enough east, which is
    // the disagreement the whole design exists to get right.
    const LATE_IN_THE_UTC_DAY = "2026-08-20T23:30:00Z";

    it("an instant east of UTC should read as the LOCAL day, which is already tomorrow", () => {
        const local = inZone("Pacific/Kiritimati", () =>
            toCalendarDate(new Date(LATE_IN_THE_UTC_DAY)));
        expect(local).toEqual({ year: 2026, month: 8, day: 21 });
        // The arm that makes this test worth having: the UTC answer is the
        // 20th, so an implementation reading toISOString() fails here rather
        // than agreeing by accident.
        expect(new Date(LATE_IN_THE_UTC_DAY).toISOString().slice(0, 10)).toBe("2026-08-20");
    });

    it("an instant west of UTC should read as the LOCAL day, which is still yesterday", () => {
        const early = "2026-08-20T02:30:00Z";
        const local = inZone("Pacific/Niue", () => toCalendarDate(new Date(early)));
        expect(local).toEqual({ year: 2026, month: 8, day: 19 });
        expect(new Date(early).toISOString().slice(0, 10)).toBe("2026-08-20");
    });

    it("the two zones should disagree about the same instant, or neither arm proves anything", () => {
        // A guard on the instrument rather than on the product: if the runtime
        // ever stopped honouring TZ, both arms above would quietly measure one
        // zone and pass. This fails loudly instead.
        const east = inZone("Pacific/Kiritimati", () => toCalendarDate(new Date(LATE_IN_THE_UTC_DAY)));
        const west = inZone("Pacific/Niue", () => toCalendarDate(new Date(LATE_IN_THE_UTC_DAY)));
        expect(sameCalendarDate(east, west)).toBe(false);
    });
});

describe("addDays", () => {
    it("a day inside a month should step by one", () => {
        expect(addDays({ year: 2026, month: 8, day: 20 }, 1)).toEqual({ year: 2026, month: 8, day: 21 });
        expect(addDays({ year: 2026, month: 8, day: 20 }, -1)).toEqual({ year: 2026, month: 8, day: 19 });
    });

    it("the last day of a month should roll into the next", () => {
        expect(addDays({ year: 2026, month: 8, day: 31 }, 1)).toEqual({ year: 2026, month: 9, day: 1 });
    });

    it("new year's eve should roll the year", () => {
        expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
        expect(addDays({ year: 2027, month: 1, day: 1 }, -1)).toEqual({ year: 2026, month: 12, day: 31 });
    });

    it("a leap February should have a 29th and a common one should not", () => {
        expect(addDays({ year: 2024, month: 2, day: 28 }, 1)).toEqual({ year: 2024, month: 2, day: 29 });
        expect(addDays({ year: 2026, month: 2, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 1 });
    });

    it("a year of steps through two clock shifts should visit every day once", () => {
        // An invariant rather than a hand-picked answer: across a year of
        // consecutive days in a zone that shifts twice, every step moves the
        // day by one and never repeats or skips one.
        //
        // What this does NOT prove, said plainly because the obvious reading is
        // that it does: it is not the check that justifies `atNoon`. Replacing
        // that noon with midnight survives this arm in every midnight-shifting
        // zone tried, because `setDate` keeps the local time fields and
        // re-normalizes, so a nonexistent midnight resolves forward inside the
        // same day. Noon is defence in depth and is documented as such.
        inZone("America/Santiago", () => {
            let date: CalendarDate = { year: 2026, month: 1, day: 1 };
            const seen = new Set<string>();
            for (let i = 0; i < 365; i++) {
                const key = `${date.year}-${date.month}-${date.day}`;
                expect(seen.has(key), `repeated ${key}`).toBe(false);
                seen.add(key);
                date = addDays(date, 1);
            }
            expect(seen.size).toBe(365);
            expect(date).toEqual({ year: 2027, month: 1, day: 1 });
        });
    });
});

describe("relativeCalendarDate", () => {
    it("the three relative days should sit one apart around the clock's own day", () => {
        const now = new Date(2026, 7, 20, 9, 0);
        expect(relativeCalendarDate("today", now)).toEqual({ year: 2026, month: 8, day: 20 });
        expect(relativeCalendarDate("tomorrow", now)).toEqual({ year: 2026, month: 8, day: 21 });
        expect(relativeCalendarDate("yesterday", now)).toEqual({ year: 2026, month: 8, day: 19 });
    });

    it("a relative day at a month boundary should cross it", () => {
        expect(relativeCalendarDate("tomorrow", new Date(2026, 7, 31, 23, 0)))
            .toEqual({ year: 2026, month: 9, day: 1 });
    });
});

describe("formatCalendarDate", () => {
    const AUG_20: CalendarDate = { year: 2026, month: 8, day: 20 };

    it("the requested shape should be exactly what en-US produces", () => {
        expect(formatCalendarDate(AUG_20, "en-US")).toBe("Aug 20, 2026");
    });

    it("a locale that writes day first should get its own order, not the American one", () => {
        expect(formatCalendarDate(AUG_20, "en-GB")).toBe("20 Aug 2026");
    });

    /**
     * The sweep behind the option choice.
     *
     * `dateStyle: "medium"` is the shorter way to ask for the same thing and
     * is the wrong one: in a number of locales it resolves to an all-numeric
     * date, where nothing in the string says which field is the day. Asking
     * for the month by name gets one wherever the locale HAS one.
     *
     * This is written as a comparison rather than as a list of locales,
     * because the list is ICU's and moves under us. What must hold is the
     * ordering: our options name the month in strictly more locales than the
     * alternative, and in no fewer.
     */
    const LOCALE_SWEEP = [
        "en-US", "en-GB", "de-DE", "fr-FR", "ja-JP", "he-IL", "ar-EG", "es-ES",
        "pt-BR", "zh-CN", "ru-RU", "nl-NL", "sv-SE", "hi-IN", "ko-KR", "cs-CZ",
        "pl-PL", "tr-TR", "th-TH", "fi-FI", "hu-HU", "da-DK", "nb-NO", "el-GR",
        "vi-VN", "uk-UA", "ro-RO", "sk-SK", "id-ID", "lt-LT",
    ];

    /** Whether a rendered date carries any letter, which is what tells a
     *  reader which number is the month. An all-numeric date carries none. */
    const namesTheMonth = (s: string): boolean => /\p{L}/u.test(s);

    it("the ambiguity predicate should discriminate, or the sweep below proves nothing", () => {
        expect(namesTheMonth("Aug 20, 2026")).toBe(true);
        expect(namesTheMonth("2026年8月20日")).toBe(true);
        expect(namesTheMonth("20.08.2026")).toBe(false);
        expect(namesTheMonth("2026. 8. 20.")).toBe(false);
    });

    it("naming the month should beat dateStyle medium across the locale sweep", () => {
        const supported = Intl.DateTimeFormat.supportedLocalesOf(LOCALE_SWEEP);
        // The instrument reached something. A sweep that resolved no locales
        // would compare 0 with 0 and pass.
        expect(supported.length).toBeGreaterThanOrEqual(20);

        const instant = new Date(2026, 7, 20, 12);
        const ours = supported.filter((l) => namesTheMonth(formatCalendarDate(AUG_20, l)));
        const medium = supported.filter((l) =>
            namesTheMonth(new Intl.DateTimeFormat(l, { dateStyle: "medium" }).format(instant)));

        // The claim, and the whole reason the options are spelled out.
        expect(ours.length).toBeGreaterThan(medium.length);
        // And the shape of the win: our options lose to `medium` nowhere.
        for (const l of medium) { expect(ours, l).toContain(l); }
        // A loose floor rather than an exact list, since which locales lack an
        // abbreviated month name is ICU's business and moves between runtimes.
        // It is deliberately slack: the load-bearing claim is the ordering
        // above, and a tight bound here would redden the suite on a CLDR
        // revision that changed nothing about the product.
        expect(ours.length).toBeGreaterThan(supported.length * 0.6);
    });

    it("the format should carry no zone, so one civil date has one spelling", () => {
        // The same CalendarDate must format identically wherever the process
        // thinks it is. This is the formatting half of the UTC trap: a
        // formatter fed an instant would move the date across the boundary.
        const east = inZone("Pacific/Kiritimati", () => formatCalendarDate(AUG_20, "en-US"));
        const west = inZone("Pacific/Niue", () => formatCalendarDate(AUG_20, "en-US"));
        expect(east).toBe("Aug 20, 2026");
        expect(west).toBe("Aug 20, 2026");
    });
});
