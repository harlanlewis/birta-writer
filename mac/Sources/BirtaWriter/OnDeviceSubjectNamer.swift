import BirtaWriterCore
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Names the folder overview's subjects with Apple's on-device model, the
/// `subjectNames` capability's answer. What it asks and what it keeps are
/// `SubjectNames`'; this file is only the asking.
///
/// On the machine, always: `SystemLanguageModel` runs on this Mac and sends
/// nothing anywhere, which is the whole reason a name is asked for here and
/// not from a hosted model (docs/NETWORK_POSTURE.md, rung 3).
///
/// Every way of not having a model answers with no names, and the page keeps
/// its own: built with an SDK that has no `FoundationModels`, running on a
/// macOS before 26, Apple Intelligence switched off or the model still
/// downloading, or a request the model declines. None of those is worth a
/// word to the reader, because the names on screen were already good enough
/// to read.
enum OnDeviceSubjectNamer {
    /// A name for each subject that could be named, by subject id.
    static func names(for subjects: [SubjectNames.Request]) async -> [String: String] {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            return await ask(subjects)
        }
        #endif
        return [:]
    }

    #if canImport(FoundationModels)
    @available(macOS 26.0, *)
    private static func ask(_ subjects: [SubjectNames.Request]) async -> [String: String] {
        guard case .available = SystemLanguageModel.default.availability else { return [:] }
        var names: [String: String] = [:]
        // One session per subject: a session keeps its transcript, and a name
        // asked after another would be shaped by the one before it.
        for subject in subjects where !subject.notes.isEmpty {
            let session = LanguageModelSession(instructions: SubjectNames.instructions)
            guard let answer = try? await session.respond(to: SubjectNames.prompt(for: subject)) else { continue }
            if let name = SubjectNames.clean(answer.content) { names[subject.id] = name }
        }
        return names
    }
    #endif
}
