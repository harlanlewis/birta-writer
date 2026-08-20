/**
 * The calendar's arithmetic, which is the half of the picker a browser is not
 * needed to judge.
 *
 * The assertions are mostly invariants rather than expected grids, because a
 * hand-written expected grid can only confirm what its author already believed
 * about the month they chose. "Every cell is one day after the one before it"
 * holds for every month in every locale, and it is what actually catches an
 * off-by-one in the lead-in calculation or a DST day swallowed by the
 * arithmetic.
 */
import { describe, it, expect } from "vitest";
import {
    DAYS_IN_WEEK,
    WEEKS_IN_GRID,
    addMonthsClamped,
    daysInMonth,
    endOfWeek,
    firstDayOfWeek,
    isInMonth,
    monthGrid,
    monthYearLabel,
    startOfWeek,
    weekdayNames,
} from "../components/datePicker/grid";
import { addDays, sameCalendarDate } from "../utils/dateFormat";

/** Months across a decade, so the sweeps below are not one lucky month. */
const MONTHS: Array<[number, number]> = [];
for (let year = 2020; year <= 2029; year++) {
    for (let month = 1; month <= 12; month++) { MONTHS.push([year, month]); }
}

/** Week starts a real locale actually uses: Sunday, Monday, Friday, Saturday. */
const WEEK_STARTS = [0, 1, 5, 6];

describe("monthGrid", () => {
    it("the sweep should cover a decade of months, or the invariants below prove nothing", () => {
        expect(MONTHS).toHaveLength(120);
    });

    it("every grid should be exactly six rows of seven", () => {
        for (const [year, month] of MONTHS) {
            for (const weekStart of WEEK_STARTS) {
                const grid = monthGrid(year, month, weekStart);
                expect(grid, `${year}-${month}`).toHaveLength(WEEKS_IN_GRID);
                for (const week of grid) { expect(week).toHaveLength(DAYS_IN_WEEK); }
            }
        }
    });

    it("every cell should be exactly one day after the cell before it", () => {
        // The invariant that does the real work: it holds regardless of month
        // length, leap years, or which weekday the month opens on, and a lead-in
        // computed wrongly breaks it immediately.
        let checked = 0;
        for (const [year, month] of MONTHS) {
            for (const weekStart of WEEK_STARTS) {
                const flat = monthGrid(year, month, weekStart).flat();
                for (let i = 1; i < flat.length; i++) {
                    expect(sameCalendarDate(flat[i]!, addDays(flat[i - 1]!, 1)),
                        `${year}-${month} ws=${weekStart} at ${i}`).toBe(true);
                    checked++;
                }
            }
        }
        expect(checked).toBe(120 * WEEK_STARTS.length * (WEEKS_IN_GRID * DAYS_IN_WEEK - 1));
    });

    it("every row should start on the locale's own first weekday", () => {
        for (const [year, month] of MONTHS) {
            for (const weekStart of WEEK_STARTS) {
                for (const week of monthGrid(year, month, weekStart)) {
                    const first = week[0]!;
                    const weekday = new Date(first.year, first.month - 1, first.day, 12).getDay();
                    expect(weekday, `${year}-${month} ws=${weekStart}`).toBe(weekStart);
                }
            }
        }
    });

    it("every day of the month should appear exactly once", () => {
        for (const [year, month] of MONTHS) {
            for (const weekStart of WEEK_STARTS) {
                const inMonth = monthGrid(year, month, weekStart)
                    .flat()
                    .filter((d) => isInMonth(d, year, month))
                    .map((d) => d.day);
                expect(new Set(inMonth).size, `${year}-${month}`).toBe(inMonth.length);
                expect(inMonth).toHaveLength(daysInMonth(year, month));
            }
        }
    });

    it("the grid should never be all one month, so the padding is always arrowable", () => {
        // A blank corner is the thing this design refuses; padding days are
        // real dates precisely so Left on the 1st has somewhere to land.
        for (const [year, month] of MONTHS) {
            const outside = monthGrid(year, month, 1).flat().filter((d) => !isInMonth(d, year, month));
            expect(outside.length, `${year}-${month}`).toBeGreaterThan(0);
        }
    });
});

describe("daysInMonth", () => {
    it("month lengths should include the leap-year rule, century exception and all", () => {
        expect(daysInMonth(2026, 2)).toBe(28);
        expect(daysInMonth(2024, 2)).toBe(29);
        expect(daysInMonth(2000, 2)).toBe(29);
        expect(daysInMonth(1900, 2)).toBe(28);
        expect(daysInMonth(2026, 8)).toBe(31);
        expect(daysInMonth(2026, 4)).toBe(30);
    });
});

