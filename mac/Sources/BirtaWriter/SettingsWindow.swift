import AppKit
import BirtaWriterCore
import UniformTypeIdentifiers

/// The app's Settings window.
///
/// Built to the shape macOS settings windows have: a preference toolbar of
/// tabs across the top (which is what centres the title, `toolbarStyle =
/// .preference` doing the work), one pane at a time, each pane a stack of
/// rounded groups of rows, under an opening paragraph where the pane needs
/// one.
///
/// Panes rather than one long column because the list outgrew a column: a
/// window that scrolls past its own title is a form, and a reader looking for
/// one switch should not have to pass nine others.
///
/// A caption is the exception, not the rule. A row whose label already says
/// what it does gets none; the ones that remain either warn (login is blocked)
/// or name something the label cannot (what `{prompt}` means).
///
/// Everything is built in code. A window this size does not earn a nib, and a
/// nib is the one part of the app a script cannot diff.
@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate, NSTextFieldDelegate, NSToolbarDelegate {
    /// The window's one width, and the insets every row shares. A caption has
    /// to be told the width it wraps at before the first layout pass, or the
    /// window sizes itself around a one-line caption and clips the rest.
    enum Metrics {
        static let content: CGFloat = 480
        static let rowInset: CGFloat = 14
        static let windowPadding: CGFloat = 20
        /// Past this the pane scrolls rather than growing the window off the
        /// screen.
        ///
        /// Raised when General absorbed the first-run questions, and again
        /// when it took the note-mode card off the middle pane. Two things
        /// about the number are worth knowing before touching it again.
        ///
        /// It has to fit the TALLEST General rather than the one in front of
        /// you, and how tall that is depends on the machine: with iCloud Drive
        /// switched off, the Location row and its caption are both on screen,
        /// which is roughly sixty points this Mac does not show while iCloud
        /// is on. That difference is why the old ceiling passed locally and
        /// failed on a runner, and `pnpm test` cannot tell you which arm you
        /// are measuring.
        ///
        /// And it is not the real limit: `fitWindowToPane` takes the smaller
        /// of this and the screen, so a display that cannot show this much
        /// scrolls anyway. What this number decides is the point at which
        /// scrolling is preferable to a taller window, on a screen with room
        /// for either. Appearance is the tallest: its two strips of theme
        /// cards are pictures rather than rows and take the height pictures
        /// take, and this has to fit it with every card drawn.
        static let maxPaneHeight: CGFloat = 900
        static var captionWidth: CGFloat { content - rowInset * 2 }
        /// Above the theme strips, on top of whatever `row` leaves between a
        /// row's line and what is drawn under it. Spent by `themeCards`.
        static let themeStripAir: CGFloat = 8
    }

    /// The panes, in toolbar order.
    ///
    /// Three, and the middle one names its subject rather than a place: a tab
    /// costs a click to discover what is on it, so it has to be worth the
    /// click. An Editor pane existed, was removed when its only row was
    /// Autosave, and came back holding three unrelated rows and an agent. The
    /// rows that were not about the agent have gone to General, and what is
    /// left is one subject, which is what the tab is now called.
    ///
    /// The split is by WHAT the rows are about. General is the app as an
    /// application on this Mac: how you reach it, where it puts your bytes,
    /// which note a summon opens, and how it behaves at login and on the
    /// network. AI Agent is the command `/ai` hands a prompt to. Advanced is
    /// what the app does to itself: replace itself, and the gestures that undo
    /// rather than set. Autosave is in General under the argument that removed
    /// the middle pane the first time: it is about when your bytes reach disk,
    /// not about what the editor does with them.
    ///
    /// Which pane a row is on decides nothing about whether the first run may
    /// ask about it. Automatically update is on Advanced and is still a
    /// first-run question, and what holds the two screens together is that
    /// every question is findable somewhere in Settings in the same order
    /// (`SettingsForm.allRows`), not that they share a tab.
    ///
    /// Which rows are on which pane is `SettingsForm`'s and not this enum's.
    private enum Tab: String, CaseIterable {
        case general, markdown, appearance, aiAgent, advanced

        var title: String {
            switch self {
            case .general: return "General"
            case .markdown: return "Markdown"
            case .appearance: return "Appearance"
            case .aiAgent: return "AI Agent"
            case .advanced: return "Advanced"
            }
        }

        var symbol: String {
            switch self {
            case .general: return "gearshape"
            // The pane is about which formatting the editor offers, so the
            // glyph is the one the system uses for text formatting rather than
            // a document or a pencil: neither of those is about the marks.
            case .markdown: return "textformat"
            // The glyph System Settings uses for the same pane.
            case .appearance: return "circle.lefthalf.filled"
            // Not a robot and not a brain: the pane is about handing a request
            // to something that answers, which is what this glyph is for
            // everywhere else on the system.
            case .aiAgent: return "sparkles"
            case .advanced: return "wrench.and.screwdriver"
            }
        }
    }

    /// The rows on screen, by the row they are, so availability reaches the
    /// label and the caption together (`SettingsRowView.apply`). Rebuilt with
    /// each pane; a pane is built once and kept, so an entry is live for as
    /// long as the window is.
    private var rowViews: [SettingsRow: SettingsRowView] = [:]

    private let scrollView = NSScrollView()
    /// Built on first visit and kept, so switching back does not rebuild the
    /// controls and lose the state they are showing.
    private var panes: [Tab: NSView] = [:]

    private let hotkeyRecorder = HotkeyRecorderView(combo: Prefs.hotkey)
    private let hotkeyCaption = Caption("")
    private let scratchpadPath = PathLabel(Prefs.scratchpadURL)
    private let networkSwitch = NSSwitch()
    private let agentField = NSTextField(string: Prefs.agentCommand)
    /// A PULL-DOWN rather than a popup, which is what keeps it from claiming
    /// to be the setting: choosing an entry writes the field below and is then
    /// done with, and the field is what `/ai` runs whatever it says a moment
    /// later.
    ///
    /// Shut, it names the tool the command is RUNNING rather than the last
    /// entry anybody picked, which is a different claim and a checkable one:
    /// it is read back out of the field, by program name alone
    /// (`AgentPreset.matching`), so an edited flag cannot make it lie and a
    /// command of somebody's own puts it back to asking.
    private let agentPresetPopup = NSPopUpButton()
    /// Runs the command once with a trivial prompt and shows what came back.
    /// A command is a shell line somebody typed, and until it has been run
    /// nothing on this pane can tell an installed tool from a typo.
    private let agentTestButton = NSButton(title: "Test", target: nil, action: nil)
    /// The selected tool's own documentation, under the command field.
    ///
    /// One button that MOVES rather than a link per preset: what it points at
    /// is read back out of the command (`AgentPreset.matching`), so it names
    /// the tool being run rather than the last entry anybody picked, and a
    /// command this build does not recognise leaves nothing to link to.
    private let agentDocLink = LinkButton(title: AgentPreset.fallback.title,
                                          url: AgentPreset.fallback.documentation)
    /// What the row's stack is arranging, so the link can be taken out of the
    /// layout entirely rather than left as a blank line.
    private var agentDocLinkHolder: NSView?
    private let agentEnabledSwitch = NSSwitch()
    /// Whether the page currently running was booted with the agent
    /// capability. Compared against `Prefs.agentAvailable` after every write
    /// on this pane, so the editor is reloaded when the answer changed and
    /// left alone when it did not.
    private var agentCapabilityInPage = Prefs.agentAvailable
    private let newNoteField = NSTextField(string: Prefs.newNoteNameTemplate)
    private let dockSwitch = NSSwitch()
    private let menuBarSwitch = NSSwitch()
    private let autosaveSwitch = NSSwitch()
    /// The two questions the file settings ask: what a summon opens, and where
    /// notes live.
    ///
    /// A popup for the first, which has two named answers and no yes in it. A
    /// switch for the second, which is one two-way choice: the folder inside
    /// iCloud Drive the app derives, or the folder named in the Location row
    /// under it, which starts under Documents. `NoteHome` is the rule, and the
    /// reason a stored path no longer has to be thrown away to keep this
    /// switch honest.
    private let opensPopup = NSPopUpButton()
    private let openFilesPopup = NSPopUpButton()
    private let iCloudSwitch = NSSwitch()
    private let iCloudCaption = Caption("")
    private let networkCaption = Caption("")
    /// The cards holding a row that comes and goes with the answer above it.
    /// Kept because hiding a row means reaching back into the card that drew
    /// it: Location under Store in iCloud Drive, File name under New windows
    /// open with, and the agent command under the switch that enables it.
    private var filesGroup: NSView?
    private var notesGroup: NSView?
    private var agentGroup: NSView?
    private let newNoteCaption = Caption("")
    private let updateSwitch = NSSwitch()
    private let updateCaption = Caption("")
    private let updateButton = NSButton(title: "Check Now", target: nil, action: nil)
    private let resetButton = NSButton(title: "Reset to defaults", target: nil, action: nil)
    private let welcomeButton = NSButton(title: "Show Welcome", target: nil, action: nil)
    /// The Appearance pane's controls (`AppearanceControls.swift`). View >
    /// Theme and the palette move the same setting, so the pane is re-read
    /// whenever it could be stale (`refreshAppearance`) rather than trusted
    /// to be what was last chosen here.
    private let followSwitch = NSSwitch()
    private let lightStrip = ThemeStrip(kind: .light)
    private let darkStrip = ThemeStrip(kind: .dark)
    /// The one strip drawn while a mode is held: every theme of either
    /// kind, with the two system cards first.
    private let heldStrip = ThemeStrip(kind: nil)
    /// The two shapes the theme card takes, built once and shown by
    /// `AppearanceSettings.followsSystem` (`themeCards`).
    private let slotStrips = NSStackView()
    private let heldStrips = NSStackView()
    private let addThemeButton = NSPopUpButton()
    private let accentRow = SwatchRow(colors: AppearanceOverlay.accents, noneTitle: "Default")
    private let tintRow = SwatchRow(colors: AppearanceOverlay.tints, noneTitle: "None")
    private let sidebarSwitch = NSSwitch()
    private let tocSidebarSwitch = NSSwitch()
    private let formattingRowSwitch = NSSwitch()
    private let fontControl = NSSegmentedControl(labels: SettingsWindowController.fontChoices.map(\.title), trackingMode: .selectOne,
                                                 target: nil, action: nil)
    private let fontSizeStepper = FontSizeStepper()
    private let contentWidthControl = NSSegmentedControl(
        labels: SettingsWindowController.contentWidthChoices.map(\.title),
        trackingMode: .selectOne, target: nil, action: nil)
    /// The library as last read.
    private var themeRows: [ThemeSummary] = []
    /// The registry browser while its sheet is up. Held here because nothing
    /// in the sheet holds it: every back-reference AppKit keeps to a target,
    /// a delegate or a data source is weak, so a controller nobody owns is
    /// gone before its sheet is on screen, and the sheet stays up with
    /// buttons that reach nothing (`UpdatePrompt` says the same of an offer).
    private var themeBrowser: ThemeBrowserController?
    /// The installed-themes picker while its sheet is up, held for the
    /// same reason.
    private var installedThemesSheet: InstalledThemesSheetController?
    static let addThemeFromFileTitle = "Choose File or Folder…"
    static let addThemeFromVSCodeTitle = "Add Themes Installed in VS Code"
    static let browseThemesTitle = "Browse Open VSX…"
    /// The presets the page offers this host (`typography.ts` withholds the
    /// editor font where the host declares no `editorFont`), each with the
    /// editor command that picks it.
    static let fontChoices: [(preset: String, title: String, command: String)] = [
        ("sans", "Sans", "fontSans"), ("serif", "Serif", "fontSerif"), ("mono", "Mono", "fontMono"),
    ]
    /// Full against fixed, in the page's own words and running the page's own
    /// commands: the segmented control the toolbar's gear menu carries
    /// (`webview/components/toolbar/typography.ts`), on a pane, for every
    /// window at once.
    ///
    /// The stored value is the page's spelling too (`shared/contentWidth.ts`),
    /// so what this pane writes and what a page posts back are one vocabulary
    /// and the pane never has to translate. What "fixed" measures is the
    /// page's as well, and it is not offered here: the measure is in `ch`, so
    /// it already follows the font size the row above sets, and a second
    /// number to tune would be asking for a decision the reading measure has
    /// already made.
    static let contentWidthChoices: [(mode: String, title: String, command: String)] = [
        ("full", "Full", "contentWidthFull"), ("fixed", "Fixed", "contentWidthFixed"),
    ]
    /// One switch per publishing target, keyed by the target itself.
    ///
    /// A dictionary built from `SyntaxSet.allCases` rather than four named
    /// properties, so a fifth target gets a control without this file being
    /// edited; what it still needs is a row in `SettingsForm`, which the
    /// exhaustive `SettingsForm.row(for:)` makes a compile error rather than
    /// an omission.
    private let syntaxSwitches: [SyntaxSet: NSSwitch] =
        Dictionary(uniqueKeysWithValues: SyntaxSet.allCases.map { ($0, NSSwitch()) })
    /// The floor's switch: on, and never operable. It is a statement drawn in
    /// the shape of the rows under it, so nothing wires it and no `Prefs`
    /// value stands behind it.
    private let commonMarkSwitch = NSSwitch()
    private let loginSwitch = NSSwitch()
    private let loginCaption = Caption(LoginItemState.off.caption)
    private let loginSettingsButton = NSButton(title: "Open System Settings…", target: nil, action: nil)

    /// A runner of this window's own, for the Test button and nothing else.
    ///
    /// Not the Coordinator's. A probe is not a `/ai` run: it is not registered
    /// as one, cannot be cancelled from the panel, and never reaches the note,
    /// so sharing the object that tracks live runs would only give this a way
    /// to interfere with them.
    private let agentProbe = AgentRunner()

    /// Which build this window is drawing for.
    ///
    /// Taken rather than read from `AppFlavor.current`, and every one of this
    /// window's flavour differences goes through it: the auto-update row being
    /// dead, the Welcome screen row existing at all, the window's own title
    /// and the sentence under Reset. A `static let` read at the point of use
    /// is fixed by the process, and under `swift test` that process is the
    /// xctest tool, whose bundle id is neither of ours: `AppFlavor.forBundle`
    /// answers `.release` for it, so the development arm of every one of those
    /// four was unreachable and the suite was green either way.
    ///
    /// The one production caller passes `.current` EXPLICITLY rather than
    /// taking a default. A default every production call site takes is a seam
    /// nothing proves is wired: the tests would then exercise a sibling of the
    /// path the app runs rather than that path itself. As it stands the only
    /// thing not under test is one literal at one call site, which is visible
    /// where it is written instead of spread across four reads.
    let flavour: AppFlavor

    private let onHotkeyChange: () -> OSStatus
    /// The chord macOS refused, or nil while it holds one.
    ///
    /// A reader rather than a value, because the answer is older than this
    /// window: the registration happens at launch, and this pane is what
    /// somebody opens afterwards to find out. Defaulted to nil so the ten checks
    /// that build this controller to look at something else are not each a place
    /// to restate it. That default is also the one way this feature could die
    /// silently, since dropping the argument at the call site would leave every
    /// check green and every row reading as ordinary, so `SummonRefusalWiringTests`
    /// holds each hop from the registration to here by name.
    private let refusedSummonCombo: () -> HotkeyCombo?
    /// Re-read the preferences. The argument is work to run between the
    /// buffer's flush and the page's reload; only a location change uses it.
    private let onChange: (BeforeReload?) -> Void
    /// Re-read the preferences in EVERY window, not the front one.
    ///
    /// A second closure rather than a flag on `onChange`, because the two are
    /// different claims about a setting rather than two ways of doing one
    /// thing: `onChange` is for a setting whose only surface is the window it
    /// changes, and this is for one with a surface the application owns. The
    /// publishing targets are the first of those, and `WindowSet` holds why.
    private let onChangeEverywhere: () -> Void
    /// Show the welcome window. Injected rather than built here: the window is
    /// the app delegate's, so it survives this one being closed.
    private let onShowWelcome: () -> Void
    /// Ask for an update check now. The Updater is the app delegate's, so it
    /// outlives this window.
    private let onCheckForUpdates: () -> Void
    /// The themes the app holds, for the Appearance pane to list and add to.
    private let themeStore: ThemeStore
    /// Store the settings and put them on every window, live. The app's
    /// rather than the front window's, because a theme is what the app
    /// looks like (`WindowSet.setAppearance`).
    private let onAppearanceChange: (AppearanceSettings) -> Void
    /// The library changed under the settings: the app re-reads which theme
    /// is in force, since the one it had may have been replaced or removed.
    private let onThemesChanged: () -> Void
    /// Run an editor command in every window: the typography rows are the
    /// toolbar's own commands, which apply live and post the setting back.
    private let onEditorCommand: (String) -> Void
    /// Show or hide the formatting row in every window.
    ///
    /// The app's setting rather than a command, which is why this is not
    /// `onEditorCommand`: the page has no control that flips it and posts
    /// nothing back, so the store and every open page are this closure's to
    /// move (`WindowSet.setFormattingRowExpanded`). Defaulted so a test
    /// building this window need not wire an app behind it.
    private let onFormattingRowChange: (Bool) -> Void

    /// Every setting has just gone back to its default, and the window in
    /// front should land on the default note. A third closure rather than a
    /// call to `onChange`, because the ordinary reload leaves a window bound
    /// through no slot where it is (`Coordinator.rebindFromSettings`), and the
    /// front window is regularly slotless; `WindowSet.settingsWereReset` is
    /// what hands it the scratchpad first. Defaulted so a test building this
    /// window need not wire an app behind it.
    private let onReset: () -> Void

    init(flavour: AppFlavor,
         onHotkeyChange: @escaping () -> OSStatus,
         refusedSummonCombo: @escaping () -> HotkeyCombo? = { nil },
         onChange: @escaping (BeforeReload?) -> Void,
         onChangeEverywhere: @escaping () -> Void,
         onReset: @escaping () -> Void = {},
         onShowWelcome: @escaping () -> Void,
         onCheckForUpdates: @escaping () -> Void,
         themeStore: ThemeStore = .installed,
         onAppearanceChange: @escaping (AppearanceSettings) -> Void = { _ in },
         onThemesChanged: @escaping () -> Void = {},
         onEditorCommand: @escaping (String) -> Void = { _ in },
         onFormattingRowChange: @escaping (Bool) -> Void = { _ in }) {
        self.flavour = flavour
        self.themeStore = themeStore
        self.onAppearanceChange = onAppearanceChange
        self.onThemesChanged = onThemesChanged
        self.onEditorCommand = onEditorCommand
        self.onFormattingRowChange = onFormattingRowChange
        self.onHotkeyChange = onHotkeyChange
        self.refusedSummonCombo = refusedSummonCombo
        self.onChange = onChange
        self.onChangeEverywhere = onChangeEverywhere
        self.onReset = onReset
        self.onShowWelcome = onShowWelcome
        self.onCheckForUpdates = onCheckForUpdates
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Metrics.content + Metrics.windowPadding * 2, height: 300),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        // The app's name, not the pane's. A multi-pane settings window titles
        // itself after the selected pane, and that rule assumes the app is
        // named somewhere else on screen; this is an accessory app with no Dock
        // icon, so "General" alone belongs to nothing the user can see. The
        // toolbar below the title already names and highlights the pane.
        //
        // Read from outside Swift: `shared/__tests__/editorCommandsContributions.test.ts`
        // relates this template to the editor row that opens the window, since
        // no TypeScript can import it. It matches the interpolation by shape
        // rather than by the expression inside, so renaming what carries the
        // name is safe; making the title a bare literal, or interpolating
        // something that is not a display name, is what it refuses.
        window.title = "\(flavour.displayName) Settings"
        // No `window.level` here, and that absence is the point. This window
        // used to be raised to `.floating` to match a panel that could float,
        // because an ordinary-level window opened BEHIND the one it was opened
        // from. The panel is at the ordinary level in every case now, so there
        // is nothing left to match and a settings window pinned over every
        // other application would be a bug rather than a setting.
        super.init(window: window)
        window.delegate = self

        let toolbar = NSToolbar(identifier: "BirtaWriterSettings")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        // The whole reason for the toolbar: `.preference` is what draws tabs
        // in the titlebar and centres the title above them, which is the shape
        // every other settings window on the machine has.
        window.toolbarStyle = .preference

        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let container = BackgroundView()
        container.addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: container.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        window.contentView = container

        toolbar.selectedItemIdentifier = NSToolbarItem.Identifier(Tab.general.rawValue)
        show(.general)
        window.center()
    }

    /// Put `tab` on screen and size the window to it, the way a settings
    /// window does: the window is as tall as the pane needs, up to a ceiling
    /// past which the pane scrolls instead.
    private func show(_ tab: Tab) {
        // The window is `fitWindowToPane`'s to find; this only needs the pane.
        let pane = panes[tab] ?? {
            let built = buildPane(tab)
            panes[tab] = built
            return built
        }()
        scrollView.documentView = pane
        // Re-pinned on every show, which is correct rather than wasteful:
        // setting `documentView` takes the previous pane out of the view
        // hierarchy, and AppKit drops the constraints that referenced it, so a
        // pane pinned only when it was built comes back unpinned. Measured:
        // after cycling every pane twice, the scroll view holds three
        // constraints, the ones for the pane actually on screen.
        pane.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pane.topAnchor.constraint(equalTo: scrollView.contentView.topAnchor),
            pane.leadingAnchor.constraint(equalTo: scrollView.contentView.leadingAnchor),
            pane.trailingAnchor.constraint(equalTo: scrollView.contentView.trailingAnchor),
        ])
        shown = tab
        fitWindowToPane()
    }

    /// Which pane is on screen, so `fitWindowToPane` knows what to measure.
    private var shown: Tab?

    /// Size the window to the pane on screen.
    ///
    /// Separate from `show` because a pane's height is not fixed once it is
    /// built: a row that comes and goes with the answer above it (Location,
    /// under Store in iCloud Drive) changes what the pane needs while somebody
    /// is looking at it. Without this the window keeps the height it was first
    /// sized to and a scroller appears over two rows of settings, which reads
    /// as a pane too big for its window rather than a window that did not
    /// follow.
    ///
    /// The ceiling is the smaller of `maxPaneHeight` and the screen.
    /// `maxPaneHeight` is what a pane may take before scrolling is the lesser
    /// evil; a display that cannot show even that is the only case where the
    /// scroller earns its keep.
    private func fitWindowToPane() {
        // Nothing while a pane is being built. `buildPane` puts its rows in
        // step as it goes, and those calls end here, but the pane being built
        // is not in `panes` yet and `shown` still names the previous one: the
        // window would be resized to the pane being left, and then resized
        // again a moment later by the `show` that asked for the build. Harmless
        // to look at and wrong to leave, because it is a measurement of the
        // wrong subject that happens to be corrected by the next line.
        guard !building else { return }
        guard let window, let pane = shown.flatMap({ panes[$0] }) else { return }
        pane.layoutSubtreeIfNeeded()
        let screenHeight = (window.screen ?? NSScreen.main)?.visibleFrame.height ?? Metrics.maxPaneHeight
        let wanted = min(pane.fittingSize.height, Metrics.maxPaneHeight, screenHeight)
        let frame = window.frameRect(forContentRect: NSRect(
            x: 0, y: 0, width: Metrics.content + Metrics.windowPadding * 2, height: wanted))
        guard abs(frame.height - window.frame.height) > 0.5 else { return }
        // Traced because the failure is a window that simply does not follow,
        // which looks like a pane too tall rather than a resize that did not
        // happen. `mac/scripts/measure.sh` reads it.
        //
        // `content` and `pane` are the pair worth comparing, and `to` is not:
        // a frame height carries the titlebar and the toolbar as well, so a
        // window whose CONTENT is shorter than its pane still reads as taller
        // than it by that much. `content` is what the pane is given, capped at
        // `cap`; `pane` is what it asked for.
        if ProcessInfo.processInfo.environment["BIRTA_MAC_MEASURE"] == "1" {
            FileHandle.standardError.write(Data(
                ("birta-trace settingsfit from=\(Int(window.frame.height)) to=\(Int(frame.height))"
                 + " content=\(Int(wanted)) pane=\(Int(pane.fittingSize.height))"
                 + " cap=\(Int(min(Metrics.maxPaneHeight, screenHeight)))\n").utf8))
        }
        var target = window.frame
        // Grow downward from the title bar, which is where a settings window
        // grows: the top edge is what the eye is anchored to.
        target.origin.y += target.height - frame.height
        target.size = frame.size
        // Never animated. A settings window that slides between two heights
        // draws the eye to the chrome moving rather than to the pane that
        // arrived, and it does it on every tab click, which is the gesture
        // somebody makes most. The window is simply the size of what it is
        // showing, at the moment it is showing it.
        window.setFrame(target, display: true)
    }

    // MARK: toolbar

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        Tab.allCases.map { NSToolbarItem.Identifier($0.rawValue) }
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarAllowedItemIdentifiers(toolbar)
    }

    /// The selectable set IS the whole set: every item is a pane, and a
    /// preference toolbar with no selectable items draws tabs that never
    /// highlight.
    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarAllowedItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard let tab = Tab(rawValue: identifier.rawValue) else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = tab.title
        item.paletteLabel = tab.title
        item.image = NSImage(systemSymbolName: tab.symbol, accessibilityDescription: tab.title)
        item.target = self
        item.action = #selector(selectTab(_:))
        return item
    }

    /// Every pane's name, in toolbar order.
    ///
    /// Exposed because `Tab` is private and the thing worth checking is the
    /// CORRESPONDENCE: a tab with no declared pane draws an empty window, and
    /// a declared pane with no tab is rows nothing shows. Neither is visible
    /// from either side alone.
    static var tabNames: [String] { Tab.allCases.map(\.rawValue) }

    /// The rows a pane declares, by that same name. Paired with `tabNames` so
    /// a test can walk the panes without knowing which array is which.
    ///
    /// On the instance rather than the type, because Advanced is not the same
    /// pane on every build: the Welcome screen row exists only where the
    /// flavour shows the first run. A static answer here would be the release
    /// pane compared against whatever this window actually drew, which is a
    /// comparison that reports a disagreement on a development build and
    /// tells you nothing about either.
    func declaredRows(forTab name: String) -> [SettingsRow]? {
        guard let tab = Tab(rawValue: name) else { return nil }
        switch tab {
        case .general: return SettingsForm.rows(of: SettingsForm.general)
        case .markdown: return SettingsForm.rows(of: SettingsForm.markdown)
        case .appearance: return SettingsForm.rows(of: SettingsForm.appearance)
        case .aiAgent: return SettingsForm.rows(of: SettingsForm.aiAgent)
        case .advanced: return SettingsForm.rows(of: advancedPane)
        }
    }

    /// The Advanced pane THIS window draws, which its flavour decides.
    var advancedPane: SettingsPane {
        SettingsForm.advanced(showsWelcomeScreen: flavour.showsWelcomeScreen)
    }

    /// One row of the pane on screen, so a check can read back the label and
    /// the caption availability was applied to rather than assert against the
    /// rule that produced it.
    ///
    /// The thing worth checking here is the WIRING: `RowAvailability` is
    /// checkable on its own, and what it cannot tell you is whether the pane
    /// ever hands a row its answer.
    func rowForTesting(_ row: SettingsRow) -> SettingsRowView? { rowViews[row] }

    /// Show a pane by name, for `BIRTA_MAC_OPEN_SETTINGS`. Unknown names are
    /// ignored rather than fatal: the variable is a probe, and a typo in it
    /// should not stop the app.
    func selectTabForTesting(_ name: String) {
        show(paneNamed: name, revealing: nil)
    }

    /// The pane names `show(paneNamed:revealing:)` answers to, in tab order,
    /// for the palette to group Settings by; unknown names are ignored there.
    static var paneNames: [String] { Tab.allCases.map(\.rawValue) }

    /// The panes' titles in the same order, for a check that the palette's
    /// groups say what the toolbar says.
    static var paneTitles: [String] { Tab.allCases.map(\.title) }

    /// Show the pane named `name` and, given a row, scroll it into view: what
    /// picking a Settings row in the command palette does (MAR-458). The row's
    /// availability is left as the pane drew it; a row that cannot be operated
    /// still says why, which is what the reader came to see.
    func show(paneNamed name: String, revealing row: SettingsRow?) {
        guard let tab = Tab(rawValue: name) else { return }
        window?.toolbar?.selectedItemIdentifier = NSToolbarItem.Identifier(tab.rawValue)
        show(tab)
        guard let row, let view = rowViews[row] else { return }
        view.scrollToVisible(view.bounds)
    }

    /// Show every row an answer above it can take away, and every caption that
    /// only some machines see.
    ///
    /// So a height check measures the TALLEST a pane gets rather than the one
    /// this Mac happens to draw. Which rows are on screen depends on the
    /// machine: with iCloud Drive switched off, General carries the Location
    /// row and a caption saying so, which is roughly sixty points a Mac with
    /// iCloud on never shows. That is not a corner case, it is half the
    /// machines, and it is why a ceiling that fits here can fail on a runner
    /// with the suite green both times.
    ///
    /// Deliberately one-way: it only reveals. Putting the rows back is what
    /// `showFiles`, `showAgent` and `showNoteMode` do from the real settings,
    /// so nothing here has to remember a previous state.
    func showEveryConditionalRowForTesting() {
        let cards: [(NSView?, SettingsRow, SettingsPane)] = [
            (filesGroup, .location, SettingsForm.general),
            (notesGroup, .newNoteName, SettingsForm.general),
            (agentGroup, .agentCommand, SettingsForm.aiAgent),
        ]
        for (card, row, pane) in cards {
            guard let card, let index = SettingsForm.index(of: row, inPane: pane) else { continue }
            Self.setRowHidden(card, row: index, hidden: false)
        }
        // The captions that only appear on some machines, said here so the
        // measurement carries their height too.
        iCloudCaption.say("iCloud Drive is off in System Settings, so notes stay on this Mac.", bad: false)
        rowViews[.startAtLogin]?.apply(.startAtLogin(.blocked))
        // The theme card's taller shape, a strip per mode, whatever the
        // defaults suite running this happens to hold.
        slotStrips.isHidden = false
        heldStrips.isHidden = true
        fitWindowToPane()
    }

    /// Move the iCloud switch the way a click does, for `BIRTA_MAC_TOGGLE_ICLOUD`.
    ///
    /// The Location row under it comes and goes with this answer, which is the
    /// one thing that changes a pane's height after it is built. Without a way
    /// to drive it, a check on the window following its pane can only ever see
    /// the FIRST sizing, which happens whether or not the following works.
    func toggleICloudForTesting() {
        // Traced either way. The switch is disabled when iCloud Drive is off
        // in System Settings, which is a fact about the machine running the
        // check and not about the product; without this line the arm reads a
        // missing second resize and blames the window for not following.
        if ProcessInfo.processInfo.environment["BIRTA_MAC_MEASURE"] == "1" {
            FileHandle.standardError.write(Data(
                "birta-trace icloudtoggle available=\(iCloudSwitch.isEnabled ? 1 : 0)\n".utf8))
        }
        guard iCloudSwitch.isEnabled, let action = iCloudSwitch.action else { return }
        iCloudSwitch.state = iCloudSwitch.state == .on ? .off : .on
        NSApp.sendAction(action, to: iCloudSwitch.target, from: iCloudSwitch)
    }

    @objc private func selectTab(_ sender: NSToolbarItem) {
        guard let tab = Tab(rawValue: sender.itemIdentifier.rawValue) else { return }
        show(tab)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: content

    /// Wire every control once, whichever pane ends up holding it.
    private func wireControls() {
        hotkeyRecorder.onCombo = { [weak self] combo in self?.hotkeyChosen(combo) }
        wireAppearanceControls()

        // Titles come from the types, so a case added to `NoteMode` or
        // `AgentPreset` appears here without this file being edited. The
        // menu's own order is the type's declaration order.
        opensPopup.removeAllItems()
        opensPopup.addItems(withTitles: NoteMode.allCases.map(\.title))
        opensPopup.controlSize = .small
        opensPopup.target = self
        opensPopup.action = #selector(chooseNoteMode)

        openFilesPopup.removeAllItems()
        openFilesPopup.addItems(withTitles: FileOpenTarget.allCases.map(\.title))
        openFilesPopup.controlSize = .small
        openFilesPopup.target = self
        openFilesPopup.action = #selector(chooseOpenFilesIn)

        // Item 0 is the button's own title under `pullsDown`, never an answer,
        // which is why the presets start at 1.
        agentPresetPopup.pullsDown = true
        agentPresetPopup.removeAllItems()
        agentPresetPopup.addItems(withTitles: [Self.presetMenuPrompt] + AgentPreset.allCases.map(\.title))
        agentPresetPopup.controlSize = .small
        agentPresetPopup.target = self
        agentPresetPopup.action = #selector(chooseAgentPreset)

        updateButton.target = self
        updateButton.action = #selector(checkForUpdatesNow)
        updateButton.controlSize = .small
        agentTestButton.target = self
        agentTestButton.action = #selector(testAgentCommand)
        agentTestButton.controlSize = .small
        resetButton.target = self
        resetButton.action = #selector(resetAllSettings)
        resetButton.controlSize = .small
        welcomeButton.target = self
        welcomeButton.action = #selector(showWelcomeAgain)
        welcomeButton.controlSize = .small

        agentField.placeholderString = "claude -p {prompt}"
        agentField.delegate = self
        agentField.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        // No width constraint: this one is the full width of its card, under
        // the row rather than beside it. A command is long, monospaced and
        // edited character by character, and 260pt of it is a slot to squint
        // at rather than a field to work in.

        newNoteField.delegate = self
        newNoteField.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        newNoteField.placeholderString = NoteNameTemplate.default
        newNoteField.alignment = .right
        newNoteField.widthAnchor.constraint(equalToConstant: 200).isActive = true
        // Aligned with the field it answers rather than with the prose, so the
        // template and the name it produces sit in one column.
        newNoteCaption.alignment = .right

        loginSettingsButton.target = self
        loginSettingsButton.action = #selector(openLoginItemSettings)
        loginSettingsButton.controlSize = .small

        for (control, on, action) in [
            (networkSwitch, Prefs.networkEnabled, #selector(toggleNetwork)),
            (iCloudSwitch, Prefs.noteHome == .iCloud, #selector(toggleICloud)),
            (updateSwitch, Prefs.autoUpdate, #selector(toggleAutoUpdate)),
            (agentEnabledSwitch, Prefs.agentEnabled, #selector(toggleAgentEnabled)),
            (autosaveSwitch, Prefs.autosave, #selector(toggleAutosave)),
            (dockSwitch, Prefs.showInDock, #selector(toggleShowInDock)),
            (menuBarSwitch, Prefs.showInMenuBar, #selector(toggleShowInMenuBar)),
            (loginSwitch, false, #selector(toggleLoginItem)),
        ] {
            // The size a settings row uses. A regular NSSwitch is drawn for a
            // control that is the point of its own view; in a list of rows it
            // is the loudest thing on the pane. `SettingsSwitchTests` pins
            // that the system still draws `.small` smaller, and holds the trap
            // in checking it: a switch reports the regular size until it has
            // been laid out in a view hierarchy.
            control.controlSize = .small
            control.state = on ? .on : .off
            control.target = self
            control.action = action
        }
        // The target switches are wired from the vocabulary rather than from
        // the tuple list above, because each of them writes a MEMBER of one
        // stored set rather than a setting of its own, so they share one action
        // that asks the sender which target it is.
        for (_, control) in syntaxSwitches {
            control.controlSize = .small
            control.target = self
            control.action = #selector(toggleSyntaxSet(_:))
        }
        // Disabled rather than merely unwired: an unwired switch still flips
        // under the pointer and snaps back, which reads as a broken control
        // rather than a fixed one. The row's label keeps its ordinary ink,
        // because the row is not unavailable in the `RowAvailability` sense;
        // it is answered.
        commonMarkSwitch.controlSize = .small
        commonMarkSwitch.state = .on
        commonMarkSwitch.isEnabled = false
        syncControlsFromPrefs()
    }

    /// Put every control back in step with what is stored.
    ///
    /// Extracted because `wireControls` runs exactly once, from the first
    /// `buildPane`, so before this existed there was NO way to redraw a pane
    /// from `Prefs`. That is fine while the only writer is the control itself
    /// and fatal the moment something changes several settings at once, which
    /// is exactly what Reset does: without this the pane would go on showing
    /// the values it was built with while the app ran on the defaults.
    private func syncControlsFromPrefs() {
        networkSwitch.state = Prefs.networkEnabled ? .on : .off
        // Not `showAutoUpdate` and `showLoginItem` here: both draw through
        // `rowViews`, so they are `showRowAvailability`'s and are called again
        // once the pane exists. What stays here is the switch positions, which
        // are properties and are safe to set before anything is laid out.
        networkCaption.say("Renders some YouTube, Loom, Figma, Google Docs, and links from "
                           + "other services as interactive embedded content. Requires internet "
                           + "access.", bad: false)
        autosaveSwitch.state = Prefs.autosave ? .on : .off
        dockSwitch.state = Prefs.showInDock ? .on : .off
        menuBarSwitch.state = Prefs.showInMenuBar ? .on : .off
        hotkeyRecorder.setCombo(Prefs.hotkey)
        agentField.stringValue = Prefs.agentCommand
        newNoteField.stringValue = Prefs.newNoteNameTemplate
        agentEnabledSwitch.state = Prefs.agentEnabled ? .on : .off
        let sets = Prefs.syntaxSets
        for (set, control) in syntaxSwitches {
            control.state = sets.contains(set) ? .on : .off
        }
        // The two callers of this both leave the page holding whatever
        // `Prefs` says: the build, which runs before anything is offered, and
        // Reset, which reloads unconditionally afterwards. Either way the
        // mirror is true again from here.
        agentCapabilityInPage = Prefs.agentAvailable
        showAgentPreset()
        showAgent()
        showRowAvailability()
        showNoteMode()
        showNoteNamePreview()
        showFiles()
        refreshAppearance()
    }

    /// The rows whose availability is a fact about the build or the system
    /// rather than a stored setting.
    ///
    /// Together, because they are the two rows that can be dead, and both draw
    /// through `rowViews`: what they set is a label's ink and a sentence, so
    /// they can only run once the pane holding those views exists.
    private func showRowAvailability() {
        showAutoUpdate()
        showLoginItem(LoginItem.state)
        // Which draws the summon row too, because its sentence names the
        // surfaces this decides.
        showPresence()
    }

    /// What the summon row says about the chord in force.
    ///
    /// Here rather than only in `hotkeyChosen`, which is the gap this closes: a
    /// refusal at launch used to reach an `NSLog` and nothing else, so the
    /// sentence existed only for somebody who RECORDED a new chord and was gone
    /// again the next time the pane opened. Somebody whose summon has never
    /// worked opens this pane to find out why, and that is the one reader it
    /// was invisible to (MAR-407).
    private func showSummon() {
        showSummon(refused: refusedSummonCombo())
    }

    /// The same row, told what was refused by the caller.
    ///
    /// Two callers with two sources for that one fact, deliberately. Opening
    /// the pane reads the stored refusal, and recording a chord reads the status
    /// of the attempt it just made: a recorder that went through the stored
    /// reader instead would be trusting two injected closures to be wired to the
    /// same registration, and a pair wired apart would draw a row that lies with
    /// nothing to catch it. What they share is the SENTENCE, which is the thing
    /// that had drifted.
    private func showSummon(refused: HotkeyCombo?) {
        rowViews[.summon]?.apply(RowAvailability.summon(
            refused: refused,
            menuBar: Prefs.showInMenuBar, dock: Prefs.showInDock))
    }

    /// The two rows saying where the app can be reached from.
    ///
    /// Drawn together because the rule binding them is ONE rule and it is
    /// symmetric: whichever surface is currently the last way in says so and
    /// cannot be switched off, and moving EITHER switch can change the other
    /// row's answer. Redrawing only the row that was clicked would leave the
    /// other one blocked after the move that unblocked it.
    private func showPresence() {
        let (menuBar, dock) = (Prefs.showInMenuBar, Prefs.showInDock)
        for (surface, control, row) in [
            (AppPresence.Surface.menuBar, menuBarSwitch, SettingsRow.showInMenuBar),
            (AppPresence.Surface.dock, dockSwitch, SettingsRow.showInDock),
        ] {
            let availability = RowAvailability.appPresence(surface, menuBar: menuBar, dock: dock)
            control.isEnabled = availability.isEnabled
            rowViews[row]?.apply(availability)
        }
        // The summon row follows, because a refusal's escape hatch NAMES these
        // two surfaces. Drawn from here rather than beside it in
        // `showRowAvailability` so that the two switches redraw it as well: the
        // screen where somebody is recovering from a dead chord is the last
        // place to leave a sentence pointing at an icon they just switched off.
        showSummon()
    }

    /// The agent command exists only when the switch above it is on.
    ///
    /// Off is not "on but ignored": with `/ai` withdrawn there is no command
    /// to name, and a field sitting there editable would be a setting for a
    /// thing that does not run.
    private func showAgent() {
        guard let agentGroup else { return }
        SettingsWindowController.setRowHidden(
            agentGroup,
            row: SettingsForm.index(of: .agentCommand, inPane: SettingsForm.aiAgent) ?? 1,
            hidden: !Prefs.agentEnabled)
        fitWindowToPane()
    }

    /// The file-name template exists only when a summon makes a new note.
    ///
    /// With the same note opening every time there is never a name to choose,
    /// so the row would be a setting that decides nothing.
    private func showNoteMode() {
        opensPopup.selectItem(withTitle: Prefs.noteMode.title)
        openFilesPopup.selectItem(withTitle: Prefs.openFilesIn.title)
        guard let notesGroup else { return }
        SettingsWindowController.setRowHidden(
            notesGroup,
            row: SettingsForm.index(of: .newNoteName, inPane: SettingsForm.general) ?? 1,
            hidden: Prefs.noteMode != .newEachSession)
        fitWindowToPane()
    }

    /// Put the file rows where the machine and the settings actually are.
    ///
    /// The caption belongs to the home row and carries the two things the menu
    /// itself cannot say: WHERE that choice put the file, and the one case
    /// where the choice is overruled. Asking for iCloud Drive on a Mac with
    /// iCloud Drive switched off lands in Documents, silently in behaviour and
    /// not in the interface.
    private func showFiles() {
        scratchpadPath.setURL(Prefs.scratchpadURL)
        iCloudSwitch.state = Prefs.noteHome == .iCloud ? .on : .off
        iCloudSwitch.isEnabled = Prefs.iCloudAvailable
        // The Location row exists only when the answer above is no. With
        // iCloud Drive on there is one place the note can be and it is the
        // same place on every Mac, so the row would be a read-only fact; with
        // it off the folder is a real choice, and this is where it is made.
        if let filesGroup {
            SettingsWindowController.setRowHidden(
                filesGroup,
                row: SettingsForm.index(of: .location, inPane: SettingsForm.general) ?? 1,
                hidden: Prefs.noteHome == .iCloud)
            // The pane just got shorter or taller, so the window follows it.
            fitWindowToPane()
        }
        iCloudCaption.say(Prefs.iCloudAvailable
                          ? ""
                          : "iCloud Drive is off in System Settings, so notes stay on this Mac.",
                          bad: false)
    }

    /// Put the update row where this build actually stands.
    ///
    /// A development build cannot update itself, and the row says why rather
    /// than sitting there switched on and doing nothing: replacing it would
    /// delete the change it was installed to show.
    private func showAutoUpdate() {
        let availability = RowAvailability.autoUpdate(updatesItself: flavour.updatesItself)
        updateSwitch.isEnabled = availability.isEnabled
        updateButton.isEnabled = availability.isEnabled
        updateSwitch.state = Prefs.autoUpdate && availability.isEnabled ? .on : .off
        rowViews[.autoUpdate]?.apply(availability)
    }

    @objc private func toggleAutoUpdate() {
        Prefs.autoUpdate = updateSwitch.state == .on
    }

    @objc private func checkForUpdatesNow() {
        onCheckForUpdates()
    }

    /// What the pull-down reads with its menu shut when the command below it
    /// names no tool this build knows.
    private static let presetMenuPrompt = "Select AI"

    /// What it reads for a given command: the tool being run, or the prompt.
    ///
    /// A PULL-DOWN still, so this is not the menu claiming to be the setting:
    /// the field below it is what `/ai` runs, and choosing an entry writes
    /// that field and is then done with. What the title says is the answer to
    /// a question somebody looking at a shell command should not have to
    /// parse, which is which of these tools it is. Matched on the program
    /// alone (`AgentPreset.matching`), so an edited flag does not make the
    /// menu forget the tool it is still running.
    private static func presetMenuTitle(for command: String) -> String {
        AgentPreset.matching(command: command)?.title ?? presetMenuPrompt
    }

    /// Put the pull-down's title back in step with the command field.
    private func showAgentPreset() {
        showAgentPreset(for: Prefs.agentCommand)
    }

    /// Draw the pull-down and the link against `command`, whatever is stored.
    ///
    /// Split out so a check can drive both against a command of its own
    /// without writing a setting: what is worth checking is that the pane
    /// FOLLOWS the command, and a version that read `Prefs` once at build time
    /// would look identical against the default.
    func showAgentPreset(for command: String) {
        agentPresetPopup.item(at: 0)?.title = Self.presetMenuTitle(for: command)
        // Item 0 IS the button's title under `pullsDown`, and AppKit caches
        // what it drew: without this the button keeps the old word until
        // something else makes it re-lay out.
        agentPresetPopup.synchronizeTitleAndSelectedItem()
        // The link follows the same answer the pull-down's title does, so a
        // command naming a tool this build does not know leaves no link rather
        // than one pointing at somebody else's documentation.
        let preset = AgentPreset.matching(command: command)
        if let preset {
            agentDocLink.point(at: preset.documentation, titled: preset.title)
        }
        agentDocLinkHolder?.isHidden = preset == nil
        fitWindowToPane()
    }

    /// Draw a screen from its declaration.
    ///
    /// `SettingsForm` says which rows a pane holds and in what order; this says
    /// what each row is wired to. Splitting them is what lets the first-run
    /// screen show a SUBSET under the same words without a second layout to
    /// keep in step: `WelcomeView` renders the same declaration with its own
    /// controls, and `SettingsFormTests` compares the two lists.
    private func render(_ pane: SettingsPane) -> [NSView] {
        var sections: [NSView] = []
        // The pane's own opening sentences, under the tab that names them.
        // No heading is drawn above them: the toolbar already carries one, and
        // a second copy of the tab's title at the top of its own pane is the
        // window saying where you are twice.
        sections.append(contentsOf: pane.intro.map(Self.intro))
        for group in pane.groups {
            let box = Self.group(group.rows.map { row in
                let parts = wiring(for: row)
                let view = Self.row(row, control: parts.control, below: parts.below,
                                    caption: parts.caption, link: row.link)
                rowViews[row] = view
                return view
            })
            // Remembered, because each of these cards holds a row that is
            // shown and hidden by the answer above it, and hiding a row means
            // reaching back into the card that drew it.
            if group.rows.contains(.location) { filesGroup = box }
            if group.rows.contains(.newNoteName) { notesGroup = box }
            if group.rows.contains(.agentCommand) { agentGroup = box }
            sections.append(box)
        }
        return sections
    }

    /// What one row is made of: the control at its trailing edge, anything
    /// drawn full width beneath it, and the sentence under both.
    private typealias Wiring = (control: NSView, below: [NSView], caption: Caption?)

    /// What each row is wired to. A switch over the enum, so a row added to
    /// `SettingsForm` fails to compile until it has a control.
    private func wiring(for row: SettingsRow) -> Wiring {
        switch row {
        case .summon: return (hotkeyRecorder, [], hotkeyCaption)
        case .storeInICloud: return (iCloudSwitch, [], iCloudCaption)
        case .location:
            // The one thing the row cannot show. A folder is just a folder, so
            // one inside iCloud Drive syncs like anything else there, and
            // without this said out loud the only way to reach that is to try
            // it and hope. It is the same sentence whatever is chosen: naming
            // the folder somebody picked would be the path label again.
            return (Self.pathControl(scratchpadPath, self, #selector(chooseScratchpad)), [],
                    Caption("Choose a folder inside iCloud Drive and it syncs like any other."))
        // No caption. The label is the whole of it, and what OFF means is
        // what off means in every other Mac application: nothing is written
        // until you ask. `AutosavePolicy` is where that promise is kept.
        case .autosave: return (autosaveSwitch, [], nil)
        case .showInDock: return (dockSwitch, [], nil)
        case .showInMenuBar: return (menuBarSwitch, [], nil)
        case .startAtLogin:
            return (Self.trailingControls([loginSettingsButton, loginSwitch]), [], loginCaption)
        case .autoUpdate:
            return (Self.trailingControls([updateButton, updateSwitch]), [], updateCaption)
        case .richLinks: return (networkSwitch, [], networkCaption)
        case .opens: return (opensPopup, [], nil)
        case .opensFilesIn:
            // No caption: the scoping (a file under an open folder window goes
            // to that window whatever this says) is `OpenRouting`'s to keep,
            // and a sentence about it under the row was read as noise.
            return (openFilesPopup, [], nil)
        case .newNoteName:
            // The worked example goes FIRST, under the field and aligned with
            // it, because it is the field's own answer rather than a note
            // about the syntax: the eye reads the template and then what it
            // produces, in the same column. The vocabulary follows, in the
            // caption column where reference text belongs.
            return (newNoteField,
                    [Self.captionRow(newNoteCaption),
                     Self.helpWithLink(NoteNameTemplate.helpText,
                                       linkTitle: NoteNameTemplate.referenceLinkTitle,
                                       to: NoteNameTemplate.referenceURL)],
                    nil)
        case .agentEnabled: return (agentEnabledSwitch, [], nil)
        case .agentCommand:
            // The field is BELOW rather than beside: a shell command is long
            // and monospaced, and the pull-down is what sits at the trailing
            // edge because it is the shortcut rather than the setting. Test is
            // beside the pull-down, since both act on the command rather than
            // describing it.
            let link = Self.link(agentDocLink)
            agentDocLinkHolder = link
            return (Self.trailingControls([agentTestButton, agentPresetPopup]),
                    [agentField, link],
                    Caption("Terminal command executed by /ai in Birta Writer."))
        case .commonMark:
            return (commonMarkSwitch,
                    [Self.captionRow(Caption(CommonMark.caption)),
                     Self.link(CommonMark.documentation.title, to: CommonMark.documentation.url)],
                    nil)
        case .syntaxGfm, .syntaxObsidian, .syntaxPandoc, .syntaxNotion, .syntaxCalc:
            // The switch is found by the target rather than by the row, which
            // is the direction that stays derived: `SettingsForm.row(for:)` is
            // exhaustive over the vocabulary, so the lookup below can only miss
            // for a row this switch statement should not have reached.
            guard let set = SyntaxSet.allCases.first(where: { SettingsForm.row(for: $0) == row }),
                  let control = syntaxSwitches[set] else {
                return (NSView(), [], nil)
            }
            // The sentence goes in `below` rather than as the row's caption so
            // the link can follow it on its own line, the way the note-name
            // row's reference does; `below` is arranged above the caption
            // slot, so a caption there would put the link above the sentence
            // it belongs to. Nothing dims these rows, so the row-level caption
            // slot is not needed for `RowAvailability`.
            var below: [NSView] = [Self.captionRow(Caption(set.caption))]
            if let documentation = set.documentation {
                below.append(Self.link(documentation.title, to: documentation.url))
            }
            return (control, below, nil)
        case .followSystemAppearance: return (followSwitch, [], nil)
        case .theme:
            // The cards under one row whose label is the pane's sentence,
            // with the way to add a theme where a row's control goes. Which
            // cards is the switch's (`themeCards`).
            return (addThemeButton, [Self.inset(themeCards())], nil)
        case .accent: return (accentRow, [], nil)
        case .tint: return (tintRow, [], nil)
        // No caption. What the row turns on is a row of formatting controls,
        // which is what the label says and what appears the moment it is
        // flipped; a sentence under it would be describing something already
        // on screen.
        case .formattingRow: return (formattingRowSwitch, [], nil)
        case .transparentSidebar: return (sidebarSwitch, [], nil)
        case .transparentToc: return (tocSidebarSwitch, [], nil)
        case .font: return (fontControl, [], nil)
        case .fontSize: return (fontSizeStepper, [], nil)
        // No caption. Full fills the window and Fixed caps the text at a
        // reading measure, which is what the two words say; a sentence under
        // them would be the same claim at greater length, and the control is
        // one click away from showing it.
        case .contentWidth: return (contentWidthControl, [], nil)
        case .resetSettings:
            return (resetButton, [],
                    Caption("Revert \(flavour.displayName) to default settings. Will not "
                            + "move, delete, or modify any of your files."))
        case .welcomeScreen:
            return (welcomeButton, [], Caption("The questions Birta Writer asks the first time it runs. An empty note gets the welcome note back too."))
        }
    }

    /// Whether a pane is being constructed right now. See `fitWindowToPane`.
    private var building = false

    private func buildPane(_ tab: Tab) -> NSView {
        building = true
        defer { building = false }
        if panes.isEmpty { wireControls() }
        let sections: [NSView]
        switch tab {
        case .general: sections = render(SettingsForm.general)
        case .markdown: sections = render(SettingsForm.markdown)
        case .appearance: sections = render(SettingsForm.appearance)
        case .aiAgent: sections = render(SettingsForm.aiAgent)
        case .advanced: sections = render(advancedPane)
        }
        // After the sections exist, not before. `wireControls` runs at the top
        // of this method and `showFiles` hides a row of a card that this
        // method is about to build, so the sync above reaches a `filesGroup`
        // that is still nil and the Location row stays on screen with iCloud
        // Drive switched on.
        showFiles()
        showNoteMode()
        showAgent()
        // After the pane exists, or the documentation link is never told what
        // the command names: `wireControls` runs once, from the FIRST pane
        // built, and the link is a view the AI Agent pane creates later. Left
        // out, a command naming no tool still shows the link the button was
        // constructed with, pointing at the wrong tool's documentation.
        showAgentPreset()
        showNoteNamePreview()
        // Also after, and for a second reason: these two write through
        // `rowViews`, which `render` is what fills. Called from
        // `syncControlsFromPrefs` alone they would reach an empty map and the
        // rows would be drawn with no sentence and no dimming at all.
        showRowAvailability()
        // The library is read from disk here rather than at wiring, so a
        // theme added from the menu bar's Add Theme… is on the list the pane
        // it opens draws.
        refreshAppearance()
        return Self.pane(sections)
    }

    /// One pane: sections down the page, padded, sized to its content.
    static func pane(_ sections: [NSView]) -> NSView {
        let stack = NSStackView(views: sections)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        // 20 after each group, so the next heading starts a section rather
        // than reading as a caption on the group above it.
        for (index, view) in stack.arrangedSubviews.enumerated() where view is NSBox {
            if index + 1 < stack.arrangedSubviews.count { stack.setCustomSpacing(20, after: view) }
        }
        stack.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: Metrics.windowPadding),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: Metrics.windowPadding),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -Metrics.windowPadding),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -Metrics.windowPadding),
            stack.widthAnchor.constraint(equalToConstant: Metrics.content),
        ])
        // A leading-aligned vertical stack sizes each arranged view to its own
        // content; the groups are the full width and only the headings sit at
        // their own.
        for view in stack.arrangedSubviews where view is NSBox {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return container
    }

    // MARK: pieces

    /// The ground a settings group sits on.
    ///
    /// NOT `controlBackgroundColor`, which is the obvious choice and resolves
    /// to the SAME colour as `windowBackgroundColor` in both appearances, so a
    /// card painted with it is invisible and the groups read as one long list.
    /// `SettingsCardTests` pins that, and is what would tell us if a future
    /// macOS separated the two and made the obvious colour right again.
    ///
    /// A translucent lift instead, which composites over whatever the window
    /// ground is: it settles into a light window and lifts off a dark one,
    /// which is the direction System Settings' own cards go in each. The group
    /// draws no border, so this fill is the whole of what bounds a card.
    static let settingsCard = NSColor(name: "birtaWriterSettingsCard") { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.06)
            : NSColor(white: 0, alpha: 0.035)
    }

    /// One paragraph of a pane's intro, above its first card.
    ///
    /// Outside the card rather than in it, because it belongs to the whole
    /// pane rather than to any row: a paragraph inside a grouped list reads
    /// as a row that forgot its control. Full content width, since it is prose
    /// and the card's insets are for rows.
    static func intro(_ text: String) -> NSTextField {
        let label = Caption(text, wrapAt: Metrics.content)
        label.say(text, bad: false)
        // `wrapAt` is what makes it wrap, and it is load-bearing rather than a
        // default worth keeping: `pane` sizes only its BOXES to the stack, so
        // a paragraph is left to resolve its own width, and a wrapping label
        // with no maximum resolves that from the text. A heading gets away
        // with it by being short. `SettingsWindowSizeTests` holds the height.
        return label
    }

    /// An intro sentence that ends in a link: the sentence in the intro's
    /// own ink and size, the link where its last word would be.
    /// A caption that is FIXED rather than live: reference text a row needs
    /// once, which nothing later rewrites.
    static func help(_ text: String) -> NSView {
        inset(Caption(text))
    }

    /// Reference text with its link at the end of the sentence.
    ///
    /// One line rather than two, because the link is part of what the sentence
    /// says: the tokens above are a shortlist and this is where the rest are.
    /// A separate line under it reads as a second, unrelated thing to read.
    ///
    /// Still a real button rather than an attributed string, for the reason
    /// `link` gives. Baseline-aligned, so the link sits on the sentence's line
    /// rather than on the centre of a caption that has wrapped.
    static func helpWithLink(_ text: String, linkTitle: String, to url: URL) -> NSView {
        let caption = Caption(text)
        // Free to wrap if the sentence outgrows the row, which keeps the link
        // at the end rather than pushing it off the card.
        caption.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let button = LinkButton(title: linkTitle, url: url)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setContentHuggingPriority(.required, for: .horizontal)
        let stack = NSStackView(views: [caption, button])
        stack.orientation = .horizontal
        stack.alignment = .firstBaseline
        // The link button carries its own bezel inset, so the gap here is
        // narrower than the space between two words would suggest.
        stack.spacing = 0
        let holder = NSView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: Metrics.rowInset),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: holder.trailingAnchor,
                                            constant: -Metrics.rowInset),
            stack.topAnchor.constraint(equalTo: holder.topAnchor),
            stack.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        return holder
    }

    /// A caption-sized link out to documentation we do not own.
    ///
    /// A real button rather than an attributed-string link: this has to be
    /// reachable from the keyboard, and an `NSTextField` carrying a link is
    /// not in the key view loop.
    static func link(_ title: String, to url: URL) -> NSView {
        link(LinkButton(title: title, url: url))
    }

    /// The same, around a link that already exists, for one whose destination
    /// moves with a selection above it.
    static func link(_ button: LinkButton) -> NSView {
        // Leading-aligned with the label above it, and hugging its own title
        // so the clickable area is the words rather than the row.
        let holder = NSView()
        button.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(button)
        NSLayoutConstraint.activate([
            button.leadingAnchor.constraint(equalTo: holder.leadingAnchor,
                                            constant: Metrics.rowInset - 2),
            button.topAnchor.constraint(equalTo: holder.topAnchor),
            button.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            button.trailingAnchor.constraint(lessThanOrEqualTo: holder.trailingAnchor),
        ])
        return holder
    }

    /// A full-width view inset to the label's leading edge, so anything drawn
    /// under a row starts under the name it belongs to.
    static func inset(_ view: NSView) -> NSView {
        let holder = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: Metrics.rowInset),
            view.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -Metrics.rowInset),
            view.topAnchor.constraint(equalTo: holder.topAnchor),
            view.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        return holder
    }

    /// A caption drawn as one of a row's `below` views rather than as its
    /// trailing sentence.
    ///
    /// It has to be inset by hand, because `row` insets a `below` view only
    /// when it is a plain field: a Caption there would otherwise run to the
    /// card's own edges, which is a whole `rowInset` further out than the
    /// column every other sentence starts in. The holder is wired up so an
    /// empty caption still takes itself out of the layout.
    static func captionRow(_ caption: Caption) -> NSView {
        let holder = inset(caption)
        caption.holder = holder
        holder.isHidden = caption.isHidden
        return holder
    }

    /// Several controls as one trailing control, in the order given.
    static func trailingControls(_ views: [NSView]) -> NSView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.alignment = .centerY
        return stack
    }

    /// One rounded section. Rows are separated by a hairline, inset from the
    /// leading edge the way a grouped list insets its separators.
    static func group(_ rows: [NSView]) -> NSView {
        var arranged: [NSView] = []
        for (index, row) in rows.enumerated() {
            if index > 0 { arranged.append(separator()) }
            arranged.append(row)
        }
        let stack = NSStackView(views: arranged)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false

        let box = NSBox()
        box.boxType = .custom
        // No stroke. A settings group is grouped by its fill and the space
        // around it; an outline as well draws a box around something already
        // bounded, and three of them down a pane read as a form.
        box.borderWidth = 0
        box.cornerRadius = 10
        box.fillColor = SettingsWindowController.settingsCard
        box.contentViewMargins = .zero
        box.contentView = stack
        box.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: box.topAnchor),
            stack.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
        ])
        // Rows and hairlines both span the group; a vertical stack sizes its
        // arranged views to their content otherwise, and a hairline's content
        // is nothing.
        for view in arranged { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        return box
    }

    /// Show or hide one row of a `group`, hairline and all.
    ///
    /// A row that comes and goes has to take its separator with it, or hiding
    /// it leaves two hairlines touching where a row used to be. The index
    /// arithmetic is `group`'s own layout read back: it interleaves
    /// `[row, separator, row, separator, row]`, so row `i` sits at `2i` and
    /// the hairline that belongs to it is the one before it. Tied to that
    /// construction on purpose rather than searching for hairlines by type,
    /// which would silently pick up any future one.
    static func setRowHidden(_ group: NSView, row index: Int, hidden: Bool) {
        guard let box = group as? NSBox,
              let stack = box.contentView as? NSStackView else { return }
        let views = stack.arrangedSubviews
        let position = index * 2
        guard position < views.count else { return }
        views[position].isHidden = hidden
        if position > 0 { views[position - 1].isHidden = hidden }
    }

    private static func separator() -> NSView {
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        let holder = NSView()
        holder.addSubview(line)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: Metrics.rowInset),
            line.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            line.topAnchor.constraint(equalTo: holder.topAnchor),
            line.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            holder.heightAnchor.constraint(equalToConstant: 1),
        ])
        return holder
    }

    /// A row, labelled from the shared vocabulary. Every row on either screen
    /// goes through here, so a label has one spelling.
    static func row(_ row: SettingsRow, control: NSView, below: [NSView] = [],
                    caption: Caption? = nil, link: SettingsLink? = nil) -> SettingsRowView {
        self.row(row.label, control: control, below: below, caption: caption, link: link)
    }

    /// A settings row: the name on the left, the control on the right, and an
    /// optional sentence under both.
    ///
    /// `link` follows the name on its line, for the one row whose name is a
    /// sentence ending in one (`SettingsRow.label`): a real button, for the
    /// reason `LinkButton` gives, baseline-aligned so it sits on the
    /// sentence's line.
    ///
    /// The vertical axis is an NSStackView rather than constraints, and that is
    /// the whole reason it is one: NSStackView is the only thing here that
    /// takes a hidden view OUT of the layout. A caption that is empty right now
    /// but may fill later (the login row goes from silent to a warning) has to
    /// collapse to nothing meanwhile, and under plain constraints a hidden
    /// NSTextField keeps its line height and leaves a blank gap.
    static func row(_ title: String, control: NSView, below: [NSView] = [],
                    caption: Caption? = nil, link: SettingsLink? = nil) -> SettingsRowView {
        let label = NSTextField(labelWithString: title)
        let line = NSView()
        // The name, or the name and its link on one line. Either way ONE
        // view at the line's leading edge, so the line holds the name's view
        // and the control and nothing else.
        let name: NSView
        if let link {
            let button = LinkButton(title: link.title, url: link.url)
            button.font = label.font
            button.setContentCompressionResistancePriority(.required, for: .horizontal)
            button.setContentHuggingPriority(.required, for: .horizontal)
            let pair = NSStackView(views: [label, button])
            pair.orientation = .horizontal
            pair.alignment = .firstBaseline
            pair.spacing = 3
            name = pair
        } else {
            name = label
        }
        for view in [name, control] {
            view.translatesAutoresizingMaskIntoConstraints = false
            line.addSubview(view)
        }
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            name.leadingAnchor.constraint(equalTo: line.leadingAnchor, constant: Metrics.rowInset),
            name.topAnchor.constraint(greaterThanOrEqualTo: line.topAnchor),
            name.centerYAnchor.constraint(equalTo: line.centerYAnchor),
            control.trailingAnchor.constraint(equalTo: line.trailingAnchor, constant: -Metrics.rowInset),
            control.centerYAnchor.constraint(equalTo: line.centerYAnchor),
            control.topAnchor.constraint(greaterThanOrEqualTo: line.topAnchor),
            control.bottomAnchor.constraint(lessThanOrEqualTo: line.bottomAnchor),
            control.leadingAnchor.constraint(greaterThanOrEqualTo: name.trailingAnchor, constant: 12),
            line.bottomAnchor.constraint(greaterThanOrEqualTo: name.bottomAnchor),
        ])

        // The line, then anything drawn full width under it, then the
        // sentence. A view in `below` is a CONTROL rather than prose (the
        // agent command field is the case this exists for), so it is inset to
        // the label's edge the way a caption is but is not one.
        var arranged: [NSView] = [line]
        arranged += below.map { $0 is NSTextField && !($0 is Caption) ? inset($0) : $0 }
        if let caption {
            caption.translatesAutoresizingMaskIntoConstraints = false
            // Inset to the label's leading edge, so the sentence starts under
            // the name it belongs to rather than at the card's edge.
            let holder = NSView()
            holder.addSubview(caption)
            NSLayoutConstraint.activate([
                caption.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: Metrics.rowInset),
                caption.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -Metrics.rowInset),
                caption.topAnchor.constraint(equalTo: holder.topAnchor),
                caption.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            ])
            // The HOLDER follows the caption's own hidden state, because it is
            // the holder the stack is arranging.
            caption.holder = holder
            holder.isHidden = caption.isHidden
            arranged.append(holder)
        }

        let stack = SettingsRowView(label: label, caption: caption, arranged: arranged)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for view in arranged { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        return stack
    }

    /// A path and the button that changes it, as one trailing control.
    static func pathControl(_ path: PathLabel, _ button: NSButton) -> NSView {
        let stack = NSStackView(views: [path, button])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.alignment = .centerY
        return stack
    }

    static func pathControl(_ path: PathLabel, _ target: AnyObject, _ action: Selector) -> NSView {
        pathControl(path, NSButton(title: "Choose…", target: target, action: action))
    }

    // MARK: hotkey

    /// Choose a hotkey the way the recorder does, for a check over what the
    /// row says when macOS refuses one. Nothing else reaches this path: the
    /// refusal is the system's answer and cannot be provoked by hand.
    func chooseHotkeyForTesting(_ combo: HotkeyCombo) { hotkeyChosen(combo) }

    private func hotkeyChosen(_ combo: HotkeyCombo) {
        guard combo != Prefs.hotkey else { return }
        Prefs.hotkey = combo
        let status = onHotkeyChange()
        showSummon(refused: status == noErr ? nil : combo)
        hotkeyRecorder.setCombo(combo)
    }

    // MARK: files

    /// The three popups and the two buttons Advanced grew.
    ///
    /// Each writes ONE setting and then re-reads the pane, because these rows
    /// decide each other: the mode dims the file row, and the home changes the
    /// path that row shows.
    @objc private func chooseNoteMode() {
        Prefs.noteMode = NoteMode.allCases.first { $0.title == opensPopup.titleOfSelectedItem }
            ?? Prefs.noteMode
        showNoteMode()
    }

    @objc private func chooseOpenFilesIn() {
        Prefs.openFilesIn = FileOpenTarget.allCases.first { $0.title == openFilesPopup.titleOfSelectedItem }
            ?? Prefs.openFilesIn
    }

    /// Where notes live: the folder the app derives inside iCloud Drive, or
    /// the one named in the Location row below. `NoteLocationChange` is the
    /// gesture, shared with the first-run screen, which asks this in the same
    /// words and must answer it the same way.
    @objc private func toggleICloud() {
        NoteLocationChange.storeInICloud(
            iCloudSwitch.state == .on, in: window,
            redraw: { [weak self] in self?.showFiles() },
            apply: { [weak self] work in self?.onChange(work) })
    }

    /// A template is a SHORTCUT INTO the field below, never a second place the
    /// setting lives. It writes the command and is then done with; the field
    /// is what `/ai` runs, whatever it says a moment later.
    @objc private func chooseAgentPreset() {
        guard let preset = AgentPreset.allCases
            .first(where: { $0.title == agentPresetPopup.titleOfSelectedItem }) else { return }
        Prefs.agentCommand = preset.template
        agentField.stringValue = preset.template
        showAgentPreset()
        syncAgentCapability()
    }

    @objc private func toggleAgentEnabled() {
        Prefs.agentEnabled = agentEnabledSwitch.state == .on
        showAgent()
        syncAgentCapability()
    }

    /// Reload the page only when the agent CAPABILITY has actually changed.
    ///
    /// The page is built from the host profile at boot, so a change to what
    /// this host PROVIDES has to be handed to it again, and the only way to
    /// do that is a reload. A reload is not free to watch: the editor is torn
    /// down and rebuilt under whoever is looking at it, which is why it has
    /// to be asked for by something that changed rather than by something
    /// that was touched.
    ///
    /// Swapping one working command for another does not change what this
    /// host provides. `AgentAvailability` is the same rule `Prefs.bootConfig`
    /// filters the capability with, asked here rather than restated, so the
    /// two cannot drift apart and answer differently.
    private func syncAgentCapability() {
        let available = Prefs.agentAvailable
        guard available != agentCapabilityInPage else { return }
        agentCapabilityInPage = available
        onChange(nil)
    }

    /// Everything back to defaults, in the order that leaves nothing stale.
    ///
    /// A sheet first, because this is not undoable and the window has no
    /// Cancel of its own. Then `Prefs.reset`, then re-apply each thing that
    /// was read at launch and cached somewhere: the Dock policy, the hotkey
    /// registration, and finally the page, which is last because
    /// `onChange` is the only path that flushes the buffer to the old file
    /// before rebinding to the new one. Reversing those two loses whatever is
    /// in the panel.
    @objc private func resetAllSettings() {
        let alert = NSAlert()
        alert.messageText = "Reset all settings?"
        alert.informativeText = "Every setting goes back to its default, including the hotkey. "
            + "Your notes are left exactly where they are, and Birta Writer reopens the default one."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Reset")
        alert.addButton(withTitle: "Cancel")
        guard let window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Prefs.reset()
            AppDelegate.applyActivationPolicy(keepingFrontmost: true)
            AppDelegate.shared?.applyMenuBarPresence()
            _ = self.onHotkeyChange()
            self.syncControlsFromPrefs()
            // The reload, with the front window pointed at the default note
            // first; the header on `onReset` says why `onChange` alone cannot
            // keep the sentence in the sheet true.
            self.onReset()
        }
    }

    /// Ask the first-launch questions again. This clears the flag that gates
    /// the screen and nothing else; the screen it opens is what writes.
    @objc private func showWelcomeAgain() {
        Prefs.hasSeenWelcome = false
        onShowWelcome()
    }

    @objc private func chooseScratchpad() {
        guard let window else { return }
        NoteLocationChange.chooseLocation(
            in: window,
            redraw: { [weak self] in self?.showFiles() },
            apply: { [weak self] work in self?.onChange(work) })
    }


    /// Put the row where the system says it is. Called on every toggle and
    /// whenever the window comes forward, because System Settings changes the
    /// same registration and the app is never told.
    private func showLoginItem(_ state: LoginItemState) {
        let availability = RowAvailability.startAtLogin(state)
        loginSwitch.state = state.isOn ? .on : .off
        loginSwitch.isEnabled = availability.isEnabled
        loginSettingsButton.isHidden = !state.wantsSystemSettings
        rowViews[.startAtLogin]?.apply(availability)
    }

    @objc private func toggleLoginItem() {
        do {
            showLoginItem(try LoginItem.set(loginSwitch.state == .on))
        } catch {
            // Put the switch back where the system still has it, then say what
            // happened. A switch left where the user pushed it would claim a
            // registration that does not exist.
            showLoginItem(LoginItem.state)
            rowViews[.startAtLogin]?.apply(
                .warning("macOS refused: \(error.localizedDescription)"))
        }
    }

    @objc private func openLoginItemSettings() {
        LoginItem.openSystemSettings()
    }

    /// The window is reused rather than rebuilt, and the trip to System
    /// Settings that `blocked` asks for ends by coming back to it, so the row
    /// is re-read on the way in rather than only when it is first built.
    func windowDidBecomeKey(_ notification: Notification) {
        showLoginItem(LoginItem.state)
        // And the appearance: View > Theme and the palette move the same
        // setting this pane shows, and the window is not told.
        refreshAppearance()
        // Same reason: iCloud Drive is switched on in System Settings, and the app
        // is never told. A row that said "iCloud Drive is off" until the next
        // launch would be lying about a thing the user has just changed.
        showFiles()
    }

    /// Committed on every edit rather than only on Return: the window has no
    /// OK button, and a command typed and then dismissed by closing the window
    /// would otherwise be lost without a word.
    func controlTextDidChange(_ notification: Notification) {
        switch notification.object as? NSTextField {
        case let field where field === agentField:
            Prefs.agentCommand = agentField.stringValue
            // While typing, not on blur. The pull-down and the link are a
            // reading of the field, so leaving them on the last tool through
            // a whole edit shows somebody a name and a documentation page for
            // a command they have already replaced.
            showAgentPreset(for: agentField.stringValue)
            syncAgentCapability()
        case let field where field === newNoteField:
            // Stored as typed, including a half-finished token: expansion is
            // `NoteNameTemplate`'s and it falls back rather than failing, so a
            // template mid-edit can never stop a new note being made. The
            // caption underneath shows what today's name would be, which is
            // where a broken format is visible.
            Prefs.newNoteNameTemplate = newNoteField.stringValue
            showNoteNamePreview()
        default: return
        }
    }

    /// What the template would call a note made right now.
    ///
    /// A worked example rather than a description of the syntax: `%Y-%m-%d` is
    /// only obvious to somebody who already knows, and the one question a
    /// person actually has here is what their file will be called.
    private func showNoteNamePreview() {
        newNoteCaption.say(NoteNameTemplate.expand(Prefs.newNoteNameTemplate), bad: false)
    }

    // MARK: the agent test

    /// Run the command in the field once, with a trivial prompt, and show what
    /// came back.
    ///
    /// The one thing on this pane that can tell an installed tool from a typo.
    /// Everything else here is a claim about a shell line nobody has run: the
    /// pull-down names the program, the link points at its documentation, and
    /// both are just as confident about a command that is not on PATH.
    @objc private func testAgentCommand() {
        let template = Prefs.agentCommand.trimmingCharacters(in: .whitespaces)
        let name = Self.toolName(for: template)
        guard !template.isEmpty else {
            showAgentTestResult(name: name, result: AgentProbeResult(
                succeeded: false, transcript: "",
                failure: "There is no command to run. Choose a tool, or type one."))
            return
        }
        // The button IS the progress indicator. A run takes as long as the
        // tool takes to answer, which is seconds, and a spinner beside a
        // button that still says Test invites a second click that starts a
        // second child process.
        agentTestButton.isEnabled = false
        agentTestButton.title = "Testing…"
        agentProbe.probe(template: template) { [weak self] result in
            guard let self else { return }
            self.agentTestButton.isEnabled = true
            self.agentTestButton.title = "Test"
            self.showAgentTestResult(name: name, result: result)
        }
    }

    /// What to call the tool in the sheet: the preset's name where the command
    /// names one, and otherwise the program it runs, which is the most this
    /// can honestly say about somebody's own command line.
    private static func toolName(for command: String) -> String {
        AgentPreset.matching(command: command)?.title
            ?? AgentRequest.harnessName(from: command)
            ?? "The agent"
    }

    /// The sheet: what happened, which tool it was, and what it printed.
    ///
    /// The transcript is in an accessory view rather than in `informativeText`
    /// because an agent's answer is arbitrarily long and a sheet built around
    /// one label grows until it is taller than the screen. It is selectable,
    /// so a failure can be copied into a search.
    private func showAgentTestResult(name: String, result: AgentProbeResult) {
        // Only onto a window that is still on screen. A test takes as long as
        // the tool takes, and Settings can be shut in the meantime: a sheet
        // begun on a closed window either goes nowhere or brings the window
        // back, and neither is an answer to a question the person stopped
        // asking.
        guard let window, window.isVisible else { return }
        Self.agentTestAlert(name: name, result: result).beginSheetModal(for: window)
    }

    /// The sheet itself, built rather than presented, so what it says is
    /// checkable without a window and without anything appearing on screen.
    static func agentTestAlert(name: String, result: AgentProbeResult) -> NSAlert {
        let alert = NSAlert()
        // Not "did not run": a command that started, authenticated and then
        // exited with an error DID run, and that is the ordinary failure here.
        // The pair says what the person asked, which is whether it works.
        alert.messageText = result.succeeded ? "It works!" : "It did not work."
        // The tool's name above whatever it printed, because the answer means
        // nothing without knowing which tool gave it.
        alert.informativeText = name
        alert.alertStyle = result.succeeded ? .informational : .warning
        // What the tool said, and where it said nothing, our own account of
        // how it ended. Never both: two explanations of one failure read as
        // two failures.
        let body = result.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        alert.accessoryView = transcript(body.isEmpty ? (result.failure ?? "") : body)
        // Acknowledge and nothing else. A test that has finished leaves
        // nothing to decide, so a second button would be a question with no
        // question behind it.
        alert.addButton(withTitle: "Close")
        return alert
    }

    /// How big the transcript box is: wide enough for a wrapped shell line,
    /// tall enough for a short answer without becoming a window of its own.
    private static let transcriptSize = NSSize(width: 380, height: 140)

    /// A scrollable, selectable, monospaced block of whatever a command
    /// printed.
    ///
    /// Sized by its FRAME, and this is the part that is easy to get wrong.
    /// `NSAlert` places an accessory view by reading that view's frame; it
    /// does not run a layout pass over it, so a box described by constraints
    /// alone hands the alert a zero rect. What that draws is the sheet in the
    /// screenshot this was found from: an empty bezel sitting over the text it
    /// belongs under, on a failure whose only useful content was inside it.
    ///
    /// The text view is sized the same way and told to track the box's width,
    /// because the same absent layout pass leaves a bare `NSTextView` with no
    /// width to wrap to and nothing drawn at all.
    static func transcript(_ text: String) -> NSView {
        let scroll = NSScrollView(frame: NSRect(origin: .zero, size: transcriptSize))
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .bezelBorder

        let content = scroll.contentSize
        let view = NSTextView(frame: NSRect(origin: .zero, size: content))
        view.minSize = NSSize(width: 0, height: content.height)
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude,
                              height: CGFloat.greatestFiniteMagnitude)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.containerSize = NSSize(width: content.width,
                                                   height: CGFloat.greatestFiniteMagnitude)
        view.textContainer?.widthTracksTextView = true
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        view.textContainerInset = NSSize(width: 4, height: 4)
        view.string = text
        scroll.documentView = view
        return scroll
    }

    @objc private func toggleAutosave() {
        Prefs.autosave = autosaveSwitch.state == .on
    }

    /// The Dock icon, and Cmd+Tab with it. Applied HERE and now rather than
    /// through `onChange`, which flushes the buffer and reloads the page: that
    /// would leave the user watching a switch they moved with nothing
    /// happening for a round trip. Nothing else needs re-reading for it.
    @objc private func toggleShowInDock() {
        Prefs.showInDock = dockSwitch.state == .on
        // Keeping this window, which is the whole difference between a switch
        // and a disappearing act: turning the Dock icon off sends the app to
        // the background, and the reader is looking at Settings when they do
        // it. `applyActivationPolicy` says how.
        AppDelegate.applyActivationPolicy(keepingFrontmost: true)
        showPresence()
    }

    /// The menu-bar icon. Applied here and now for the same reason the Dock
    /// icon is, and followed by `showPresence` for a reason the Dock switch
    /// did not have until today: turning one surface on or off decides whether
    /// the OTHER one may still be turned off.
    @objc private func toggleShowInMenuBar() {
        Prefs.showInMenuBar = menuBarSwitch.state == .on
        AppDelegate.shared?.applyMenuBarPresence()
        showPresence()
    }

    @objc private func toggleNetwork() {
        Prefs.networkEnabled = networkSwitch.state == .on
        onChange(nil)
    }

    /// Add or remove one publishing target.
    ///
    /// The whole set is read, edited and written back rather than each switch
    /// owning a key, because what is stored IS the set: four independent keys
    /// would have to agree on what "never opened this pane" means, and that
    /// answer (every target) belongs to `Prefs.syntaxSets` alone.
    ///
    /// The reload is what re-reads the boot config and re-places the toolbar,
    /// and it has to reach every window rather than the front one.
    @objc private func toggleSyntaxSet(_ sender: NSSwitch) {
        guard let set = syntaxSwitches.first(where: { $0.value === sender })?.key else { return }
        var sets = Prefs.syntaxSets
        if sender.state == .on { sets.insert(set) } else { sets.remove(set) }
        Prefs.syntaxSets = sets
        // EVERY window, not the front one, which is what `onChange` reaches.
        // The Format menu is the application's and repaints from `Prefs` on
        // every opening, so a back window left on the old target would offer
        // tools the menu bar above it had already withdrawn. `WindowSet`
        // explains it where the broadcast lives. The menu bar needs no
        // telling: it reads `Prefs` at the moment it opens.
        onChangeEverywhere()
    }
}

