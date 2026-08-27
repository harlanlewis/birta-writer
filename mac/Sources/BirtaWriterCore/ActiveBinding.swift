import Foundation

/// WHICH of the app's three file settings the panel is editing right now.
///
/// The app has one buffer and three places a path can come from, in precedence:
/// a document the user pointed it at, the note New Note last made, and the
/// scratchpad it starts and returns to. Reading that order is easy and was
/// already a one-line `??` chain in `Prefs.activeURL`.
///
/// Writing it back is the part that needed a home. Renaming or moving the file
/// from the title popover has to update THE SAME setting the path was read
/// from, and nothing in a `??` chain says which one that was. Write the
/// scratchpad's path while the panel is showing a New Note and the note stays
/// where it is, the scratchpad points at a file that was never moved, and the
/// next launch opens the wrong one. The slot is what makes the read and the
/// write-back the same decision.
public enum ActiveBinding {
    /// The three settings, highest precedence first. `CaseIterable` so a test
    /// enumerates them from the type rather than from a list it keeps by hand:
    /// a fourth slot joins the sweep the day it is added.
    public enum Slot: String, CaseIterable, Sendable {
        case document
        case currentNote
        case scratchpad
    }

    /// Which slot supplies the active file.
    ///
    /// Takes what is SET rather than the URLs themselves, because that is the
    /// whole of the decision and it keeps the caller from having to hand over
    /// a scratchpad path just to ask the question.
    public static func slot(hasDocument: Bool, hasCurrentNote: Bool) -> Slot {
        if hasDocument { return .document }
        if hasCurrentNote { return .currentNote }
        return .scratchpad
    }

    /// WHICH stored path names `moved`, for a file that has already moved.
    ///
    /// A rename has to be written back to the setting the old path came from,
    /// and after the move that setting can no longer be found by asking which
    /// slot is in force: a slot whose file no longer exists reports itself
    /// empty, so the binding has already fallen back to the next one down.
    /// Matching the OLD path against what is stored is what survives the move.
    ///
    /// Nil means no stored path names it, which is the default scratchpad
    /// location: it is where the panel is without anything having been stored.
    public static func slot(holding moved: URL,
                            document: URL?, currentNote: URL?, scratchpad: URL?) -> Slot? {
        let target = moved.standardizedFileURL.path
        if document?.standardizedFileURL.path == target { return .document }
        if currentNote?.standardizedFileURL.path == target { return .currentNote }
        if scratchpad?.standardizedFileURL.path == target { return .scratchpad }
        return nil
    }

    /// The active file, resolved by the same precedence the slot names.
    ///
    /// The two functions are kept in step by this one being written in terms
    /// of the other, so a change to the order cannot reach one and miss the
    /// other. That is the failure this type exists to prevent, and it would be
    /// silly to reintroduce it here.
    public static func url(document: URL?, currentNote: URL?, scratchpad: URL) -> URL {
        switch slot(hasDocument: document != nil, hasCurrentNote: currentNote != nil) {
        case .document: return document ?? scratchpad
        case .currentNote: return currentNote ?? scratchpad
        case .scratchpad: return scratchpad
        }
    }
}
