import Foundation

/// WHICH Space a window belongs to, decided from whether the app has a Dock
/// icon.
///
/// There are two honest answers and the Dock setting is what picks between
/// them, because that setting is already the reader saying which kind of
/// program this is.
///
/// An app WITH a Dock icon is a normal app. Its window is reached by clicking
/// that icon, by Cmd+Tab, or from the Window menu, and every one of those
/// routes is one macOS answers by switching to the Space the window is on. A
/// window that instead came to the reader would be the odd one out among every
/// other window on the machine, and nothing about this app earns that.
///
/// An app WITHOUT one is reached by its hotkey and its menu-bar icon, both of
/// which are pressed from inside whatever the reader is doing. Sending them to
/// another Space to write one line, and leaving them there, is not what the
/// chord was pressed for: the window is what should move. So it does.
///
/// ## What neither answer contains
///
/// Not drawn on every Space at once, and not drawn over another application's
/// full screen. Both of those were on this window and the second was the
/// defect: a note left open sat on top of whatever anybody went full screen
/// into, with nothing in Settings to say so or turn it off. `followsReader` is
/// the near neighbour of the first and is not the same thing, which is the
/// distinction worth holding on to: the window is in ONE place at a time and
/// merely moves, so it can be covered, it can be left behind, and going full
/// screen in another app puts that app in front of it the way it would any
/// other window.
///
/// A window this app shows also takes a full screen of its OWN, in both
/// answers, which is why nothing here is a case about it.
///
/// ## The AppKit half
///
/// Decidable from a value, so it is checkable with no AppKit and no defaults
/// domain. `AppPanel.collectionBehavior(for:)` is the adapter that puts this
/// answer in AppKit's vocabulary, and `PanelWindowPolicyTests` reads the flags
/// back off a built window, which is where the two never-facts above are
/// actually held: they are absences, and an absence is invisible to any check
/// written over the enum alone.
public enum WindowPolicy {
    /// The Space a window lives on.
    ///
    /// `CaseIterable` so a sweep over the answers is derived from the type
    /// rather than from a pair written out by hand, and so a sweep that
    /// reached nothing cannot pass for one that reached everything.
    public enum SpaceMembership: String, CaseIterable, Sendable {
        /// One Space, the one the window was opened on, the way a document
        /// window does it. Reaching it from elsewhere switches to it.
        case ownSpace
        /// The window moves to whichever Space is active when the app is
        /// activated, so the hotkey reaches it without taking the reader
        /// anywhere.
        case followsReader
    }

    /// Which one, for an app that shows a Dock icon or does not.
    public static func membership(showInDock: Bool) -> SpaceMembership {
        showInDock ? .ownSpace : .followsReader
    }
}
