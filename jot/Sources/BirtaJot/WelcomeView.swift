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
/// a row that exists in both places is the same row, drawn the same way and
/// worded the same. It is a SUBSET of what Settings shows: the questions
/// somebody cannot answer later without going looking, which is how to summon
/// it, where the notes go, and whether it is an app in the Dock. Everything
/// else has a default worth keeping and a row in Settings, and a screen that
/// listed all of them would be a form rather than a welcome.
@MainActor
final class WelcomeView: NSView {
    var onContinue: (() -> Void)?
    var onAllSettings: (() -> Void)?
    /// Reload the panel against a changed file location, which is the only
    /// setting here that decides which bytes the editor will open.
    var onChange: ((BeforeReload?) -> Void)?

    private let hotkeyRecorder = HotkeyRecorderView(combo: Prefs.hotkey)
    private let hotkeyCaption = Caption("")
    private let iCloudSwitch = NSSwitch()
    private let iCloudCaption = Caption("")
    private let locationPath = PathLabel(Prefs.scratchpadURL)
    private let dockSwitch = NSSwitch()
    private let loginSwitch = NSSwitch()
    private let loginCaption = Caption("")
    private let updateSwitch = NSSwitch()
    private let updateCaption = Caption("")
    private var locationGroup: NSView?
    /// The rows on screen, so availability reaches the label and the caption
    /// together. The same map Settings keeps, for the same reason.
    private var rowViews: [SettingsRow: SettingsRowView] = [:]
    private var column: NSStackView?
    private let hero = NSImageView()

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

    /// The brand's paper, and the only literal colours in this app.
    ///
    /// Each is the ground the MARK is drawn on, taken from the artwork rather
    /// than picked to go with it: `#F3EFE3` is the light logo's paper and
    /// `#373D34` is the dark one's. That is what lets the squircle above sit
    /// on the same paper as the screen instead of on a card floating over a
    /// different one, and it is why these are two literals rather than
    /// `windowBackgroundColor`: the system's ground is not the mark's ground,
    /// and the join would be visible in both directions.
    ///
    /// Brand-fixed but appearance-AWARE, which is the pair of decisions worth
    /// keeping apart. It does not follow the theme, because this is a splash
    /// moment and a paper that drifted with an accent colour would not be the
    /// mark's paper any more. It does follow light and dark, because a screen
    /// that stays cream while the rest of the machine is dark is not a brand
    /// moment, it is a screen that forgot to look. Everything after this one
    /// is the system's colours, which is why there is exactly one of these.
    private static let brandPaper = NSColor(name: "birtaJotWelcomePaper") { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(srgbRed: 0x37 / 255.0, green: 0x3D / 255.0, blue: 0x34 / 255.0, alpha: 1)
            : NSColor(srgbRed: 0xF3 / 255.0, green: 0xEF / 255.0, blue: 0xE3 / 255.0, alpha: 1)
    }

    /// The ground, for the check that it differs between appearances. The
    /// colour itself stays private: what is exposed is a reader, so a test
    /// cannot become a second place the value is written down.
    static var brandPaperForTesting: NSColor { brandPaper }

    /// The mark, in the appearance now in force.
    ///
    /// Two files rather than one tinted image: the mark is not a glyph, it has
    /// its own ground and its own ink, and the dark artwork is drawn rather
    /// than derived.
    ///
    /// NOT `NSApp.applicationIconImage`, which is what this screen used to
    /// draw and is where the white border and the drop shadow came from: macOS
    /// composites its own treatment onto an application's icon so a Dock tile
    /// reads as a tile, and on a screen where the mark sits on its own paper
    /// that treatment is chrome around a join that should be invisible.
    ///
    /// The fallback is for a process with no bundle around it, which is every
    /// test host: the screen still builds, and what it draws there is not what
    /// the check is about.
    private static func heroImage(for appearance: NSAppearance) -> NSImage? {
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let name = dark ? "WelcomeHeroDark" : "WelcomeHero"
        if let url = Bundle.main.url(forResource: name, withExtension: "png"),
           let image = NSImage(contentsOf: url) {
            return image
        }
        return NSApp.applicationIconImage
    }

    /// Painted rather than set on the layer.
    ///
    /// A layer colour is not part of the view's drawing, so anything that asks
    /// this hierarchy to draw itself gets the ground missing: the snapshot the
    /// panel can take of itself is the case that matters here, and a screen
    /// that photographs white while looking right is a screen nobody can check.
    override func draw(_ dirtyRect: NSRect) {
        Self.brandPaper.setFill()
        dirtyRect.fill()
    }

