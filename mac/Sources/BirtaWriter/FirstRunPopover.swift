import AppKit
import BirtaWriterCore

/// The first thing a new install puts on screen, drawn against the menu bar
/// item it is about.
///
/// Anchored there because the fact it is teaching is WHERE the app is, and a
/// window in the middle of the screen would be teaching it in the one place
/// the answer is not. It is also why this is a popover rather than a
/// notification: a popover has an arrow, and the arrow is the sentence.
///
/// No buttons, and that is the design rather than an omission. The only thing
/// to do here is press the chord, and a button beside it would be a second
/// route that makes the first one optional, which is exactly how the gesture
/// stops being learned. Nothing here dismisses it either: the panel coming up
/// is what ends it (`AppDelegate.finishFirstRun`), by the chord or by the
/// wait under it.
///
/// `FirstRunInvitation` holds the words and the wait. Nothing is decided here.
@MainActor
final class FirstRunPopover {
    private let popover = NSPopover()

    init(_ invitation: FirstRunInvitation) {
        let controller = NSViewController()
        controller.view = FirstRunPopoverView(invitation)
        popover.contentViewController = controller
        // `applicationDefined`, so a click elsewhere does not take it away.
        // A transient popover closes on the first click outside itself, and
        // the gesture it is asking for is a keystroke: somebody who reaches
        // for the keyboard by way of clicking their document would lose the
        // sentence before reading the end of it.
        popover.behavior = .applicationDefined
        popover.animates = true
    }

    /// Put it under the menu bar item.
    ///
    /// Deliberately not covered by `BirtaWriterTests`, for the reason
    /// `AppDelegate.applyMenuBarPresence` gives: that suite builds windows and
    /// never shows them, and there is no equivalent for a status item. Asking
    /// for one puts an icon in the menu bar of whoever is running the tests.
    /// What IS checkable is the view, and `FirstRunPopoverTests` reads it back.
    func show(from button: NSStatusBarButton) {
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }

    func close() {
        popover.performClose(nil)
    }

    /// Leave it up, and let the next click anywhere take it away.
    ///
    /// For the run where the WAIT opened the panel rather than the chord.
    /// Nobody has pressed anything then, and the note talks about a keystroke
    /// it deliberately cannot name (`FirstRunNote.markdown`), so this is the
    /// only place the keys are written down and closing it would take the
    /// answer away at the moment it is first wanted. Transient rather than
    /// left standing, because from here on it is in the way of the thing it
    /// was pointing at.
    func letTheFirstClickTakeIt() {
        popover.behavior = .transient
    }
}

/// The popover's content: where the app lives, the chord, and what the chord
/// does. Built and read back without a window, which is how this app checks a
/// surface it cannot show.
@MainActor
final class FirstRunPopoverView: NSView {
    /// Wide enough for the sentence to break once rather than four times, and
    /// no wider: a popover as wide as the screen stops pointing at anything.
    private static let width: CGFloat = 260
    private static let inset: CGFloat = 16

    let headline = NSTextField(labelWithString: "")
    /// The chord, or nil when macOS refused it. NOT drawn in that case, which
    /// is the whole of what the refusal changes here: a chord drawn large is
    /// an instruction whatever the sentence under it says.
    let chord: NSTextField?
    let body = NSTextField(wrappingLabelWithString: "")

    init(_ invitation: FirstRunInvitation) {
        headline.stringValue = invitation.headline
        headline.font = .preferredFont(forTextStyle: .headline)
        headline.textColor = .labelColor

        chord = invitation.chordToPress.map { glyphs in
            let field = NSTextField(labelWithString: glyphs)
            // The one piece of this the reader has to act on, so it is drawn
            // at the size of a thing to be acted on rather than at the size of
            // the prose around it.
            field.font = .systemFont(ofSize: 28, weight: .light)
            field.textColor = .labelColor
            return field
        }

        body.stringValue = invitation.body
        body.font = .preferredFont(forTextStyle: .subheadline)
        body.textColor = invitation.isProblem ? .systemRed : .secondaryLabelColor
        body.preferredMaxLayoutWidth = Self.width - Self.inset * 2

        super.init(frame: .zero)

        let stack = NSStackView(views: [headline] + (chord.map { [$0] } ?? []) + [body])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        if let chord { stack.setCustomSpacing(10, after: chord) }
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: Self.width),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.inset),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Self.inset),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Self.inset),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
