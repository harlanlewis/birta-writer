import AppKit
import BirtaJotCore

/// The questions Jot asks the first time it runs, drawn IN the panel instead of
/// the editor rather than in a window of its own.
///
/// In the panel because a first launch has nothing to edit yet. A separate
/// window puts a form in front of a document the person has not seen, leaves
/// two windows to deal with, and makes the editor available underneath while
/// the settings that decide where its bytes go are still unanswered. Taking the
/// panel over answers all three: there is one window, it is the window they
/// summoned, and there is nothing to type into until the questions are done.
///
/// Every row is a LIVE setting, written the moment it moves, which is why there
/// is no Cancel: there would be nothing to roll back. `Continue` and
/// `All Settings` both simply resolve the screen; neither commits anything the
/// switches have not already committed.
///
/// The defaults the switches show are written when this view first appears
/// (`Prefs.applyOnboardingDefaults`), so what is displayed and what is stored
/// are the same thing from the first frame. That is what lets a default like
/// rich link previews be ON here without ever being ON for somebody who was
/// not shown the switch.
///
/// It composes `SettingsWindowController`'s row, group and caption pieces, so
/// a row that exists in both places is the same row, drawn the same way.
@MainActor
final class WelcomeView: NSView {
    var onContinue: (() -> Void)?
    var onAllSettings: (() -> Void)?
    /// Reload the panel against a changed file location, which is the only
    /// setting here that decides which bytes the editor will open.
    var onChange: (() -> Void)?

    private let hotkeyRecorder = HotkeyRecorderView(combo: Prefs.hotkey)
    private let hotkeyCaption = Caption("")
    private let iCloudSwitch = NSSwitch()
    private let iCloudCaption = Caption("")
    private let locationPath = PathLabel(Prefs.scratchpadURL)
    private let autosaveSwitch = NSSwitch()
    private let dockSwitch = NSSwitch()
    private let loginSwitch = NSSwitch()
    private let loginCaption = Caption("")
    private let networkSwitch = NSSwitch()
    private var locationGroup: NSView?
    private var column: NSStackView?

