import AppKit

/// The app's own mark, as the system composites it.
///
/// `NSApp.applicationIconImage` rather than the artwork in `Resources`, which
/// is the opposite of the choice the first-run screen makes and for the
/// opposite reason: that screen sits the mark on its own paper, where a border
/// and a drop shadow are chrome around a join that should be invisible. Every
/// reader here puts the mark on a window's ground exactly as it sits in the
/// Dock, which is where its shadow belongs.
///
/// Shared rather than private to the About window, because an alert that names
/// this app has the same question to answer and must not answer it differently.
/// `NSAlert` fills its own icon in from the running application, and for an
/// accessory app that answer arrives blank: the sheet then draws a title and a
/// button with nothing saying whose they are, which is exactly the sheet an
/// update offer must not be, since it is asking to replace the application.
///
/// The named fallback is for a process with no bundle, every test host among
/// them, and is the generic application icon rather than nothing.
@MainActor
enum AppIcon {
    static var image: NSImage {
        NSApp.applicationIconImage
            ?? NSImage(named: NSImage.applicationIconName)
            ?? NSImage(size: NSSize(width: 128, height: 128))
    }
}
