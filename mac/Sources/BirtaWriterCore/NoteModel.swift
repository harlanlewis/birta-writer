import Foundation

/// The two questions the app's file settings actually ask, as two types.
///
/// The questions are: WHAT does summoning the panel open, and WHERE do notes
/// live. They are independent, which is why they are separate types and why
/// neither resolver takes the other's value. A control that answered a bit of
/// each is what makes a settings pane impossible to reason about, because
/// there is then no question a row is the answer to.

/// What summoning Birta Writer opens.
public enum NoteMode: String, CaseIterable, Sendable {
    /// The same note every time, wherever it lives. A scratchpad that survives
    /// a restart is what most people summon a scratchpad for.
    case sameNote
    /// A fresh dated note per session, so the panel is always empty and the
    /// old ones accumulate beside it.
    case newEachSession

    /// What the menu calls it.
    ///
    /// Named for what you GET rather than for the policy: the row asks what a
    /// new window opens with, so the answers are the two things it could open,
    /// and "the same note every time" was a description of the setting rather
    /// than of either outcome.
    public var title: String {
        switch self {
        case .sameNote: return "Last open file"
        case .newEachSession: return "New file"
        }
    }
}

/// Where a file opened from outside lands when no open root holds it: the
/// "Open files in" setting. A tab beside the window in front, or a window of
/// its own. It decides nothing for a file under an open folder window (that
/// window's), for Cmd+N (the system's tabbing preference), or with no window
/// open at all.
public enum FileOpenTarget: String, CaseIterable, Sendable {
    case tab
    case window

    /// A window of its own unless the reader asks for tabs: a file from
    /// outside every open folder is a separate piece of work, and a folder's
    /// files already gather as tabs of its window (owner decision, 2026-11-01).
    public static let `default`: FileOpenTarget = .window

    /// What the menu calls it: the two things the file could open in.
    public var title: String {
        switch self {
        case .tab: return "New tab"
        case .window: return "New window"
        }
    }
}

/// Where Birta Writer keeps its notes.
///
/// ONE two-way choice, and each side of it has a default. The iCloud switch
/// picks the branch: on is the folder the app derives inside iCloud Drive, off
/// is a folder of your own, which starts at the one under Documents and
/// becomes whatever you name in the Location row.
///
/// Three cases for two branches, because `chosen` and `documents` are that one
/// branch reported apart. Whether the folder was named or taken as given is
/// worth knowing to a settings report and to the launch check that notices a
/// derived folder moving, and it changes nothing about which of the two
/// answers the switch gave.
///
/// The stored path is the OFF branch's own value rather than an override of
/// the switch. That is what keeps the switch from ever deciding nothing
/// without anything having to throw the path away to manage it: the path is
/// read only while the branch that owns it is in force, so a folder somebody
/// named survives a trip through iCloud and back.
public enum NoteHome: String, CaseIterable, Sendable {
    case iCloud
    case documents
    case chosen

    /// Which home is in force, given the two things stored and what the
    /// machine can actually do.
    ///
    /// The switch decides first, and iCloud needs iCloud Drive actually
    /// switched on: without it the branch falls to the user's own folder
    /// rather than failing, which is the one they last named if there is one
    /// and the one under Documents otherwise. That fallback is silent in
    /// behaviour and NOT in the interface: the row says the service is off and
    /// the note is on this Mac.
    public static func inForce(preferICloud: Bool,
                               hasChosenPath: Bool,
                               iCloudAvailable: Bool) -> NoteHome {
        if preferICloud && iCloudAvailable { return .iCloud }
        return hasChosenPath ? .chosen : .documents
    }
}

