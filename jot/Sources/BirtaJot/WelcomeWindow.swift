import AppKit
import BirtaJotCore

/// The four questions Jot asks the first time it runs.
///
/// Without it, first launch is silent and every decision about what kind of
/// application this is has already been made by a default nobody saw: whether
/// the note is in iCloud Drive, whether bytes reach disk on their own, whether
/// there is a Dock icon at all, and whether it is here again tomorrow. Each is
/// findable in Settings and none of them is found. The one that bites hardest
/// is where the note is, because somebody who types into a scratchpad for a
/// week and then wants the file has nowhere to look, and the answer differs by
/// machine.
///
/// A small window with a few switches, not a tour and not a wizard. Every row
/// is already set to the answer Jot would have chosen anyway, so approving is
/// the fast path and changing one is a switch away.
///
/// There is no Cancel, and that is not an omission: every row is a LIVE
/// setting, written the moment it moves, so there is nothing to roll back and
/// a button offering to would be lying. Dismissing the window is consent to
/// what it shows.
///
/// It composes `SettingsWindowController`'s own row, group and caption pieces
/// rather than growing a second visual language for the same four controls.
@MainActor
final class WelcomeWindowController: NSWindowController, NSWindowDelegate {
    private let dockSwitch = NSSwitch()
    private let loginSwitch = NSSwitch()
    private let autosaveSwitch = NSSwitch()
    private let iCloudSwitch = NSSwitch()
    private let iCloudCaption = Caption("")
    private let locationPath = PathLabel(Prefs.scratchpadURL)
    private let loginCaption = Caption(LoginItemState.off.caption)

    /// Reload the panel against whatever the window changed. The file location
    /// is one of these four, so dismissing can leave Jot bound elsewhere.
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0,
                                width: SettingsWindowController.Metrics.content
                                    + SettingsWindowController.Metrics.windowPadding * 2,
                                height: 320),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Welcome to Birta Writer Jot"
        super.init(window: window)
        window.delegate = self
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        guard let window else { return }
        for (control, on, action) in [
            (iCloudSwitch, Prefs.storeInICloud && Prefs.iCloudAvailable, #selector(toggleICloud)),
            (autosaveSwitch, Prefs.autosave, #selector(toggleAutosave)),
            (dockSwitch, Prefs.showInDock, #selector(toggleDock)),
            (loginSwitch, false, #selector(toggleLogin)),
        ] {
            control.controlSize = .small
            control.state = on ? .on : .off
            control.target = self
            control.action = action
        }

        let pane = SettingsWindowController.pane([
            SettingsWindowController.heading("Where your notes go"),
            SettingsWindowController.group([
                SettingsWindowController.row("Store files in iCloud Drive",
                                             control: iCloudSwitch, caption: iCloudCaption),
                SettingsWindowController.row("Location",
                                             control: SettingsWindowController.pathControl(
                                                locationPath, self, #selector(chooseLocation))),
            ]),
            SettingsWindowController.heading("How Jot behaves"),
            SettingsWindowController.group([
                SettingsWindowController.row("Autosave", control: autosaveSwitch,
                                             caption: Caption("Write as you type. Cmd+S works either way.")),
                SettingsWindowController.row("Show in Dock", control: dockSwitch,
                                             caption: Caption("Off keeps Jot in the menu bar only, out of Cmd+Tab.")),
                SettingsWindowController.row("Launch at login", control: loginSwitch, caption: loginCaption),
            ]),
        ])
        pane.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(pane)
        NSLayoutConstraint.activate([
            pane.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            pane.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            pane.topAnchor.constraint(equalTo: content.topAnchor),
            pane.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        window.contentView = content
        window.setContentSize(content.fittingSize)
        window.center()
        showLoginItem(LoginItem.state)
        showLocation()
    }

    private func showLocation() {
        locationPath.setURL(Prefs.scratchpadURL)
        iCloudSwitch.isEnabled = Prefs.iCloudAvailable && !Prefs.hasExplicitScratchpadPath
        if Prefs.hasExplicitScratchpadPath {
            iCloudCaption.say("You chose the location below, so this has no effect.", bad: false)
        } else if !Prefs.iCloudAvailable {
            iCloudCaption.say("iCloud Drive is off in System Settings, so notes stay on this Mac.", bad: false)
        } else {
            iCloudCaption.say("", bad: false)
        }
    }

    private func showLoginItem(_ state: LoginItemState) {
        loginSwitch.state = state == .on ? .on : .off
        loginCaption.say(state.caption, bad: state == .blocked)
    }

    @objc private func toggleICloud() {
        Prefs.storeInICloud = iCloudSwitch.state == .on
        showLocation()
        onChange()
    }

    @objc private func toggleAutosave() {
        Prefs.autosave = autosaveSwitch.state == .on
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
            // Put the switch back where the system still has it and say so,
            // the way the Settings row does. A switch left where it was pushed
            // claims a registration that does not exist.
            showLoginItem(LoginItem.state)
            loginCaption.say("macOS refused: \(error.localizedDescription)", bad: true)
        }
    }

    @objc private func chooseLocation() {
        guard let window else { return }
        let panel = NSSavePanel()
        panel.title = "Where your notes go"
        panel.nameFieldStringValue = Prefs.scratchpadURL.lastPathComponent
        panel.directoryURL = Prefs.scratchpadURL.deletingLastPathComponent()
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url, let self else { return }
            Prefs.scratchpadURL = url
            self.showLocation()
            self.onChange()
        }
    }

    /// Marked seen on CLOSE, never on show. A crash during a first launch
    /// would otherwise spend the one chance to ask these questions.
    func windowWillClose(_ notification: Notification) {
        Prefs.hasSeenWelcome = true
    }
}