describe("addMonthsClamped", () => {
    it("a day that the target month does not have should clamp to its last", () => {
        expect(addMonthsClamped({ year: 2026, month: 3, day: 31 }, -1))
            .toEqual({ year: 2026, month: 2, day: 28 });
        expect(addMonthsClamped({ year: 2024, month: 3, day: 31 }, -1))
            .toEqual({ year: 2024, month: 2, day: 29 });
        expect(addMonthsClamped({ year: 2026, month: 1, day: 31 }, 1))
            .toEqual({ year: 2026, month: 2, day: 28 });
    });

    it("a month step should never overshoot into the month after the target", () => {
        // The failure clamping exists to prevent: an unclamped Jan 31 plus one
        // month is March 3, which is not the month the user paged to.
        let checked = 0;
        for (const [year, month] of MONTHS) {
            for (const day of [1, 15, 28, 29, 30, 31]) {
                if (day > daysInMonth(year, month)) { continue; }
                for (const step of [-12, -1, 1, 12]) {
                    const moved = addMonthsClamped({ year, month, day }, step);
                    const expected = new Date(year, month - 1 + step, 1, 12);
                    expect(moved.year, `${year}-${month}-${day} ${step}`).toBe(expected.getFullYear());
                    expect(moved.month, `${year}-${month}-${day} ${step}`).toBe(expected.getMonth() + 1);
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(1000);
    });

    it("stepping a year should land on the same month", () => {
        expect(addMonthsClamped({ year: 2026, month: 8, day: 20 }, 12))
            .toEqual({ year: 2027, month: 8, day: 20 });
        expect(addMonthsClamped({ year: 2026, month: 8, day: 20 }, -12))
            .toEqual({ year: 2025, month: 8, day: 20 });
    });
});

describe("startOfWeek and endOfWeek", () => {
    it("a week should be seven days long and contain the day it was asked about", () => {
        for (const weekStart of WEEK_STARTS) {
            for (let offset = 0; offset < 40; offset++) {
                const day = addDays({ year: 2026, month: 1, day: 1 }, offset);
                const start = startOfWeek(day, weekStart);
                const end = endOfWeek(day, weekStart);
                expect(sameCalendarDate(addDays(start, DAYS_IN_WEEK - 1), end)).toBe(true);
                const startDay = new Date(start.year, start.month - 1, start.day, 12).getDay();
                expect(startDay).toBe(weekStart);
            }
        }
    });
});

describe("firstDayOfWeek", () => {
    it("a locale should get its own week start, in getDay() numbering", () => {
        // The conversion from ISO numbering (1 Monday, 7 Sunday) to the
        // runtime's (0 Sunday, 6 Saturday) is the thing that can silently be
        // off by one, so the three shapes a real locale uses are all pinned.
        expect(firstDayOfWeek("en-US")).toBe(0);
        expect(firstDayOfWeek("en-GB")).toBe(1);
        expect(firstDayOfWeek("de-DE")).toBe(1);
        expect(firstDayOfWeek("ar-EG")).toBe(6);
    });

    it("locales should not all agree, or the grid is not locale-aware at all", () => {
        const starts = new Set(["en-US", "en-GB", "ar-EG"].map((l) => firstDayOfWeek(l)));
        expect(starts.size).toBeGreaterThan(1);
    });

    it("a tag the runtime cannot construct should fall back rather than throw", () => {
        expect(firstDayOfWeek("not a locale")).toBe(1);
    });
});

describe("weekdayNames", () => {
    it("there should be seven, starting at the locale's week start", () => {
        const sundayFirst = weekdayNames(0, "en-US");
        expect(sundayFirst).toHaveLength(DAYS_IN_WEEK);
        expect(sundayFirst[0]!.long).toBe("Sunday");
        const mondayFirst = weekdayNames(1, "en-US");
        expect(mondayFirst[0]!.long).toBe("Monday");
        expect(mondayFirst[6]!.long).toBe("Sunday");
    });

    it("the spoken name should be the full one, since the drawn one is abbreviated", () => {
        // The column header shows `short` and announces `abbr`, so the two
        // must actually differ or the abbr attribute buys nothing.
        const names = weekdayNames(1, "en-US");
        for (const n of names) {
            expect(n.short.length).toBeLessThan(n.long.length);
        }
    });
});

describe("monthYearLabel", () => {
    it("the heading should name the month in the locale's own words", () => {
        expect(monthYearLabel(2026, 8, "en-US")).toBe("August 2026");
        expect(monthYearLabel(2026, 8, "de-DE")).toContain("August");
        expect(monthYearLabel(2026, 1, "fr-FR")).toContain("janvier");
    });
});