    private func build() {

        for (control, on, action) in [
            (iCloudSwitch, Prefs.noteHome == .iCloud, #selector(toggleICloud)),
            (dockSwitch, Prefs.showInDock, #selector(toggleDock)),
            (loginSwitch, false, #selector(toggleLogin)),
            (updateSwitch, Prefs.autoUpdate, #selector(toggleAutoUpdate)),
        ] {
            control.controlSize = .small
            control.state = on ? .on : .off
            control.target = self
            control.action = action
        }

        hotkeyRecorder.onCombo = { [weak self] combo in self?.hotkeyChosen(combo) }

        // Our own file, cut to the squircle macOS does not apply for you.
        // Nothing is added over it: a shadow or a border would be chrome
        // around a mark drawn on the same paper this screen is, and the join
        // should not be visible.
        hero.image = Self.heroImage(for: effectiveAppearance)
        hero.imageScaling = .scaleProportionallyUpOrDown
        hero.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hero.widthAnchor.constraint(equalToConstant: Self.heroSide),
            hero.heightAnchor.constraint(equalToConstant: Self.heroSide),
        ])

        // No title. The mark above says the app's name in the app's own
        // lettering, and a heading under it is that name a second time in the
        // system font: the reader is being told once, and shown once, which
        // reads as two headings rather than one.
        let buttons = buildButtons()

        // The rows, as their own column. Leading-aligned and pinned to one
        // width, because a vertical stack sizes an arranged view to its own
        // content otherwise: each card would be as wide as the longest label
        // in it, and cards down a screen would step in and out at the edges
        // like a ransom note.
        //
        // Fewer rows than Settings, and no headings. A first run asks the few
        // questions somebody cannot answer later without going looking: how to
        // summon it, where the notes go, and whether it is an app in the Dock.
        // WHICH rows those are is `SettingsForm.welcome` rather than a list
        // here, because the same declaration draws Settings' General pane and
        // the two must not drift apart; this file only says what each row is
        // wired to.
        let form = NSStackView(views: SettingsForm.welcome.map { group in
            SettingsWindowController.group(group.rows.map { row in
                let (control, caption) = wiring(for: row)
                let view = SettingsWindowController.row(row.settingsRow, control: control,
                                                       caption: caption)
                rowViews[row.settingsRow] = view
                return view
            })
        })
        locationGroup = form.arrangedSubviews[
            SettingsForm.welcome.firstIndex(where: { $0.rows.contains(.location) }) ?? 1]
        form.orientation = .vertical
        form.alignment = .leading
        // ONE gap between cards, and that is the whole of it. This used to set
        // 8 here and then 18 after every second arranged view, which is the
        // rule Settings needs, where a heading and its card alternate and the
        // wider gap starts a section. This screen draws no headings, so every
        // arranged view is a card and that rule put 8 between the first pair
        // and 18 between the second: three groups, two gaps, visibly unequal.
        form.spacing = 18
        form.translatesAutoresizingMaskIntoConstraints = false
        form.widthAnchor.constraint(equalToConstant: SettingsWindowController.Metrics.content).isActive = true
        for view in form.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }
        let stack = NSStackView(views: [hero, form, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(24, after: hero)
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

    /// What each first-run row is wired to. Its own map rather than Settings',
    /// because the controls differ (no Settings button beside Start at login
    /// here); what may NOT differ is which rows appear and how they are
    /// worded, and that is `SettingsForm`'s to say.
    ///
    /// Over `WelcomeRow` rather than `SettingsRow`, so this switch is
    /// exhaustive over exactly the questions this screen asks. A row added to
    /// the first run fails to compile until it has a control here, and a row
    /// that is only ever a Settings row cannot reach this method at all.
    private func wiring(for row: WelcomeRow) -> (NSView, Caption?) {
        switch row {
        case .summon: return (hotkeyRecorder, hotkeyCaption)
        case .storeInICloud: return (iCloudSwitch, iCloudCaption)
        case .location:
            return (SettingsWindowController.pathControl(locationPath, self, #selector(chooseLocation)), nil)
        case .showInDock: return (dockSwitch, nil)
        case .startAtLogin: return (loginSwitch, loginCaption)
        // No Check Now button here, unlike the Settings row this shares a
        // label with. A first run is a question about what Jot should do from
        // now on, and a button that goes to the network the moment somebody
        // opens the app for the first time is an answer to a question nobody
        // asked yet.
        case .autoUpdate: return (updateSwitch, updateCaption)
        }
    }

    private func buildButtons() -> NSView {
        let settings = NSButton(title: "All Settings", target: self, action: #selector(allSettings))
        settings.bezelStyle = .rounded
        let cont = NSButton(title: "Start Writing", target: self, action: #selector(cont))
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
        dockSwitch.state = Prefs.showInDock ? .on : .off
        showAutoUpdate()
        showLoginItem(LoginItem.state)
        showLocation()
    }

    /// The update row, which a development build cannot honour.
    ///
    /// Said out loud rather than left switched on and doing nothing: replacing
    /// a development build would delete the change it was installed to show.
    /// The same words Settings uses, because it is the same fact.
    private func showAutoUpdate() {
        // `problemsOnly`, because this screen asks questions rather than
        // documenting the answers: a row that works needs no sentence here,
        // and one that cannot needs the same sentence Settings gives it.
        let availability = RowAvailability
            .autoUpdate(updatesItself: AppFlavor.current.updatesItself).problemsOnly
        updateSwitch.isEnabled = availability.isEnabled
        updateSwitch.state = Prefs.autoUpdate && availability.isEnabled ? .on : .off
        rowViews[.autoUpdate]?.apply(availability)
    }

    @objc private func toggleAutoUpdate() {
        Prefs.autoUpdate = updateSwitch.state == .on
    }

    /// The mark follows the system between light and dark. The ground does so
    /// on its own, being a dynamic colour drawn in `draw`; an `NSImage` in an
    /// image view does not, so it is swapped here.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        hero.image = Self.heroImage(for: effectiveAppearance)
        needsDisplay = true
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
            SettingsWindowController.setRowHidden(
                locationGroup,
                row: SettingsForm.index(of: .location, inGroupOf: SettingsForm.welcome) ?? 1,
                hidden: inICloud)
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
        let availability = RowAvailability.startAtLogin(state).problemsOnly
        loginSwitch.state = state.isOn ? .on : .off
        loginSwitch.isEnabled = availability.isEnabled
        rowViews[.startAtLogin]?.apply(availability)
    }

    private func hotkeyChosen(_ combo: HotkeyCombo) {
        Prefs.hotkey = combo
        let status = onHotkeyChange()
        rowViews[.summon]?.apply(status == noErr
            ? .available()
            : .warning("That combination is taken by another app."))
    }

    /// The same gesture Settings' row makes, and it has to stay the same one.
    ///
    /// Clearing a chosen path is what makes iCloud reachable at all: a path
    /// the user picked outranks both homes, so leaving it set would put the
    /// switch on while the notes stayed in their folder, with the Location row
    /// now hidden and nothing on screen naming where they are.
    @objc private func toggleICloud() {
        let previous = Prefs.notesDirectory
        if iCloudSwitch.state == .on {
            Prefs.scratchpadURL = nil
            Prefs.storeInICloud = true
        } else {
            Prefs.storeInICloud = false
        }
        showLocation()
        NotesMoveOffer.offer(movingFrom: previous, to: Prefs.notesDirectory,
                             in: window) { [weak self] work in self?.onChange?(work) }
    }

    @objc private func toggleDock() {
        Prefs.showInDock = dockSwitch.state == .on
        AppDelegate.applyActivationPolicy()
    }

    /// macOS can refuse the registration, and the switch has to follow what the
    /// system actually did rather than what was asked for, or it sits on
    /// claiming a registration that does not exist.
    @objc private func toggleLogin() {
        do {
            showLoginItem(try LoginItem.set(loginSwitch.state == .on))
        } catch {
            showLoginItem(LoginItem.state)
            rowViews[.startAtLogin]?.apply(
                .warning("macOS refused: \(error.localizedDescription)"))
        }
    }

    @objc private func chooseLocation() {
        guard let window else { return }
        let panel = NSSavePanel()
        panel.title = "Where your notes live"
        panel.nameFieldStringValue = Prefs.scratchpadURL.lastPathComponent
        panel.directoryURL = Prefs.scratchpadURL.deletingLastPathComponent()
        panel.allowedContentTypes = DocumentTypes.writtenContentTypes
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url, let self else { return }
            let previous = Prefs.notesDirectory
            Prefs.scratchpadURL = url
            self.showLocation()
            NotesMoveOffer.offer(movingFrom: previous, to: Prefs.notesDirectory,
                                 in: self.window) { [weak self] work in self?.onChange?(work) }
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
