import Foundation

/// Which channel delivered this build of Birta Writer, so the copy the Mac
/// App Store installs and the copy downloaded from the project can be one
/// program with the four differences the store's sandbox forces.
///
/// The App Store build runs inside the App Sandbox, and the sandbox is what
/// takes each of these away rather than a decision made here:
///
///   - `/ai`, because it hands a prompt to a command on the user's own PATH,
///     and a sandboxed process cannot run one with the access that command
///     needs,
///   - the terminal command, because `bwr` is a symlink the app writes into
///     `~/.local/bin`, outside the container, pointing at a binary that then
///     runs outside the sandbox,
///   - updating itself, because a sandboxed app cannot replace the bundle it
///     is running out of, and the store's own updater is the one that may,
///   - reading the themes an installed VS Code holds, because `~/.vscode` and
///     the editor's own bundle are outside the container. Choosing a theme
///     file through the open panel and browsing Open VSX both survive: the
///     first is user-selected access and the second is the network.
///
/// Read from the sandbox at runtime rather than set by a compile flag, for
/// the reason `AppFlavor` reads the bundle id: the sandbox is what forbids
/// each of the four, so deriving the answers from it means the distribution
/// and its consequences cannot disagree. A flag can, and a flag that said
/// "direct" on a sandboxed build would offer four things that then fail.
/// macOS puts the container id in the environment of every sandboxed
/// process, which is also how `NSHomeDirectory()` learns where home moved to.
///
/// What a channel takes away is LEFT OUT, never drawn disabled: the rows go
/// (`offers`, `offered`), a pane emptied by that goes with them, and so do
/// Check for Updates and the installed-editor theme entry. A disabled control
/// with a sentence under it reads as a setting the person has not reached
/// yet, and on this channel there is nothing to reach.
///
/// This is a fourth axis beside three that exist, and it is worth saying
/// which it is not. The host profile (`shared/hostProfile.ts`) says what the
/// SURFACE is; `AppFlavor` says which INSTALL this is; a `Prefs` row says
/// what the person CHOSE. A distribution says what the channel's rules take
/// away, and it reaches the page only through the profile's own filter:
/// `/ai` is the `agent` capability, which `Prefs.bootConfig` already
/// withdraws when this host provides no agent, and under the store it never
/// does. So the page has no profile for the store and needs none;
/// `Preferences.agentAvailable` is where the two meet.
public enum Distribution: String, CaseIterable, Sendable {
    /// Downloaded from the project: the GitHub Release, `update.sh`, a local
    /// build. Not sandboxed, and able to do everything the app does.
    case direct
    /// Installed by the Mac App Store, inside the App Sandbox.
    case appStore

    /// The variable macOS sets in a sandboxed process's environment. Held as
    /// a constant so `shared/__tests__/distribution.test.ts` can check the
    /// spelling: a typo here is a store build that never learns it is one,
    /// and offers four things the sandbox then refuses.
    public static let sandboxContainerVariable = "APP_SANDBOX_CONTAINER_ID"

    /// Whether `environment` is a sandboxed process's. Presence is the test
    /// and not the value: the value is the container's id, which nothing
    /// here needs.
    public static func isSandboxed(_ environment: [String: String]) -> Bool {
        environment[sandboxContainerVariable] != nil
    }

    /// The distribution a sandbox answer names.
    public static func forSandbox(_ sandboxed: Bool) -> Distribution {
        sandboxed ? .appStore : .direct
    }

    /// This process's distribution.
    public static let current = forSandbox(isSandboxed(ProcessInfo.processInfo.environment))

    /// Whether `/ai` can be offered at all. Composed into
    /// `AgentAvailability.isAvailable` beside the switch and the command, so
    /// the row and the capability keep agreeing.
    public var offersAgent: Bool { self == .direct }

    /// Whether Settings may put `bwr` on the PATH.
    public var offersTerminalCommand: Bool { self == .direct }

    /// Whether this channel lets a build replace itself. Read alone only to
    /// decide whether updating is OFFERED at all (the update row, Check for
    /// Updates): a development build still offers the check and answers it.
    /// Whether a build actually replaces itself needs its flavour too, and
    /// `updatesItself(flavour:)` is the one place that conjunction is written.
    public var updatesItself: Bool { self == .direct }

    /// Whether Settings offers the themes an installed VS Code holds.
    public var readsInstalledEditorThemes: Bool { self == .direct }

    /// Whether this channel offers a Settings row at all.
    ///
    /// A row the channel takes away is OMITTED rather than drawn dead: a
    /// switch that cannot move, under a sentence about a download, is a
    /// setting for a thing this copy will never have. Every surface that
    /// draws rows (Settings, the first-run screen, the palette) filters
    /// through here once, so a cut is one line in this switch.
    public func offers(_ row: SettingsRow) -> Bool {
        switch row {
        case .agentEnabled, .agentCommand: return offersAgent
        case .commandLine, .commandName: return offersTerminalCommand
        case .autoUpdate: return updatesItself
        default: return true
        }
    }

    /// `pane` as this channel draws it: the rows it does not offer left out,
    /// and a card left with none dropped rather than drawn empty. A pane with
    /// no cards left is a tab this channel does not show.
    public func offered(_ pane: SettingsPane) -> SettingsPane {
        SettingsPane(intro: pane.intro,
                     groups: pane.groups
                         .map { SettingsGroup(rows: $0.rows.filter(offers)) }
                         .filter { !$0.rows.isEmpty })
    }

    /// The first-run screen's cards as this channel draws them.
    public func offered(_ groups: [WelcomeGroup]) -> [WelcomeGroup] {
        groups.map { WelcomeGroup(rows: $0.rows.filter { offers($0.settingsRow) }) }
            .filter { !$0.rows.isEmpty }
    }

    /// Whether a build of this flavour on this channel replaces itself.
    ///
    /// The one resolver, so the two reasons a build does not (a development
    /// copy would overwrite the change it was built to show; a store copy is
    /// the store's to update) are never consulted apart. The app's two gates,
    /// `Updater.Environment.mayCheck` and the asked-for check's answer, read
    /// this and neither operand; `shared/__tests__/distribution.test.ts`
    /// holds them to it.
    public func updatesItself(flavour: AppFlavor) -> Bool {
        updatesItself && flavour.updatesItself
    }
}
