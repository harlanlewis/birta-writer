import Foundation

/// What a chute action may do to the buffer once the bytes have left.
public enum ChuteOutcome: Equatable, Sendable {
    /// The buffer is emptied: the scratchpad is a chute, and the note it held
    /// has gone somewhere else (the clipboard, a saved file).
    case emptyBuffer
    /// The bytes leave and the buffer stays exactly as it is.
    case keepBuffer
}

/// Whether Copy and Delete, Save, and Discard may empty the buffer.
///
/// The chute model belongs to the SCRATCHPAD. When Preferences point Jot at a
/// document instead, that file is the user's, and emptying it is the one thing
/// none of these actions may do: the user asked to copy a note out, not to
/// truncate the file they opened. Kept here beside `SaveAsDecision`, as a pure
/// function with tests, for the same reason it is: every branch loses bytes
/// when it is decided wrongly.
public enum ChuteDecision {
    /// - Parameters:
    ///   - boundURL: the file the buffer's bytes currently belong to.
    ///   - scratchpadURL: where the scratchpad lives right now.
    public static func outcome(boundURL: URL, scratchpadURL: URL) -> ChuteOutcome {
        FileIdentity.sameFile(boundURL, scratchpadURL) ? .emptyBuffer : .keepBuffer
    }
}
