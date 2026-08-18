import Foundation

/// What Save As does to the buffer once the bytes are written.
public enum SaveAsOutcome: Equatable, Sendable {
    /// The scratchpad graduates: the buffer is cleared, and "Reopen Last
    /// Saved" holds what was written.
    case graduate
    /// The bytes are written and the buffer stays as it is.
    case keepBuffer
}

/// The one rule for what Save As does after writing, kept out of the
/// AppKit-bound coordinator so it can be tested. Every case here can lose
/// bytes if it is decided wrongly, which is the reason it is a pure function
/// with a test rather than a condition inside a completion handler.
public enum SaveAsDecision {
    /// - Parameters:
    ///   - boundURL: the file the buffer's bytes currently belong to.
    ///   - scratchpadURL: where the scratchpad lives right now.
    ///   - target: the file the user just chose in the save panel.
    public static func outcome(boundURL: URL, scratchpadURL: URL, target: URL) -> SaveAsOutcome {
        // Bound to a DOCUMENT: that file is the user's, and Save As is a copy
        // of it. Clearing would empty a document they never asked to empty.
        guard FileIdentity.sameFile(boundURL, scratchpadURL) else { return .keepBuffer }
        // Bound to the scratchpad, saving somewhere else: the graduation this
        // whole feature is for.
        guard FileIdentity.sameFile(target, boundURL) else { return .graduate }
        // Bound to the scratchpad, saving ONTO it. Graduating here would write
        // the cleared buffer straight back over the bytes just saved, so the
        // file the user chose would end up empty.
        return .keepBuffer
    }
}