/// One settings row, holding the two views availability is drawn on.
///
/// A row is otherwise a stack of anonymous views, so a surface wanting to dim
/// one had to keep a reference to its label and its caption separately and
/// remember to move both. This keeps them together and gives the pairing one
/// implementation, which is the whole of what `RowAvailability` means on
/// screen: the label follows `isEnabled`, the sentence follows `tone`.
@MainActor
final class SettingsRowView: NSStackView {
    /// The row's name, dimmed when the row cannot be operated.
    let titleLabel: NSTextField
    /// The sentence under it, when it has one.
    let caption: Caption?

    init(label: NSTextField, caption: Caption?, arranged: [NSView]) {
        self.titleLabel = label
        self.caption = caption
        super.init(frame: .zero)
        for view in arranged { addArrangedSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Draw the row as `availability` says it stands.
    ///
    /// The label is the part worth insisting on. A disabled switch is dim on
    /// its own and easy to read as a switch that is simply off, so the NAME
    /// goes to the system's disabled ink too: the row reads as unavailable
    /// before anybody looks at the control.
    func apply(_ availability: RowAvailability) {
        titleLabel.textColor = availability.isEnabled ? .labelColor : .disabledControlTextColor
        caption?.say(availability.note, bad: availability.isProblem)
    }
}

/// A sentence under a row: secondary, wrapping, and occasionally an error.
final class Caption: NSTextField {
    init(_ text: String, wrapAt width: CGFloat = SettingsWindowController.Metrics.captionWidth) {
        super.init(frame: .zero)
        isEditable = false
        isBordered = false
        drawsBackground = false
        isSelectable = false
        lineBreakMode = .byWordWrapping
        maximumNumberOfLines = 0
        font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        preferredMaxLayoutWidth = width
        say(text, bad: false)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// A wrapping label needs to be told the width it wraps at; it is the
    /// width it has just been given.
    override func layout() {
        if abs(preferredMaxLayoutWidth - bounds.width) > 0.5 {
            preferredMaxLayoutWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
        super.layout()
    }

    /// An empty caption is HIDDEN, not blank: a row whose label says it all
    /// should be one line tall, and a zero-height label still contributes its
    /// spacing to the row above and below it.
    /// The view the row's stack is arranging, so hiding an empty caption takes
    /// its inset holder out of the layout too. Weak: the holder owns it.
    weak var holder: NSView?

    /// An empty caption is HIDDEN, not blank, and hiding it collapses the row
    /// because the row's vertical axis is a stack. Both this and the holder
    /// have to go, or the stack keeps arranging an empty box.
    ///
    /// Called directly only for a sentence that is always ordinary prose. A
    /// row whose sentence can turn RED goes through `SettingsRowView.apply`
    /// instead, so the ink and the row's own availability are decided by one
    /// `RowAvailability` rather than by two call sites that can disagree about
    /// whether something is wrong.
    func say(_ text: String, bad: Bool) {
        stringValue = text
        textColor = bad ? .systemRed : .secondaryLabelColor
        isHidden = text.isEmpty
        holder?.isHidden = isHidden
    }
}

/// A file path shown the way a settings row shows one: the name in full, the
/// directory truncated from the middle, and the whole path on hover.
final class PathLabel: NSTextField {
    init(_ url: URL?) {
        super.init(frame: .zero)
        isEditable = false
        isBordered = false
        drawsBackground = false
        isSelectable = false
        lineBreakMode = .byTruncatingMiddle
        alignment = .right
        font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setURL(url)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Not `isEnabled`, which NSControl already owns: this is only how the
    /// path reads when the setting above it is switched off.
    var isDimmed: Bool = false {
        didSet { textColor = isDimmed ? .tertiaryLabelColor : .secondaryLabelColor }
    }

    func setURL(_ url: URL?) {
        stringValue = url.map { $0.path.replacingOccurrences(of: NSHomeDirectory(), with: "~") } ?? "None chosen"
        toolTip = url?.path
        textColor = isDimmed ? .tertiaryLabelColor : .secondaryLabelColor
    }
}

/// A view that paints the window ground.
///
/// A plain NSView draws nothing, so the settings card's translucency would
/// composite over whatever happened to be behind the window. Painting it here
/// with a dynamic NSColor, in `draw` rather than a layer, is what keeps the
/// ground correct when the system flips between light and dark: a CGColor on a
/// layer is resolved once and then stale.
final class BackgroundView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
    }
}


/// A caption-sized link out to documentation we do not own.
///
/// The button OWNS its destination. The first version kept a shared dictionary
/// keyed by `ObjectIdentifier` instead, which is an address: a button that has
/// been deallocated leaves its entry behind, and the next allocation at that
/// address inherits somebody else's URL. Settings windows are built and closed
/// repeatedly by the tests, which is exactly the traffic that recycles one.
///
/// A real button rather than an attributed-string link, because this has to be
/// reachable from the keyboard and an `NSTextField` carrying a link is not in
/// the key view loop.
@MainActor
final class LinkButton: NSButton {
    /// Settable, because one of these follows the agent pull-down and has to
    /// point at whichever tool the command below it names. Still OWNED by the
    /// button rather than looked up from a table keyed on its address.
    private(set) var url: URL

    /// Point at somewhere else, title and destination together, so the two
    /// cannot be moved separately and disagree.
    func point(at url: URL, titled title: String) {
        self.url = url
        self.title = title
        toolTip = url.absoluteString
    }

    init(title: String, url: URL) {
        self.url = url
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .inline
        isBordered = false
        controlSize = .small
        contentTintColor = .linkColor
        font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        toolTip = url.absoluteString
        target = self
        action = #selector(open)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func open() { NSWorkspace.shared.open(url) }
}

// MARK: - The Appearance pane

extension SettingsWindowController {
    fileprivate func wireAppearanceControls() {
        followSwitch.target = self
        followSwitch.action = #selector(toggleFollowSystem)
        for strip in [lightStrip, darkStrip] {
            strip.onSelect = { [weak self] id, _ in
                guard let self, let kind = strip.kind else { return }
                self.apply(Prefs.appearance.setting(id, for: kind))
            }
        }
        // A pick in the held strip says which kind is held as well as which
        // theme: the card's own kind, which for a system card is the one it
        // is a picture of.
        heldStrip.onSelect = { [weak self] id, kind in
            self?.apply(Prefs.appearance.holding(id, kind: kind))
        }
        for strip in [lightStrip, darkStrip, heldStrip] {
            strip.onRemove = { [weak self] id in self?.removeTheme(id) }
        }
        accentRow.onSelect = { [weak self] hex in
            guard let self else { return }
            var settings = Prefs.appearance
            settings.accent = hex
            self.apply(settings)
        }
        tintRow.onSelect = { [weak self] hex in
            guard let self else { return }
            var settings = Prefs.appearance
            settings.tint = hex
            self.apply(settings)
        }
        sidebarSwitch.target = self
        sidebarSwitch.action = #selector(toggleTransparentSidebar)
        tocSidebarSwitch.target = self
        tocSidebarSwitch.action = #selector(toggleTransparentToc)
        formattingRowSwitch.target = self
        formattingRowSwitch.action = #selector(toggleFormattingRow)

        // Item 0 is the button's own title under `pullsDown`, as the agent
        // preset pull-down does it; the ways in start at 1.
        addThemeButton.pullsDown = true
        addThemeButton.controlSize = .small
        addThemeButton.removeAllItems()
        addThemeButton.addItems(withTitles: [ThemesMenu.addTitle, Self.addThemeFromFileTitle,
                                             Self.addThemeFromVSCodeTitle, Self.browseThemesTitle])
        addThemeButton.target = self
        addThemeButton.action = #selector(addTheme(_:))

        fontControl.controlSize = .small
        fontControl.target = self
        fontControl.action = #selector(chooseFont)
        fontSizeStepper.onStep = { [weak self] delta in self?.stepFontSize(delta) }
        fontSizeStepper.onReset = { [weak self] in self?.resetFontSize() }
        contentWidthControl.controlSize = .small
        contentWidthControl.target = self
        contentWidthControl.action = #selector(chooseContentWidth)
    }

    /// What the held strip is called. It has no drawn counterpart to read it
    /// off, which the two slot strips do: `labelled` takes ONE word and
    /// spends it on the heading and on the name, so those two cannot drift.
    static let themeStripName = "Theme"

    /// A strip under a heading: an icon and a word, then the cards. The word
    /// is the strip's accessibility name too, so what a screen reader is told
    /// and what is drawn cannot drift apart.
    private static func labelled(_ title: String, _ symbol: String, _ strip: ThemeStrip) -> NSView {
        strip.setAccessibilityLabel(title)
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .medium)
        label.textColor = .secondaryLabelColor
        let icon = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: title)
            ?? NSImage())
        icon.contentTintColor = .secondaryLabelColor
        icon.symbolConfiguration = .init(pointSize: NSFont.smallSystemFontSize, weight: .medium)
        let heading = NSStackView(views: [icon, label])
        heading.orientation = .horizontal
        heading.spacing = 4
        let column = NSStackView(views: [heading, strip])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 2
        strip.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        return column
    }

    /// The theme card's two shapes, one shown at a time (`refreshAppearance`).
    ///
    /// Following the system, a strip per mode, each under the mode it draws
    /// in; holding a mode, one strip of every theme, because then there is
    /// one answer to "what does it look like" and two rows would be asking
    /// it twice. Both are built and one is hidden rather than the card
    /// being rebuilt on each flip, so the pane keeps its scroll and the
    /// strips keep theirs.
    ///
    /// A heading names a strip only where there are two to tell apart. The
    /// held shape draws one strip directly under the sentence it answers, so
    /// a heading over it would name what nothing else could be. What the
    /// heading was still doing for a screen reader the strip does itself,
    /// which is why every strip is named whether or not one is drawn.
    private func themeCards() -> NSView {
        heldStrip.setAccessibilityLabel(Self.themeStripName)
        for (stack, views) in [(slotStrips, [Self.labelled("Light Theme", "sun.max", lightStrip),
                                              Self.labelled("Dark Theme", "moon", darkStrip)]),
                               (heldStrips, [heldStrip])] {
            stack.setViews(views, in: .top)
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 8
            for view in views { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        }
        let both = NSStackView(views: [slotStrips, heldStrips])
        both.orientation = .vertical
        both.alignment = .leading
        both.spacing = 0
        // Air under the pane's sentence. What `row` leaves between a row's
        // line and what is drawn below it is a field's gap, and too tight
        // under a sentence these cards are the answer to. On the stack rather
        // than on either shape, so the held shape keeps the air after
        // dropping its heading.
        both.edgeInsets = NSEdgeInsets(top: Metrics.themeStripAir, left: 0, bottom: 0, right: 0)
        both.translatesAutoresizingMaskIntoConstraints = false
        for view in both.arrangedSubviews { view.widthAnchor.constraint(equalTo: both.widthAnchor).isActive = true }
        return both
    }

    /// Store, apply everywhere, and redraw the pictures, which show the
    /// mod as well as the pick.
    private func apply(_ settings: AppearanceSettings) {
        onAppearanceChange(settings)
        refreshAppearance()
    }

    /// Re-read the library and the settings, and draw everything.
    ///
    /// From disk and from the defaults every time, because both change
    /// outside this window: View > Theme and the palette move the settings,
    /// and Add Theme… from the menu bar lands here with the list already
    /// longer. A pane that trusted what it last drew would show the theme
    /// that was chosen here, not the one in force.
    fileprivate func refreshAppearance() {
        themeRows = themeStore.list()
        let settings = Prefs.appearance
        followSwitch.state = settings.followsSystem ? .on : .off
        slotStrips.isHidden = !settings.followsSystem
        heldStrips.isHidden = settings.followsSystem
        lightStrip.show(themes: themeRows, selected: settings.lightTheme, settings: settings)
        darkStrip.show(themes: themeRows, selected: settings.darkTheme, settings: settings)
        // The held strip ticks the held kind's slot: its system card when
        // the slot is empty, which is why the pick carries a kind.
        let held = settings.mode.heldKind ?? settings.heldKind ?? (WindowSet.systemIsDark ? .dark : .light)
        heldStrip.show(themes: themeRows, selected: settings.themeId(for: held), heldKind: held, settings: settings)
        accentRow.select(settings.accent)
        tintRow.select(settings.tint)
        sidebarSwitch.state = settings.transparentSidebar ? .on : .off
        tocSidebarSwitch.state = settings.transparentToc ? .on : .off
        // Not part of `AppearanceSettings`: it is a defaults key of its own
        // (`Prefs.formattingRowExpanded`), read here because this is the
        // Appearance pane's own redraw and Reset comes through it.
        formattingRowSwitch.state = Prefs.formattingRowExpanded ? .on : .off
        fontControl.selectedSegment = Self.fontChoices.firstIndex { $0.preset == Prefs.fontPreset } ?? 1
        fontSizeStepper.show(percent: Prefs.fontSize)
        // Falling back to the first segment rather than to an index: full is
        // what the page resolves an unknown mode to (`normalizeContentWidthMode`),
        // and a number here would be a second place that decision is made.
        contentWidthControl.selectedSegment =
            Self.contentWidthChoices.firstIndex { $0.mode == Prefs.contentWidth } ?? 0
        // The card is a strip taller in one shape than the other, so the
        // window follows, as it follows the rows the other panes show and
        // hide (`fitWindowToPane`); a no-op while the pane is being built.
        fitWindowToPane()
    }

    // MARK: read back

    var themeChoicesForTesting: [String] { lightStrip.titlesForTesting }
    var darkThemeChoicesForTesting: [String] { darkStrip.titlesForTesting }
    var heldThemeChoicesForTesting: [String] { heldStrip.titlesForTesting }
    var heldThemeSelectionForTesting: String? { heldStrip.selectedTitleForTesting }
    var followsSystemForTesting: Bool { followSwitch.state == .on }
    /// Which of the card's two shapes is showing: "slots" or "held".
    var themeCardShapeForTesting: String { slotStrips.isHidden ? (heldStrips.isHidden ? "none" : "held") : "slots" }
    /// What a screen reader is told each strip of the shape now showing is
    /// called, and whether it is an element to be told about at all. The
    /// held shape draws no heading, so this is the whole of its name.
    var themeStripNamesForTesting: [(name: String?, isElement: Bool)] {
        guard themeCardShapeForTesting != "none" else { return [] }
        let strips: [ThemeStrip] = slotStrips.isHidden ? [heldStrip] : [lightStrip, darkStrip]
        return strips.map { ($0.accessibilityLabel(), $0.isAccessibilityElement()) }
    }
    /// The headings DRAWN over the strips in the shape now showing, so the
    /// shape that draws none can be seen to draw none. It descends no
    /// further than a strip, whose own labels are the cards' names.
    var themeStripHeadingsForTesting: [String] {
        func headings(in view: NSView) -> [String] {
            if view is ThemeStrip { return [] }
            if let field = view as? NSTextField { return [field.stringValue] }
            return view.subviews.flatMap(headings)
        }
        guard themeCardShapeForTesting != "none" else { return [] }
        return headings(in: slotStrips.isHidden ? heldStrips : slotStrips)
    }
    /// Per strip in the shape now showing: the card the kind divider is drawn
    /// before, and how many dividers are actually in the row. The count is
    /// what stops the title reporting on a divider that was decided and never
    /// added, and on one an earlier pass left behind.
    var themeDividersForTesting: [(titleAfter: String?, drawn: Int)] {
        guard themeCardShapeForTesting != "none" else { return [] }
        let strips: [ThemeStrip] = slotStrips.isHidden ? [heldStrip] : [lightStrip, darkStrip]
        return strips.map { ($0.titleAfterDividerForTesting, $0.dividersDrawnForTesting) }
    }
    func setFollowSystemForTesting(_ on: Bool) {
        followSwitch.state = on ? .on : .off
        toggleFollowSystem()
    }
    func chooseHeldThemeForTesting(_ id: String?, kind: VSCodeTheme.Kind) {
        apply(Prefs.appearance.holding(id, kind: kind))
    }
    var accentChoicesForTesting: [String] { accentRow.titlesForTesting }
    var themeLibraryForTesting: [ThemeSummary] { themeRows }
    var fontSizeForTesting: String { fontSizeStepper.percentForTesting }
    /// The segment the pane is drawing as chosen, by its own label, so a check
    /// reads the word somebody would click rather than an index.
    var contentWidthForTesting: String? {
        let index = contentWidthControl.selectedSegment
        guard index >= 0 else { return nil }
        return contentWidthControl.label(forSegment: index)
    }
    /// Pick a segment as a click would, through the same action, so what is
    /// under test is the control's own path to `Prefs` and the command.
    func chooseContentWidthForTesting(_ title: String) {
        guard let index = Self.contentWidthChoices.firstIndex(where: { $0.title == title }) else { return }
        contentWidthControl.selectedSegment = index
        contentWidthControl.performClick(nil)
    }
    func chooseThemeForTesting(_ id: String?, for kind: VSCodeTheme.Kind) {
        apply(Prefs.appearance.setting(id, for: kind))
    }
    func chooseModeForTesting(_ mode: AppearanceMode) {
        apply(Prefs.appearance.inMode(mode))
    }
    func chooseAccentForTesting(_ hex: String?) {
        var settings = Prefs.appearance
        settings.accent = hex
        apply(settings)
    }
    func removeThemeForTesting(_ id: String) { removeTheme(id) }
    func stepFontSizeForTesting(_ delta: Int) { stepFontSize(delta) }

    // MARK: actions

    @objc private func toggleFollowSystem() {
        apply(Prefs.appearance.followingSystem(followSwitch.state == .on, systemIsDark: WindowSet.systemIsDark))
    }

    @objc private func toggleTransparentSidebar() {
        var settings = Prefs.appearance
        settings.transparentSidebar = sidebarSwitch.state == .on
        apply(settings)
    }

    /// The row is the app's, not this window's: the store and every open page
    /// move together, so a second window does not go on showing the answer
    /// this one just changed.
    @objc private func toggleFormattingRow() {
        onFormattingRowChange(formattingRowSwitch.state == .on)
    }

    @objc private func toggleTransparentToc() {
        var settings = Prefs.appearance
        settings.transparentToc = tocSidebarSwitch.state == .on
        apply(settings)
    }

    @objc private func chooseFont() {
        let index = fontControl.selectedSegment
        guard index >= 0, index < Self.fontChoices.count else { return }
        let choice = Self.fontChoices[index]
        // Written here as well as posted back by each page, so a window
        // opened before the round trip lands boots with the new answer.
        Prefs.fontPreset = choice.preset
        onEditorCommand(choice.command)
    }

    /// Full or Fixed, for every window at once.
    ///
    /// Written here as well as posted back by each page, for the reason the
    /// font row is: a window opened before the round trip lands has to boot
    /// with the answer that was just given, and the page's echo is what keeps
    /// the two in step afterwards.
    @objc private func chooseContentWidth() {
        let index = contentWidthControl.selectedSegment
        guard index >= 0, index < Self.contentWidthChoices.count else { return }
        let choice = Self.contentWidthChoices[index]
        Prefs.contentWidth = choice.mode
        onEditorCommand(choice.command)
    }

    private func stepFontSize(_ delta: Int) {
        let next = min(FontSizeStepper.maximum, max(FontSizeStepper.minimum, Prefs.fontSize + delta))
        guard next != Prefs.fontSize else { return }
        Prefs.fontSize = next
        onEditorCommand(delta > 0 ? "increaseFontSize" : "decreaseFontSize")
        fontSizeStepper.show(percent: next)
    }

    private func resetFontSize() {
        Prefs.fontSize = Prefs.defaultFontSize
        onEditorCommand("resetFontSize")
        fontSizeStepper.show(percent: Prefs.fontSize)
    }

    @objc private func addTheme(_ sender: NSPopUpButton) {
        switch sender.indexOfSelectedItem {
        case 1: chooseThemeFiles()
        case 2: importInstalledThemes()
        case 3: browseThemes()
        default: break
        }
    }

    private func chooseThemeFiles() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.message = "Choose a VS Code color theme: a theme .json file, a theme extension's folder, or a .vsix."
        panel.allowedContentTypes = [UTType.json, UTType.zip, UTType.folder]
            + [UTType(filenameExtension: "vsix")].compactMap { $0 }
        // Where VS Code keeps its extensions, when it has any: the folder a
        // theme somebody already uses is in.
        if let extensions = ThemeStore.installedExtensionRoots(
            home: FileManager.default.homeDirectoryForCurrentUser).first {
            panel.directoryURL = extensions
        }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self else { return }
            var added: [ThemeSummary] = []
            var failures: [String] = []
            for url in panel.urls {
                do { added += try self.themeStore.importThemes(from: url) }
                catch { failures.append("\(url.lastPathComponent): \(error.localizedDescription)") }
            }
            self.themesChanged(added: added, failures: failures)
        }
    }

