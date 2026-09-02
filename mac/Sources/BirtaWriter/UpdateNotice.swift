import AppKit
import BirtaWriterCore

/// The line the panel carries after the app has replaced itself.
///
///                              [ Birta Writer updated to v2026.902.0
///                                in the background.              ✕ ]
///
/// The sibling of `StatusOverlay` and deliberately not a mode of it, because
/// the two are different kinds of thing and that file's own header is the
/// argument: the overlay is NEWS, it takes no clicks, it says how long you
/// have and then it goes. This is the one message in the app that has to
/// survive not being read at the moment it appeared.
///
/// It has to, because of when it arrives. Every other message in the app
/// answers something the person just did, and they are looking at the window
/// when it lands. This one reports something that happened while they were
/// somewhere else: the app they had running was replaced, on its own, and by
/// the time they summon the panel again the swap is minutes or hours old. A
/// six-second fade would tell that to an empty screen.
///
/// So it is a CARD and not a floating line. Three things follow from being one
/// message that persists, and each is the opposite of the overlay's answer:
///
/// - A frame, because a frame is what says this is a control rather than a
///   remark. The overlay refuses one for exactly the same reason in reverse.
/// - A dismiss button and nothing else. No spinner, because nothing is in
///   flight: by the time this is on screen the new version is what is running.
///   No timer, because a message that goes on its own is the thing this is
///   not.
/// - Ordinary chrome colours rather than the page's paper. It sits above the
///   document and should read as belonging to the window.
///
/// It knows nothing about updates. The caller hands it a sentence and is told
/// when the person is done with it.
@MainActor
final class UpdateNotice: NSVisualEffectView {
    /// The person clicked the dismiss button. The caller's job is to forget
    /// the announcement, so it does not come back on the next launch.
    var onDismiss: (() -> Void)?

    /// Inside the card, on every side. Wider than it is tall because the text
    /// is one run of words with a button after it, and a tall card around a
    /// short line reads as a panel rather than a notice.
    private static let padding = NSSize(width: 12, height: 9)
    /// Between the message and the button that dismisses it.
    private static let gap: CGFloat = 10
    /// How wide the words may run before they wrap. The panel can be narrow,
    /// so the card is also allowed to be narrower than this; what the ceiling
    /// stops is a single line stretched across a wide window, which is harder
    /// to read than two short ones.
    private static let textCeiling: CGFloat = 260

    private let message = NSTextField(labelWithString: "")
    private let dismiss = NSButton()

    init() {
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        // The material a popover uses, which is what this is: chrome floating
        // over content that keeps showing through.
        material = .popover
        blendingMode = .withinWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 8
        // A hairline, so the card has an edge where the material behind it
        // happens to match the paper under it.
        layer?.borderWidth = 1
        layer?.masksToBounds = true
        isHidden = true
        applyColours()

        message.font = .systemFont(ofSize: NSFont.systemFontSize)
        message.textColor = .labelColor
        message.lineBreakMode = .byWordWrapping
        message.usesSingleLineMode = false
        message.maximumNumberOfLines = 3
        message.preferredMaxLayoutWidth = Self.textCeiling
        message.translatesAutoresizingMaskIntoConstraints = false
        addSubview(message)

        dismiss.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Dismiss")
        dismiss.image?.isTemplate = true
        dismiss.symbolConfiguration = .init(pointSize: 10, weight: .semibold)
        dismiss.imagePosition = .imageOnly
        dismiss.isBordered = false
        dismiss.bezelStyle = .shadowlessSquare
        dismiss.title = ""
        dismiss.contentTintColor = .secondaryLabelColor
        dismiss.target = self
        dismiss.action = #selector(dismissed)
        // Named for the reader who is not looking at it. The symbol carries a
        // description, and a button with no title is otherwise announced by
        // its image alone.
        dismiss.setAccessibilityLabel("Dismiss")
        dismiss.translatesAutoresizingMaskIntoConstraints = false
        addSubview(dismiss)

        NSLayoutConstraint.activate([
            message.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.padding.width),
            message.topAnchor.constraint(equalTo: topAnchor, constant: Self.padding.height),
            message.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Self.padding.height),
            message.widthAnchor.constraint(lessThanOrEqualToConstant: Self.textCeiling),
            dismiss.leadingAnchor.constraint(equalTo: message.trailingAnchor, constant: Self.gap),
            dismiss.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.padding.width),
            // Against the FIRST line of the message rather than the middle of
            // the card, so a message that wraps to two lines does not leave
            // the button floating opposite the gap between them.
            dismiss.topAnchor.constraint(equalTo: topAnchor, constant: Self.padding.height),
            // A square big enough to hit. The symbol inside it is smaller;
            // what this sizes is the target, not the mark.
            dismiss.widthAnchor.constraint(equalToConstant: 18),
            dismiss.heightAnchor.constraint(equalToConstant: 18),
        ])
        // The card is as small as its contents allow. On a narrow panel the
        // message gives way first: the button must not be squeezed out of a
        // card whose only control it is.
        message.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        dismiss.setContentCompressionResistancePriority(.required, for: .horizontal)
    }

    /// A CGColor is resolved once, so the border is repainted when the
    /// appearance changes; the material and the NSColor-backed text follow it
    /// by themselves.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColours()
    }

    private func applyColours() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }

    /// Put a message up, and leave it there.
    ///
    /// No animation in: the card is not a reaction to anything the person just
    /// did, so there is no gesture for it to be the answer to. It is simply
    /// there when they next look at the window, which is what it is reporting.
    func show(_ text: String) {
        message.stringValue = text
        isHidden = false
        needsLayout = true
    }

    /// What the card is currently saying, for a test to read back. Empty when
    /// nothing is up.
    var textForMeasurement: String { isHidden ? "" : message.stringValue }

    /// The dismiss button, for a test to press. Nothing else reaches it.
    var dismissButtonForMeasurement: NSButton { dismiss }

    @objc private func dismissed() {
        isHidden = true
        message.stringValue = ""
        onDismiss?()
    }
}
