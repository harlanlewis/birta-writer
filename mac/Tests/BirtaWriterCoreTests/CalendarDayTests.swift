import XCTest
@testable import BirtaWriterCore

/// The Swift side of the civil-date contract, and the one trap it can fall
/// into: `NSDatePicker` hands back an instant, and reading a day out of an
/// instant in the wrong zone reports the wrong day for part of every evening.
///
/// The zone is passed in rather than taken from the machine, so these assert
/// something on a runner sitting anywhere. A test that used `.current` would
/// pass in London whatever the code did.
final class CalendarDayTests: XCTestCase {
    private func calendar(_ zone: String) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: zone)!
        return c
    }

    /// 23:30 UTC on the 20th: already the 21st far enough east, still the 20th
    /// in London, and the 20th earlier in the day out west.
    private var lateInTheUTCDay: Date {
        var parts = DateComponents()
        parts.year = 2026; parts.month = 8; parts.day = 20; parts.hour = 23; parts.minute = 30
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        return utc.date(from: parts)!
    }

    func testAnInstantShouldReadAsTheDayInTheGIVENZoneRatherThanInUTC() {
        let east = CalendarDay(lateInTheUTCDay, calendar: calendar("Pacific/Kiritimati"))
        XCTAssertEqual(east, CalendarDay(year: 2026, month: 8, day: 21))

        let utc = CalendarDay(lateInTheUTCDay, calendar: calendar("UTC"))
        XCTAssertEqual(utc, CalendarDay(year: 2026, month: 8, day: 20))

        // The arm that gives the two above their meaning: the same instant is
        // a different day in the two zones, so an implementation that ignored
        // the calendar could not satisfy both.
        XCTAssertNotEqual(east, utc)
    }

    func testAZoneWestOfUTCShouldStillReadAsItsOwnDay() {
        let west = CalendarDay(lateInTheUTCDay, calendar: calendar("Pacific/Niue"))
        XCTAssertEqual(west, CalendarDay(year: 2026, month: 8, day: 20))
    }

    func testNoonShouldRoundTripBackToTheSameDayInEveryZoneTried() {
        // Every real day of a year, in five zones including two that shift
        // their clocks, must survive the trip out to an instant and back.
        //
        // What this does NOT prove: it is not the check that justifies noon
        // over midnight. Foundation resolves a nonexistent local midnight
        // forward, within the same day, so the property holds either way. Noon
        // is defence in depth, and saying so is better than implying a test
        // stands behind it.
        let zones = ["UTC", "America/Santiago", "America/Havana", "Pacific/Kiritimati", "Europe/London"]
        var checked = 0
        for zone in zones {
            let cal = calendar(zone)
            for month in 1...12 {
                // The real length of THIS month, so the 29th, 30th and 31st are
                // actually reached rather than clamped away to a repeated 28th.
                let last = cal.range(of: .day, in: .month,
                                     for: cal.date(from: DateComponents(year: 2026, month: month, day: 1))!)!.count
                for day in 1...last {
                    let source = CalendarDay(year: 2026, month: month, day: day)
                    guard let noon = source.noon(in: cal) else {
                        return XCTFail("no noon for \(source) in \(zone)")
                    }
                    XCTAssertEqual(CalendarDay(noon, calendar: cal), source, "\(zone) \(source)")
                    checked += 1
                }
            }
        }
        // The sweep asserts its own size: 2026 is a common year, so a run that
        // silently reached fewer days than five full ones cannot pass.
        XCTAssertEqual(checked, 365 * zones.count)
    }

    func testTheDatePickerResultShouldCarryADayAndNeverAFormattedString() {
        // The page owns the one spelling of a date. If this message ever grows
        // a text field, the two surfaces can disagree about what `/date`
        // writes, so the shape is pinned rather than left to review.
        let picked = HostMessage.datePickerResult(id: "date-1",
                                                  date: CalendarDay(year: 2026, month: 8, day: 20))
        XCTAssertEqual(picked.jsonString(),
                       #"{"date":{"day":20,"month":8,"year":2026},"id":"date-1","type":"datePickerResult"}"#)
    }

    func testADismissedPickerShouldStillAnswerSoThePageStopsWaiting() {
        XCTAssertEqual(HostMessage.datePickerResult(id: "date-2", date: nil).jsonString(),
                       #"{"date":null,"id":"date-2","type":"datePickerResult"}"#)
    }

    func testAShowDatePickerRequestShouldParseItsAnchor() {
        XCTAssertEqual(
            WebviewMessage.parse(#"{"type":"showDatePicker","id":"d1","left":12.5,"top":40,"bottom":56}"#),
            .showDatePicker(id: "d1", left: 12.5, top: 40, bottom: 56))
    }

    func testARequestMissingItsAnchorShouldNotBecomeAPickerAtTheOrigin() {
        // Every field is required, so a malformed request degrades to `.other`
        // (traced and dropped) rather than opening a popover in the corner.
        for json in [
            #"{"type":"showDatePicker","id":"d1","top":40,"bottom":56}"#,
            #"{"type":"showDatePicker","id":"d1","left":12,"bottom":56}"#,
            #"{"type":"showDatePicker","id":"d1","left":12,"top":40}"#,
            #"{"type":"showDatePicker","left":12,"top":40,"bottom":56}"#,
        ] {
            XCTAssertEqual(WebviewMessage.parse(json), .other(type: "showDatePicker"), json)
        }
    }
}