    /// Every theme every extension installed in VS Code (or Cursor, or a
    /// sibling) contributes, and every theme those editors ship with, as a
    /// list to pick from (`InstalledThemesPick`). The picks are added one
    /// by one rather than as a batch, so one theme file the app cannot read
    /// does not stop the rest.
    private func importInstalledThemes() {
        guard let window else { return }
        let roots = ThemeStore.installedExtensionRoots(home: FileManager.default.homeDirectoryForCurrentUser)
        let found = ThemeStore.themesInExtensions(roots: roots)
        guard !found.isEmpty else {
            let alert = NSAlert()
            alert.messageText = "No VS Code themes found"
            alert.informativeText = roots.isEmpty
                ? "VS Code does not seem to be installed for this user, so there are no themes to read."
                : "Nothing installed contributes a color theme."
            alert.beginSheetModal(for: window)
            return
        }
        presentInstalledThemesPicker(found)
    }

    /// The picker over `sources`; what it picks is added when the sheet
    /// closes, which is also when the controller is let go.
    @discardableResult
    private func presentInstalledThemesPicker(_ sources: [ThemeSource]) -> InstalledThemesSheetController? {
        guard let window else { return nil }
        let picker = InstalledThemesSheetController(
            pick: InstalledThemesPick(sources: sources, held: themeStore.list().map(\.id))
        ) { [weak self] chosen in
            guard let self else { return }
            self.installedThemesSheet = nil
            guard !chosen.isEmpty else { return }
            var added: [ThemeSummary] = []
            var failures: [String] = []
            for source in chosen {
                do { added += try self.themeStore.importThemes([source]) }
                catch { failures.append("\(source.label ?? source.url.lastPathComponent): \(error.localizedDescription)") }
            }
            self.themesChanged(added: added, failures: failures)
        }
        installedThemesSheet = picker
        picker.present(over: window)
        return picker
    }

