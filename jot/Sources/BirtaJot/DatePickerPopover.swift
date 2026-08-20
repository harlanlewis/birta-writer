import AppKit
import BirtaJotCore

/// The system date picker `/date` opens on Birta Writer Jot.
///
/// This is a PRESENTATION of behaviour the editor already has, which is why
/// the page declares `nativeDatePicker` as an arrangement rather than as a
/// capability (`shared/hostProfile.ts`). The web calendar exists and works on
/// this surface too; what the app adds is the control macOS users already know,
/// with the system's own keyboard handling, week start and localisation behind
/// it instead of ours.
///
/// Nothing here formats a date or touches a file. The controller reports the
/// day that was chosen and the editor writes it, so the app and the page cannot
/// end up spelling the same date two ways.
///
/// It reports EXACTLY once, whether the user picked or dismissed. The page is
/// holding a pending request keyed by id, and a popover that closed without
/// saying so would leave the editor waiting on a picker that is gone.
final class DatePickerPopover: NSViewController, NSPopoverDelegate {
    /// Called once, with the chosen day or nil when the popover was dismissed.
    private var report: ((CalendarDay?) -> Void)?
    private var popover: NSPopover?
    private let picker = NSDatePicker()

    private let insertButton = NSButton()

    override func loadView() {
        // `.yearMonthDay` alone is what makes `.clockAndCalendar` draw a
        // calendar and no clock: the clock face appears only when an hour or
        // minute element is asked for, and this control picks a DAY.
        picker.datePickerStyle = .clockAndCalendar
        picker.datePickerElements = [.yearMonthDay]
        picker.datePickerMode = .single
        picker.sizeToFit()

        // Deliberately NO `action` on the picker, and this is the whole of why
        // the control is usable from the keyboard. `NSDatePicker` sends its
        // action on any user-driven change to `dateValue`, which includes every
        // arrow key and every press of its own month arrows. Committing there
        // would insert a date and close the popover on the FIRST arrow key, so
        // navigating to any day but today would be impossible.
        //
        // Choosing a day and confirming it are therefore two acts, and the
        // button is what separates them. It is the default button, so Return
        // confirms from anywhere in the popover.
        insertButton.title = "Insert"
        insertButton.bezelStyle = .rounded
        // A carriage return, which is what makes this the popover's default
        // button. It compiles either way, and an escaped backslash here is a
        // key equivalent of two literal characters that nothing can ever press.
        insertButton.keyEquivalent = "\r"
        insertButton.target = self
        insertButton.action = #selector(confirm)
        insertButton.sizeToFit()

        let pad: CGFloat = 12
        let gap: CGFloat = 8
        let width = max(picker.frame.width, insertButton.frame.width) + pad * 2
        let height = picker.frame.height + insertButton.frame.height + gap + pad * 2
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        // AppKit's origin is bottom left, so the SMALLER y is the lower row.
        // The button takes it and the calendar sits a gap above, which is why
        // the button's height is part of the calendar's offset.
        insertButton.setFrameOrigin(NSPoint(x: width - insertButton.frame.width - pad, y: pad))
        picker.setFrameOrigin(NSPoint(x: pad, y: pad + insertButton.frame.height + gap))
        container.addSubview(picker)
        container.addSubview(insertButton)
        view = container
        preferredContentSize = container.frame.size
    }

    /// Shows the picker over `anchor`, a rectangle in `host`'s own coordinates.
    func show(relativeTo anchor: NSRect, of host: NSView, startingAt day: CalendarDay,
              report: @escaping (CalendarDay?) -> Void) {
        self.report = report
        loadViewIfNeeded()
        picker.dateValue = day.noon() ?? Date()

        let popover = NSPopover()
        popover.contentViewController = self
        popover.behavior = .transient
        popover.delegate = self
        popover.show(relativeTo: anchor, of: host, preferredEdge: .maxY)
        self.popover = popover
    }

    @objc private func confirm() {
        // Read through the current calendar, so the day is the one the user
        // sees on their own wall rather than a UTC reading of the instant the
        // control happens to carry.
        finish(CalendarDay(picker.dateValue))
    }

    /// The popover closed on its own (Escape, or a click outside it).
    func popoverDidClose(_ notification: Notification) {
        finish(nil)
    }

    /// The single exit. `report` is cleared first, so the pick path closing the
    /// popover cannot have its own answer overwritten by the close that
    /// follows it, and `popover` is cleared before the close is asked for, so
    /// the `popoverDidClose` this triggers cannot ask again.
    private func finish(_ day: CalendarDay?) {
        guard let report else { return }
        self.report = nil
        let closing = popover
        popover = nil
        report(day)
        closing?.performClose(nil)
    }
}
