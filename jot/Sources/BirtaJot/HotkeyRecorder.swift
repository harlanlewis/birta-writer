import AppKit
import BirtaJotCore

/// The global-hotkey field: press the combination you want, and see it.
///
///     ┌────────────────────────────────┐
///     │  ⌃  ⌥  ⇧  ⌘   J             ⊗  │
///     └────────────────────────────────┘
///
/// The four modifier glyphs are always drawn. Dim ones are not part of the
/// combination, lit ones are, and while recording they light as the keys go
/// down, so a combination is visible before it is committed rather than after.
/// That is the part worth having: a hotkey is chosen by pressing it, and
/// pressing it is exactly what you cannot see yourself do.
///
/// Clearing is its own control (⊗) rather than a consequence of focus. A field
/// that records whenever it happens to be focused will eat a stray keystroke
/// and rebind the hotkey with nothing asked, and the user then has to work out
/// what changed.
@MainActor
final class HotkeyRecorderView: NSView {
    /// A combination was committed. The owner registers it and reports back
    /// through `setStatus`.
    var onCombo: ((HotkeyCombo) -> Void)?

    private(set) var combo: HotkeyCombo?
    private var recording = false
    private var liveModifiers: NSEvent.ModifierFlags = []
    private var monitor: Any?

    private let glyphs: [(flag: NSEvent.ModifierFlags, label: NSTextField)] = [
        (.control, NSTextField(labelWithString: "⌃")),
        (.option, NSTextField(labelWithString: "⌥")),
        (.shift, NSTextField(labelWithString: "⇧")),
        (.command, NSTextField(labelWithString: "⌘")),
    ]
    private let keyLabel = NSTextField(labelWithString: "")
    private let clearButton = NSButton()

    init(combo: HotkeyCombo?) {
        self.combo = combo
        super.init(frame: .zero)
        build()
        render()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Closing the window while the field is recording has to take the monitor
    /// down with it: it is installed application-wide and would go on eating
    /// every keystroke in the app.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stopRecording() }
    }

    // MARK: building

    private func build() {
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.borderWidth = 1

        for (_, label) in glyphs { label.font = .systemFont(ofSize: 15) }
        keyLabel.font = .systemFont(ofSize: 13, weight: .medium)

        clearButton.bezelStyle = .inline
        clearButton.isBordered = false
        clearButton.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Clear the hotkey")
        clearButton.contentTintColor = .tertiaryLabelColor
        clearButton.target = self
        clearButton.action = #selector(clearAndRecord)
        clearButton.toolTip = "Clear and record a new combination"
        clearButton.setAccessibilityLabel("Clear the hotkey")

        let row = NSStackView(views: glyphs.map(\.label) + [keyLabel])
        row.orientation = .horizontal
        row.spacing = 6
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        clearButton.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        addSubview(clearButton)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            // Equal, not at most: the field's width is its content's, the way
            // a settings row's control is sized to what it holds. Under an
            // inequality nothing here fixes the width, and the row stretches
            // it across the whole card.
            row.trailingAnchor.constraint(equalTo: clearButton.leadingAnchor, constant: -8),
            clearButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            clearButton.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityRole(.button)
        setAccessibilityLabel("Global hotkey")
    }

    // MARK: state

    func setCombo(_ combo: HotkeyCombo?) {
        self.combo = combo
        render()
    }

    private func render() {
        let active: NSEvent.ModifierFlags = recording ? liveModifiers : (combo?.menuModifierMask ?? [])
        for (flag, label) in glyphs {
            label.textColor = active.contains(flag) ? .controlAccentColor : .tertiaryLabelColor
        }
        if recording {
            keyLabel.stringValue = "Press a combination"
            keyLabel.textColor = .tertiaryLabelColor
        } else if let combo {
            keyLabel.stringValue = combo.keySymbol
            keyLabel.textColor = .labelColor
        } else {
            keyLabel.stringValue = "No hotkey"
            keyLabel.textColor = .tertiaryLabelColor
        }
        clearButton.isHidden = recording || combo == nil
        applyColors()
    }

    /// The layer's two colours, resolved against the appearance this view is
    /// drawn in.
    ///
    /// `performAsCurrentDrawingAppearance` is load-bearing rather than
    /// decoration. A dynamic `NSColor` resolves through `.cgColor` against
    /// whatever appearance is current on the thread, which outside a drawing
    /// context is not this view's, so a bare `.cgColor` here freezes the ground
    /// at whatever happened to be current when the field was built. The field
    /// is built once, with the Settings window, and never rebuilt, so a wrong
    /// ground taken then is a wrong ground for the life of the process, and
    /// `viewDidChangeEffectiveAppearance` cannot rescue it: the view's own
    /// appearance never changed. `StatusOverlay` resolves the same way and
    /// `MissingFileBar` avoids the trap by drawing instead of filling a layer.
    private func applyColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
            layer?.borderColor = (recording ? NSColor.controlAccentColor : NSColor.separatorColor).cgColor
        }
        layer?.borderWidth = recording ? 2 : 1
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        // CGColors are resolved once, so an appearance change has to redraw
        // them; NSColor-backed text follows the appearance by itself.
        applyColors()
    }

    // MARK: recording

    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        if !recording { startRecording() }
    }

    @objc private func clearAndRecord() {
        combo = nil
        window?.makeFirstResponder(self)
        startRecording()
    }

    override func becomeFirstResponder() -> Bool { true }

    override func resignFirstResponder() -> Bool {
        stopRecording()
        return true
    }

    private func startRecording() {
        guard monitor == nil else { return }
        recording = true
        liveModifiers = []
        render()
        // A local monitor rather than keyDown: every interesting combination is
        // also a menu key equivalent, and those are matched before an event
        // reaches a view. Returning nil consumes the event outright, so
        // recording ⌘W does not close the window on the way past.
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { [weak self] event in
            guard let self, self.recording else { return event }
            // The monitor is application-wide. If the field is no longer where
            // the keystrokes are meant to go, stop rather than eat them: a
            // window ordered out while recording never resigns first responder.
            guard self.window?.isKeyWindow == true else {
                self.stopRecording()
                return event
            }
            return self.handle(event) ? nil : event
        }
    }

    private func stopRecording() {
        guard recording else { return }
        recording = false
        liveModifiers = []
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        render()
    }

    /// True when the event was consumed.
    private func handle(_ event: NSEvent) -> Bool {
        if event.type == .flagsChanged {
            liveModifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
            render()
            return true
        }
        // Escape abandons the recording and leaves the hotkey as it was.
        if event.keyCode == 53, HotkeyCombo.carbonModifiers(event.modifierFlags) == 0 {
            stopRecording()
            window?.makeFirstResponder(nil)
            return true
        }
        guard let combo = HotkeyCombo.from(event: event) else {
            // A bare key, or one outside the vocabulary. Say nothing and keep
            // listening: the user is mid-chord as often as not.
            NSSound.beep()
            return true
        }
        self.combo = combo
        stopRecording()
        window?.makeFirstResponder(nil)
        onCombo?(combo)
        return true
    }
}
