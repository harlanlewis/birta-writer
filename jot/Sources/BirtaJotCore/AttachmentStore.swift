import Foundation
import CryptoKit

/// Where an image pasted into a document lives, and what the document says
/// about it.
///
/// One rule decides the shape of this whole type: the markdown must stay
/// portable. A note that references `Attachments/<name>.png` is a note you can
/// move, send, or open in another editor, and it keeps working as long as the
/// folder travels with it. An absolute path would work on this machine and
/// nowhere else, and would put the author's home directory into a file they
/// may share. So the store owns a folder BESIDE the document, and every
/// reference it hands back is relative to that document.
///
/// The name of a saved file is the hash of its bytes, which buys deduplication
/// for free: pasting the same screenshot twice writes one file and returns one
/// reference. SHA-256 rather than the extension's MD5, truncated for a
/// filename that is still short enough to read; nothing here is a security
/// boundary, but there is no reason to put a broken hash in new code.
public struct AttachmentStore: Sendable {
    /// The folder name, relative to the document, that holds its attachments.
    public static let directoryName = "Attachments"

    /// Extensions for the image types a paste or drop can carry. A type that
    /// is not here is refused rather than guessed at: an attachment whose name
    /// lies about its bytes is worse than one that was never written.
    static let extensionsByMimeType: [String: String] = [
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "image/heic": "heic",
        "image/avif": "avif",
    ]

    public enum StoreError: Error, Equatable {
        /// The mime type is not one we will write a file for.
        case unsupportedType(String)
        /// The payload carried no bytes.
        case empty
    }

    public init() {}

    /// The extension this store would give `mimeType`, or nil when it will not
    /// accept it. Exposed so a caller can refuse early with a good message.
    public static func fileExtension(for mimeType: String) -> String? {
        extensionsByMimeType[mimeType.lowercased().split(separator: ";")[0].trimmingCharacters(in: .whitespaces)]
    }

    /// Save `data` beside `document` and return the reference to put IN the
    /// document: a relative, posix-separated path such as
    /// `Attachments/1a2b3c4d5e6f7a8b.png`.
    ///
    /// Writing is skipped when a file of that name already holds bytes of the
    /// same size, which is the dedup case: the name is derived from the
    /// content, so a same-named file is the same content.
    public func save(_ data: Data, mimeType: String, besideDocument document: URL) throws -> String {
        guard !data.isEmpty else { throw StoreError.empty }
        guard let ext = Self.fileExtension(for: mimeType) else {
            throw StoreError.unsupportedType(mimeType)
        }
        let name = "\(Self.digestName(data)).\(ext)"
        let dir = Self.directory(forDocument: document)
        let file = dir.appendingPathComponent(name)
        let existing = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize
        if existing != data.count {
            try AtomicFile.write(data, to: file)
        }
        return "\(Self.directoryName)/\(name)"
    }

    /// The attachments folder for `document`.
    public static func directory(forDocument document: URL) -> URL {
        document.deletingLastPathComponent().appendingPathComponent(directoryName, isDirectory: true)
    }

    /// The first 16 bytes of the SHA-256 of `data`, hex. Short enough to read
    /// in a file listing, long enough that a collision is not a thing that
    /// happens to a scratchpad.
    static func digestName(_ data: Data) -> String {
        SHA256.hash(data: data).prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}