    init(onHotkeyChange: @escaping () -> OSStatus) {
        self.onHotkeyChange = onHotkeyChange
        super.init(frame: .zero)
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private let onHotkeyChange: () -> OSStatus

    /// The hero, at the size a first-run screen wants it.
    private static let heroSide: CGFloat = 96
    /// Clear of the titlebar band, which is transparent and full height, so a
    /// row pinned to the top would sit under the traffic lights.
    private static let topInset: CGFloat = 44

    private func build() {
        wantsLayer = true
        layer?.backgroundColor = NSColor.textBackgroundColor.cgColor

        for (control, on, action) in [
            (iCloudSwitch, Prefs.noteHome == .iCloud, #selector(toggleICloud)),
            (autosaveSwitch, Prefs.autosave, #selector(toggleAutosave)),
            (dockSwitch, Prefs.showInDock, #selector(toggleDock)),
            (loginSwitch, false, #selector(toggleLogin)),
            (networkSwitch, Prefs.networkEnabled, #selector(toggleNetwork)),
        ] {
            control.controlSize = .small
            control.state = on ? .on : .off
            control.target = self
            control.action = action
        }
        hotkeyRecorder.onCombo = { [weak self] combo in self?.hotkeyChosen(combo) }

        // The app's own icon rather than the logo drawn again here. It is the
        // same artwork, and `make-icons.sh` has already cut it to the squircle
        // macOS does not apply for you, so reading it back means the hero can
        // never disagree with the icon in the Dock beside it.
        let hero = NSImageView()
        hero.image = NSApp.applicationIconImage
        hero.imageScaling = .scaleProportionallyUpOrDown
        hero.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hero.widthAnchor.constraint(equalToConstant: Self.heroSide),
            hero.heightAnchor.constraint(equalToConstant: Self.heroSide),
        ])

        let title = NSTextField(labelWithString: AppFlavor.current.displayName)
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.alignment = .center

        let location = SettingsWindowController.group([
            SettingsWindowController.row("Store files in iCloud Drive",
                                         control: iCloudSwitch, caption: iCloudCaption),
            SettingsWindowController.row("Location",
                                         control: SettingsWindowController.pathControl(
                                            locationPath, self, #selector(chooseLocation))),
        ])
        locationGroup = location

        let buttons = buildButtons()

        // The rows, as their own column. Leading-aligned and pinned to one
        // width, because a vertical stack sizes an arranged view to its own
        // content otherwise: each card would be as wide as the longest label
        // in it, and three cards down a screen would step in and out at the
        // edges like a ransom note.
        let form = NSStackView(views: [
            SettingsWindowController.heading("Show and hide Jot"),
            SettingsWindowController.group([
                SettingsWindowController.row("Summon Jot", control: hotkeyRecorder, caption: hotkeyCaption),
            ]),
            SettingsWindowController.heading("Where your notes live"),
            location,
            SettingsWindowController.heading("How Jot works"),
            SettingsWindowController.group([
                SettingsWindowController.row("Autosave", control: autosaveSwitch),
                SettingsWindowController.row("Show in Dock", control: dockSwitch),
                SettingsWindowController.row("Start at login", control: loginSwitch, caption: loginCaption),
                SettingsWindowController.row("Rich link previews and embeds", control: networkSwitch,
                                             caption: Caption("Off means no outbound request at all.")),
            ]),
        ])
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = 8
        form.translatesAutoresizingMaskIntoConstraints = false
        form.widthAnchor.constraint(equalToConstant: SettingsWindowController.Metrics.content).isActive = true
        for view in form.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }
        // A heading belongs to the card under it, not between two of them.
        for index in form.arrangedSubviews.indices where index > 0 && index % 2 == 0 {
            form.setCustomSpacing(18, after: form.arrangedSubviews[index - 1])
        }

        let stack = NSStackView(views: [hero, title, form, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(14, after: hero)
        stack.setCustomSpacing(24, after: title)
        stack.setCustomSpacing(24, after: form)
        stack.translatesAutoresizingMaskIntoConstraints = false
        column = stack

        // A scroller, because the panel can be shorter than these questions and
        // a first run that cannot reach its own Continue button is a first run
        // nobody can finish.
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        // FLIPPED, so the content starts at the top. A scroll view's document
        // is bottom-left by default, which puts a taller-than-the-window
        // screen on screen already scrolled to its end: the reader arrives
        // mid-sentence and the thing they were meant to read first, the app
        // saying its own name, is above them.
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: Self.topInset),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -24),
            stack.centerXAnchor.constraint(equalTo: document.centerXAnchor),
        ])
        scroll.documentView = document
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
        ])

        sync()
    }

    private func buildButtons() -> NSView {
        let settings = NSButton(title: "All Settings", target: self, action: #selector(allSettings))
        settings.bezelStyle = .rounded
        let cont = NSButton(title: "Continue", target: self, action: #selector(cont))
        cont.bezelStyle = .rounded
        // The default button, so Return finishes the screen. It is also what
        // makes it the loud one: `keyEquivalent` is what tints a rounded
        // button, not a style flag.
        cont.keyEquivalent = "\r"
        let row = NSStackView(views: [settings, cont])
        row.orientation = .horizontal
        row.spacing = 12
        return row
    }

    /// How tall the panel has to be for all of this to be on screen at once.
    ///
    /// A first run that cannot reach its own Continue button without scrolling
    /// is one somebody can fail to finish, so the window is sized to the
    /// questions rather than the questions to the window. The scroller stays
    /// for the case this cannot win: a display too short for the content,
    /// where something has to give.
    var fittingContentHeight: CGFloat {
        (column?.fittingSize.height ?? 0) + Self.topInset + 24
    }

    /// Put every control where the settings actually are.
    func sync() {
        hotkeyRecorder.setCombo(Prefs.hotkey)
        iCloudSwitch.state = Prefs.noteHome == .iCloud ? .on : .off
        iCloudSwitch.isEnabled = Prefs.iCloudAvailable
        autosaveSwitch.state = Prefs.autosave ? .on : .off
        dockSwitch.state = Prefs.showInDock ? .on : .off
        networkSwitch.state = Prefs.networkEnabled ? .on : .off
        showLoginItem(LoginItem.state)
        showLocation()
    }

    /// The location row exists only when the answer above is no.
    ///
    /// With iCloud Drive on there is one place the note can be and it is the
    /// same place on every Mac, so a path row would be a read-only fact taking
    /// a row of a screen that exists to ask the few questions worth asking.
    /// With it off the folder is a real choice, and this is where it is made.
    private func showLocation() {
        locationPath.setURL(Prefs.scratchpadURL)
        let inICloud = Prefs.noteHome == .iCloud
        if let locationGroup {
            SettingsWindowController.setRowHidden(locationGroup, row: 1, hidden: inICloud)
        }
        iCloudCaption.say(Prefs.iCloudAvailable
                          ? ""
                          : "iCloud Drive is off in System Settings, so notes stay on this Mac.",
                          bad: false)
    }

    /// `isOn`, not `== .on`, and `isEnabled` for the same reason.
    ///
    /// `LoginItemState` distinguishes a registration macOS is holding from one
    /// it refused; a switch drawn from `== .on` snaps back for the first and
    /// says the request was declined when it was only pending. Settings reads
    /// it this way and so must this, or the same row means two things.
    private func showLoginItem(_ state: LoginItemState) {
        loginSwitch.state = state.isOn ? .on : .off
        loginSwitch.isEnabled = state.isEnabled
        loginCaption.say(state.caption, bad: state.isWarning)
    }

    private func hotkeyChosen(_ combo: HotkeyCombo) {
        Prefs.hotkey = combo
        let status = onHotkeyChange()
        hotkeyCaption.say(status == noErr ? "" : "That combination is taken by another app.",
                          bad: status != noErr)
    }

    /// The same gesture Settings' row makes, and it has to stay the same one.
    ///
    /// Clearing a chosen path is what makes iCloud reachable at all: a path
    /// the user picked outranks both homes, so leaving it set would put the
    /// switch on while the notes stayed in their folder, with the Location row
    /// now hidden and nothing on screen naming where they are.
    @objc private func toggleICloud() {
        if iCloudSwitch.state == .on {
            Prefs.scratchpadURL = nil
            Prefs.storeInICloud = true
        } else {
            Prefs.storeInICloud = false
        }
        showLocation()
        onChange?()
    }

    @objc private func toggleAutosave() { Prefs.autosave = autosaveSwitch.state == .on }

    @objc private func toggleDock() {
        Prefs.showInDock = dockSwitch.state == .on
        AppDelegate.applyActivationPolicy()
    }

    @objc private func toggleNetwork() {
        Prefs.networkEnabled = networkSwitch.state == .on
        onChange?()
    }

    /// macOS can refuse the registration, and the switch has to follow what the
    /// system actually did rather than what was asked for, or it sits on
    /// claiming a registration that does not exist.
    @objc private func toggleLogin() {
        do {
            showLoginItem(try LoginItem.set(loginSwitch.state == .on))
        } catch {
            showLoginItem(LoginItem.state)
            loginCaption.say("macOS refused: \(error.localizedDescription)", bad: true)
        }
    }

    @objc private func chooseLocation() {
        guard let window else { return }
        let panel = NSSavePanel()
        panel.title = "Where your notes live"
        panel.nameFieldStringValue = Prefs.scratchpadURL.lastPathComponent
        panel.directoryURL = Prefs.scratchpadURL.deletingLastPathComponent()
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url, let self else { return }
            Prefs.scratchpadURL = url
            self.showLocation()
            self.onChange?()
        }
    }

    @objc private func cont() { onContinue?() }
    @objc private func allSettings() { onAllSettings?() }
}

/// A view whose origin is the top left.
///
/// An `NSScrollView`'s document is bottom-left by default, so a document taller
/// than the window opens scrolled to its end. One override is the whole fix,
/// and it is a property of the container rather than something for each caller
/// to remember to undo.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