    /// Open the picker over a list this test controls, and hand back the
    /// controller if its controls reach it; the caller drives it from there.
    func pickInstalledThemesForTesting(_ sources: [ThemeSource]) -> InstalledThemesSheetController? {
        guard let picker = presentInstalledThemesPicker(sources), picker.isWiredForTesting else { return nil }
        return picker
    }

    /// The registry browser, as a sheet; what it adds comes back here when
    /// the sheet closes, which is also when the controller is let go.
    private func browseThemes(fetch: ((URL) async throws -> (Data, URLResponse))? = nil) {
        guard let window else { return }
        let browser = ThemeBrowserController(store: themeStore) { [weak self] added, failures in
            self?.themeBrowser = nil
            self?.themesChanged(added: added, failures: failures)
        }
        if let fetch { browser.fetch = fetch }
        themeBrowser = browser
        browser.present(over: window)
    }

    /// Open the browser over `fetch` in place of the registry, and hand it
    /// back if its controls still reach it, which is the whole of what
    /// holding it is for. The seam is what keeps a test off the network:
    /// the sheet asks for its first page as it opens.
    func browseThemesForTesting(fetch: @escaping (URL) async throws -> (Data, URLResponse)) -> ThemeBrowserController? {
        browseThemes(fetch: fetch)
        guard let themeBrowser, themeBrowser.isWiredForTesting else { return nil }
        return themeBrowser
    }

