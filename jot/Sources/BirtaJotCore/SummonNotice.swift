import Foundation

/// What Birta Writer says when the summon hotkey is refused, and what it says
/// when a replacement is taken.
///
/// Its own type, and in Core, because both sentences are decidable from values:
/// a combination and the app's name. The window code is left with drawing, and
/// `SummonNoticeTests` can hold the two things the sentences must do without a
/// menu bar to hang them from.
///
/// A global hotkey is first come first served, and the app that loses is
/// `LSUIElement`: no Dock icon, no window, nothing on screen. So the refusal
/// has two jobs and the second is the one that was missing. It has to name the
/// combination, because the person needs to know WHICH key they are pressing
/// in vain. And it has to name the way in that still works, because otherwise
/// the app is indistinguishable from an app that does not run, and the menu
/// bar icon is not somewhere a person looks for a fallback they were never
/// told about.
///
/// The escape hatch is named rather than described: the notice is drawn hanging
/// off that icon, so saying "the menu bar icon" points at something the reader
/// can already see.
public struct SummonNotice: Equatable, Sendable {
    /// The heading, which names the combination in both directions.
    public let title: String
    /// The sentences under it.
    public let detail: String

    public init(title: String, detail: String) {
        self.title = title
        self.detail = detail
    }

    /// macOS would not give us `combo`.
    ///
    /// The first sentence is the mechanism, and it earns its place: without it
    /// a refusal reads as a bug in this app rather than as a combination that
    /// is spoken for, and the reader has no reason to think pressing a
    /// different one would go any better.
    public static func refused(_ combo: HotkeyCombo, appName: String) -> SummonNotice {
        SummonNotice(
            title: "\(combo.symbols) is taken by another app",
            detail: "A global shortcut goes to whichever app asks for it first, so pressing it will not "
                + "open \(appName). The menu bar icon this notice hangs from opens it every time. "
                + "For a key as well, press a new combination here."
        )
    }

    /// macOS gave us `combo`, after a refusal.
    ///
    /// Said out loud rather than left to a closing popover, because the whole
    /// complaint being answered is that a hotkey which does nothing and a
    /// hotkey that works look the same until you press one.
    public static func accepted(_ combo: HotkeyCombo, appName: String) -> SummonNotice {
        SummonNotice(
            title: "\(combo.symbols) is yours",
            detail: "Pressing it opens \(appName) from wherever you are. "
                + "Settings can change it again later."
        )
    }
}
