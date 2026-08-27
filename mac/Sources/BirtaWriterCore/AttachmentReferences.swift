import Foundation

/// Which attachments a markdown document actually refers to, and what has to
/// happen to them when the document moves.
///
/// This is where Save As earns the portability promise `AttachmentStore` makes.
/// The store keeps images in a folder beside the document and writes relative
/// references; graduating a scratchpad to a chosen file moves the markdown out
/// from under that folder, so the references would dangle unless the files it
/// uses travel with it.
///
/// Deliberately pure: it reads a string and reports what it found, and the
/// caller does the copying. A plan that can be inspected before anything is
/// written is the difference between a Save As that can be tested and one whose
/// failure modes are only reachable through a save panel.
public enum AttachmentReferences {
    /// One image reference in the document that points into the attachments
    /// folder.
    public struct Reference: Equatable, Sendable {
        /// The path as written in the document, e.g. `Attachments/ab12.png`.
        public let reference: String
        /// The file name within the attachments folder, e.g. `ab12.png`.
        public let name: String
    }

    /// What Save As has to do for one document moving to a new home.
    public struct MigrationPlan: Equatable, Sendable {
        /// Files to copy, as (source, destination) pairs.
        public let copies: [Copy]
        /// Whether anything needs copying at all.
        public var isEmpty: Bool { copies.isEmpty }

        public struct Copy: Equatable, Sendable {
            public let from: URL
            public let to: URL
        }
    }

    /// Carry out a plan, and report what could not be carried out.
    ///
    /// Every copy is attempted rather than stopping at the first failure, and
    /// the names that failed come back. A Save As that got the markdown to its
    /// new home with three of four images is a real state the user has to be
    /// told about honestly; refusing the whole save because one file was
    /// unreadable would be worse, since the text is the thing they asked to
    /// keep.
    ///
    /// An existing destination file is left alone. Names are content digests,
    /// so a file already there under the same name is already the right bytes.
    @discardableResult
    public static func apply(_ plan: MigrationPlan) -> [String] {
        var failed: [String] = []
        for copy in plan.copies {
            do {
                try FileManager.default.createDirectory(
                    at: copy.to.deletingLastPathComponent(), withIntermediateDirectories: true)
                if !FileManager.default.fileExists(atPath: copy.to.path) {
                    try FileManager.default.copyItem(at: copy.from, to: copy.to)
                }
            } catch {
                failed.append(copy.from.lastPathComponent)
            }
        }
        return failed
    }

    /// Every attachments-folder image reference in `markdown`, in document
    /// order, deduplicated.
    ///
    /// Matches the markdown image form `![alt](path)`, which is what the editor
    /// writes. An HTML `<img src>` a user typed by hand is NOT matched, and
    /// that is a known limit rather than an oversight: the store never produces
    /// one, and rewriting hand-authored HTML is a larger promise than this
    /// feature makes. Such an image keeps working in place and breaks on a Save
    /// As, exactly as it does today.
    public static func find(in markdown: String) -> [Reference] {
        let prefix = "\(AttachmentStore.directoryName)/"
        // `!\[ ... ]( ... )`, non-greedy in both halves, no nesting: an image
        // path with a `)` in it is not something the store can produce, since
        // it names files by hex digest.
        let pattern = #"!\[[^\]]*\]\(\s*([^)\s]+)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        var found: [Reference] = []
        var seen = Set<String>()
        let ns = markdown as NSString
        re.enumerateMatches(in: markdown, range: NSRange(location: 0, length: ns.length)) { match, _, _ in
            guard let match, match.numberOfRanges >= 2 else { return }
            let raw = ns.substring(with: match.range(at: 1))
            // Percent-encoded spaces are common in markdown paths; the digest
            // names never contain one, but a hand-edited reference might.
            let path = raw.replacingOccurrences(of: "%20", with: " ")
            guard path.hasPrefix(prefix) else { return }
            let name = String(path.dropFirst(prefix.count))
            // A nested path is not something the store writes, and following
            // one would let a document reach outside the folder.
            guard !name.isEmpty, !name.contains("/"), name != ".", name != ".." else { return }
            if seen.insert(path).inserted {
                found.append(Reference(reference: path, name: name))
            }
        }
        return found
    }

    /// What to copy so `markdown`, saved as `target`, keeps its images.
    ///
    /// The document text does not change: both homes use the same relative
    /// `Attachments/<name>` reference, so moving the files is the whole job.
    /// That is the reason the store uses a folder name rather than a path: a
    /// reference that is already correct at the destination cannot be rewritten
    /// wrongly.
    ///
    /// Only the files the document actually names are copied. An attachments
    /// folder accumulates every image ever pasted into the scratchpad, and
    /// carrying all of it into a note that uses one screenshot would quietly
    /// copy the rest of the user's clipboard history alongside it.
    public static func migrationPlan(
        markdown: String,
        from source: URL,
        to target: URL
    ) -> MigrationPlan {
        let sourceDir = AttachmentStore.directory(forDocument: source)
        let targetDir = AttachmentStore.directory(forDocument: target)
        if FileIdentity.sameFile(sourceDir, targetDir) { return MigrationPlan(copies: []) }
        let copies = find(in: markdown).map {
            MigrationPlan.Copy(from: sourceDir.appendingPathComponent($0.name),
                               to: targetDir.appendingPathComponent($0.name))
        }
        return MigrationPlan(copies: copies)
    }
}