    func dismissThemeBrowserForTesting() { themeBrowser?.dismissForTesting() }

    /// The library changed: tell the app, since the theme in force may have
    /// been replaced or removed; put a single new theme in the slot of the
    /// mode in force, as a pick from the menu does, because one theme added
    /// is a theme somebody wants to see now, where a batch is a library
    /// being filled and picking from it for them would be a guess; and say
    /// what could not be added.
    private func themesChanged(added: [ThemeSummary], failures: [String]) {
        onThemesChanged()
        if added.count == 1, let theme = added.first {
            let settings = Prefs.appearance
            apply(settings.setting(theme.id, for: settings.effectiveKind(systemIsDark: WindowSet.systemIsDark)))
        } else {
            refreshAppearance()
        }
        guard !failures.isEmpty, let window else { return }
        let alert = NSAlert()
        alert.messageText = added.isEmpty ? "The theme could not be added" : "Some themes could not be added"
        alert.informativeText = failures.joined(separator: "\n")
        alert.beginSheetModal(for: window)
    }

    /// Remove a theme from the library. No confirmation: the file here is
    /// the app's copy, and the extension or file it came from is untouched,
    /// so adding it again is the undo. A slot naming it reads as the
    /// system's once it is gone (`Appearance.resolve`), and the settings
    /// are cleaned of it so the pane does not remember a card that is not
    /// there.
    private func removeTheme(_ id: String) {
        do {
            try themeStore.remove(id: id)
        } catch {
            NSLog("Birta Writer: could not remove theme: \(error)")
        }
        var settings = Prefs.appearance
        if settings.lightTheme == id { settings.lightTheme = nil }
        if settings.darkTheme == id { settings.darkTheme = nil }
        onAppearanceChange(settings)
        themesChanged(added: [], failures: [])
    }
}

extension SettingsWindowController {
    /// The window's content as a PNG, for `BIRTA_MAC_SETTINGS_SNAPSHOT`: the
    /// same instrument as `PaletteWindow.snapshotPNG`, for the same reason.
    func snapshotPNG() -> Data? {
        guard let content = window?.contentView else { return nil }
        content.layoutSubtreeIfNeeded()
        let bounds = content.bounds
        let pdf = content.dataWithPDF(inside: bounds)
        guard let image = NSImage(data: pdf) else { return nil }
        let rendered = NSImage(size: bounds.size)
        rendered.lockFocus()
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        image.draw(in: bounds)
        rendered.unlockFocus()
        guard let tiff = rendered.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}
