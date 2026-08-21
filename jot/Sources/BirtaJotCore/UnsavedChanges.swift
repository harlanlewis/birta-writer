import Foundation

/// What the quit sheet says, with no window.
///
/// Here rather than beside the `NSAlert` for the reason `WindowTitle` and
/// `UpdatePolicy` are: these are the words somebody reads at the one moment
/// their unsaved typing is at stake, and words that can only be checked by
/// putting a sheet on screen are words nothing checks.
///
/// The shape is the platform's, deliberately, because it is the shape people
/// already know how to answer: a question naming the document, a sentence
/// saying what happens if they do not save, and Save / Discard Changes /
/// Cancel in that order, with Cancel last and bound to Escape.
///
/// Discard Changes rather than Don't Save. macOS uses Don't Save for a
/// document that has never been written and Revert Changes for one being
/// closed back to its saved version; Jot's note is always a file on disk, and
/// this sheet is shown on the way out rather than on a close, so neither is
/// quite the sentence. What the button does is throw away the changes since
/// the last save, and that is what it says.
public enum UnsavedChanges {
    /// The question, naming the file the way its window title does.
    public static func title(document: String) -> String {
        "Do you want to save the changes you made to “\(document)”?"
    }

    /// What happens if they do not.
    public static let detail = "Your changes will be lost if you don’t save them."

    public static let saveTitle = "Save"
    public static let discardTitle = "Discard Changes"
    public static let cancelTitle = "Cancel"

    /// What the person said.
    public enum Answer: Equatable, Sendable {
        /// Write the buffer, then go.
        case save
        /// Go without writing.
        case discard
        /// Do not go.
        case cancel
    }
}
