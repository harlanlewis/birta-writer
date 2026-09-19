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
/// `NSAlert` keeps an icon view and fills it from the running application, and
/// as a SHEET it hides that view, because a sheet is already attached to the
/// window whose app it would be naming. So a sheet draws a title and a button
/// with nothing saying whose they are, which is exactly what an update offer
/// must not be, since it is asking to replace the application. Set explicitly,
/// the mark is drawn; `UpdateSheetMarkTests` is where that is measured rather
/// than reasoned about.
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
