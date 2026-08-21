import Foundation

/// Which build of Birta Writer this is, so a development copy and the one
/// somebody actually uses can sit in /Applications together.
///
/// The point is a reviewable build that costs the release nothing. Installing
/// a development build over the release replaces the app somebody is in the
/// middle of using, and the old handoff did exactly that: the only way to look
/// at a change was to overwrite the copy holding your notes.
///
/// Four things have to be separate or the two copies fight, and every one of
/// them has actually got apps into trouble:
///
///   - the bundle id, because it names the defaults domain, so without it the
///     two share a hotkey setting, a note location and an agent command,
///   - the note itself, because two apps autosaving one file is two writers
///     racing over somebody's writing,
///   - the hotkey, because a global one is first come first served: the second
///     app to launch simply fails to register and is reachable only from the
///     menu bar,
///   - self-update, because a development build that replaced itself with the
///     newest release would delete the thing under review.
///
/// Read from the bundle id at runtime rather than set by a compile flag. The
/// id is what macOS keys the defaults domain on, so deriving everything else
/// from it means the flavour and the domain cannot disagree; a flag can.
public enum AppFlavor: String, CaseIterable, Sendable {
    case release
    case dev

    /// NOT `com.birtalabs.jot.dev`, and the dot is the whole reason.
    ///
    /// Every domain strictly under `com.birtalabs.jot.` is a throwaway that
    /// `jot/scripts/reap.sh` clears, which is what keeps a checking run from
    /// leaving scratch settings on the machine. A development build parked
    /// under that prefix would have its settings deleted at the end of every
    /// session. `AppFlavorTests` holds this apart.
    public static let devBundleID = "com.birtalabs.jotdev"
    public static let releaseBundleID = "com.birtalabs.jot"

    /// The flavour a bundle id names.
    ///
    /// Anything that is not the development id is the release, because the
    /// release id is the only one that ships. It is NOT the cautious branch,
    /// and saying so would be worse than saying nothing: release is the
    /// flavour that opens the user's note, claims the release hotkey and
    /// replaces itself. A build stamped with an id this does not recognise
    /// therefore behaves as the release, which is why the ids are held across
    /// Swift and the build script by `shared/__tests__/appFlavor.test.ts`.
    public static func forBundle(_ identifier: String?) -> AppFlavor {
        identifier == devBundleID ? .dev : .release
    }

    /// This process's flavour.
    public static let current = forBundle(Bundle.main.bundleIdentifier)

    public var bundleID: String {
        switch self {
        case .release: return Self.releaseBundleID
        case .dev: return Self.devBundleID
        }
    }

    /// What the app calls itself: its menus, its About panel, its window when
    /// it has no file to name.
    public var displayName: String {
        ScratchpadLocation.productName + nameSuffix
    }

    /// Appended to the app's name, its note's name, and the folder holding
    /// that note in iCloud Drive, so the two builds never collide.
    ///
    /// Bracketed and shouted, because it is a WARNING rather than a variant
    /// name: everything it is attached to looks like the real thing, and the
    /// point of the suffix is that somebody glancing at a menu bar, a window
    /// title or a file in Finder can tell at once which they are looking at.
    ///
    /// Empty for the release, which is what keeps every existing install
    /// exactly where it was.
    public var nameSuffix: String {
        switch self {
        case .release: return ""
        case .dev: return " [DEV]"
        }
    }

    /// The summon combination a fresh install starts with.
    ///
    /// Different per flavour because a global hotkey is first come first
    /// served: two apps asking for the same one means the second to launch
    /// does not get it, and the only sign is a caption in Settings nobody has
    /// opened. Shift is what the development build adds, so the two are
    /// related enough to remember and never the same.
    public var defaultHotkey: HotkeyCombo {
        switch self {
        case .release: return .release
        case .dev: return .dev
        }
    }

    /// Whether Settings offers to see the first-run screen again.
    ///
    /// Development only, and the reason is this app's own invariant rather
    /// than caution about a button: every question the first run asks is a row
    /// on the General pane, in the same words and the same order
    /// (`SettingsForm`). So for somebody using Jot the screen is a second,
    /// slower route to settings they can already see, and its one real use is
    /// looking at the screen itself, which is what a development build is for.
    public var showsWelcomeScreen: Bool { self == .dev }

    /// Whether this build may replace itself with a newer one.
    ///
    /// False for a development build, and not as a precaution: replacing it
    /// would overwrite the change somebody built it to look at with whatever
    /// the newest release happens to be.
    public var updatesItself: Bool { self == .release }
}
