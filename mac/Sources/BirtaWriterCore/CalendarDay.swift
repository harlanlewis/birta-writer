import Foundation

/// A day on a wall calendar: no time, no zone, `month` 1-12.
///
/// The Swift half of the contract `webview/utils/dateFormat.ts` states, and it
/// is deliberately the SMALL half. The app's picker chooses a day and reports
/// it; the editor spells it. Nothing here formats a date, and nothing here
/// should learn to, because two formatters are two answers to the question of
/// what `/date` writes and only one of them can be right.
///
/// `NSDatePicker` hands back a `Date`, which is an instant. Turning one into a
/// day is the only interesting thing in this file, and it is the same trap the
/// page side has: read the day in the USER'S calendar and zone, never in UTC,
/// or a picker used late in the evening reports tomorrow.
public struct CalendarDay: Equatable, Sendable {
    public let year: Int
    public let month: Int
    public let day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// The day `date` falls on, in `calendar` (the user's own by default).
    ///
    /// A `Calendar` carries its own time zone, so passing one is how a test
    /// asks the question from somewhere other than wherever it is running.
    public init(_ date: Date, calendar: Calendar = .current) {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        self.year = parts.year ?? 0
        self.month = parts.month ?? 0
        self.day = parts.day ?? 0
    }

    /// Noon on this day, which is what the picker should be SHOWN at.
    ///
    /// Noon rather than midnight for the reason the page side gives: in a zone
    /// whose clocks shift at midnight, local midnight does not exist on the
    /// spring-forward day, and the resolution moves the instant across a day
    /// boundary. Noon has twelve hours of slack either way.
    public func noon(in calendar: Calendar = .current) -> Date? {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        parts.hour = 12
        return calendar.date(from: parts)
    }
}
