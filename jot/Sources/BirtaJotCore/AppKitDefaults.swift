import Foundation

/// The AppKit behaviours this app turns off, as defaults registered before
/// `NSApplication` exists.
///
/// This is the only lever there is for one of them, and it is worth saying why
/// rather than leaving a bare key in `Entry`. A menu bar is drawn by the
/// system, not by the app: the rows macOS adds to a menu titled View arrive
/// out of process and are never in the `NSMenu` the app built, so they cannot
/// be removed by editing it, cannot be seen by a delegate's
/// `menuNeedsUpdate`, and cannot be read back by any check that walks
/// `NSMenu.items`. A probe that builds a View menu, activates, opens it and
/// re-reads it finds exactly the rows it authored, while the accessibility
/// tree of the same process shows Enter Full Screen sitting under them.
///
/// `NSFullScreenMenuItemEverywhere` is what decides whether that row is added
/// for an app with no window that can take full screen. Every window this app
/// puts on screen is either a `JotPanel`, which is `.fullScreenAuxiliary` so
/// it accompanies another window's full screen rather than entering one, or
/// the Settings and About windows, which are not resizable. So the row was
/// there and permanently dimmed, which is the one thing a menu row must never
/// be: a promise the app does not keep. Turning the key off removes it.
///
/// Registered rather than written: the registration domain is consulted only
/// while this process lives, so an app that stops wanting this stops having
/// it, and nothing of ours ends up in the reader's stored settings. It has to
/// be registered before `NSApplication.shared` is first touched, because that
/// is when AppKit reads it; registering from
/// `applicationDidFinishLaunching` is too late and changes nothing, which is
/// the failure mode this note exists to stop somebody rediscovering.
///
/// To see it: `bash jot/scripts/menu-bar.sh`, which reads the running app's
/// real menu bar through the accessibility API. Nothing in `jot/Tests` can,
/// for the reason in the first paragraph.
public enum AppKitDefaults {
    /// The keys and the values, so a check has something to read.
    public static let values: [String: Any] = [
        "NSFullScreenMenuItemEverywhere": false,
    ]

    /// Put them in the registration domain. Call before `NSApplication.shared`.
    public static func register(in defaults: UserDefaults = .standard) {
        defaults.register(defaults: values)
    }
}
