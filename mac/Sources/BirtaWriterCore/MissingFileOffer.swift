import Foundation

/// What a window says, and which ways out it offers, when it holds no file it
/// can write: the bound file went, or the reader threw it away.
///
/// Three states, and the buttons follow from one question each asks: is there
/// anything on screen that exists nowhere else?
///
///     no file          No File Open                [Browse…] [Open Recent…]
///     in the Trash     This file is in the Trash   [Restore] [Browse…] [Open Recent…]
///     gone             This file can't be found    [Save It Back] [Browse…] [Open Recent…]
///
/// The empty state is what Move to Trash leaves in a window on a loose file,
/// once the buffer was written: the reader asked for the file to go, the Trash
/// holds every byte, so there is nothing to recover and the window is simply
/// empty. A folder window never reaches it, because trashing its file moves
/// the tab to the folder's own choice of file instead.
///
/// Restore moves the file back out of the Trash, which returns every byte the
/// file had, and leaves the buffer on screen untouched. So it is the whole
/// answer in the Trash whether or not the reader typed since: changes made
/// after the file went stay on screen, unsaved, the state the title already
/// has a word for. That is why Save It Back is not offered beside it.
///
/// Save It Back writes the BUFFER to the path the file came from, and is
/// offered only where it is the one copy left: the file is gone with no Trash
/// to restore from and there is text on screen. It is never called Restore,
/// because it restores nothing; it hands the reader their own buffer.
///
/// Nothing here throws the buffer away. Browse and Open Recent open another
/// file into this window, replacing it rather than leaving a dead window
/// behind, and text that exists nowhere else is written to a recovered file
/// beside the missing one first (`leavingNeedsRecoveredCopy`).
public struct MissingFileOffer: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// The reader moved the file to the Trash and nothing was unwritten.
        case noFile
        /// The file went while the window was on it.
        /// - Parameters:
        ///   - inTrash: a trashed copy is there right now to move back.
        ///   - textAtRisk: the screen holds bytes no file on disk does.
        case gone(inTrash: Bool, textAtRisk: Bool)
    }

    public enum Action: String, CaseIterable, Sendable {
        case restore = "Restore"
        case saveItBack = "Save It Back"
        case browse = "Browse…"
        case openRecent = "Open Recent…"
    }

    public let heading: String
    /// Empty for none.
    public let body: String
    public let actions: [Action]
    /// Whether the words sit on a card over the document, or on the window's
    /// own ground with nothing behind them. The card says the document behind
    /// it is still there; the empty state has none.
    public let isCard: Bool

    /// Whether a window LEAVING this state for another file has to write its
    /// buffer to a recovered copy first, because nothing else holds it.
    ///
    /// Leaving is always allowed (a dead window is never kept around to guard
    /// its text); this says when leaving costs a copy. Not in the empty state,
    /// whose buffer is blank, nor when a trashed copy holds every byte and
    /// nothing was typed since; otherwise any text on screen is kept.
    public static func leavingNeedsRecoveredCopy(isEmptyState: Bool, bufferIsBlank: Bool,
                                                 trashedCopyThere: Bool, typedSinceWritten: Bool) -> Bool {
        if isEmptyState || bufferIsBlank { return false }
        if trashedCopyThere && !typedSinceWritten { return false }
        return true
    }

    public static let atRiskSentence = "What you were writing is still on screen, and is not saved anywhere else."
    public static let restoreKeepsSentence = "Your changes are still on screen, and Restore keeps them."

    public init(_ state: State) {
        switch state {
        case .noFile:
            heading = "No File Open"
            body = ""
            actions = [.browse, .openRecent]
            isCard = false
        case let .gone(inTrash: true, textAtRisk):
            heading = "This file is in the Trash"
            body = textAtRisk ? Self.restoreKeepsSentence : ""
            actions = [.restore, .browse, .openRecent]
            isCard = true
        case let .gone(inTrash: false, textAtRisk):
            heading = "This file can't be found"
            body = ["It may have been deleted or moved.", textAtRisk ? Self.atRiskSentence : ""]
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            actions = textAtRisk ? [.saveItBack, .browse, .openRecent] : [.browse, .openRecent]
            isCard = true
        }
    }
}
