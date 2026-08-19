import Foundation

/// The Finder tags on a file, read and written the way Finder does.
///
/// Tags live in an extended attribute the file manager exposes as
/// `URLResourceValues.tagNames`, so this is a thin seam rather than a format:
/// what it buys is one place that decides what an absent value means and what
/// happens to a file that is not there yet, and somewhere to test both.
///
/// The title popover is the only caller. It offers tags because the macOS
/// popover it is modelled on does, and because a scratchpad that has become a
/// real note is exactly the moment someone reaches for one.
public enum FinderTags {
    /// The file's tags, or none.
    ///
    /// A file with no tags and a file that does not exist both answer with an
    /// empty list, on purpose: the field shows what the file has, and there is
    /// no difference between those two from a field's point of view. An error
    /// worth acting on can only come from a write.
    public static func read(_ url: URL) -> [String] {
        (try? url.resourceValues(forKeys: [.tagNamesKey]))?.tagNames ?? []
    }

    /// Put exactly `tags` on the file, dropping any it had and no longer has.
    ///
    /// Blank entries are removed first: a token field hands back whatever was
    /// typed, and an empty tag is a tag Finder will not show and cannot be
    /// removed through this field once written.
    public static func write(_ tags: [String], to url: URL) throws {
        let cleaned = tags
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        // `NSURL.setResourceValue` rather than `URLResourceValues.tagNames`,
        // whose SETTER is macOS 26 and later while this package targets 14.
        // The getter above is not restricted, which is why the two halves of
        // this file do not use the same API.
        //
        // Empty means "no tags", which is nil rather than an empty array: an
        // empty array leaves the attribute in place holding nothing, and the
        // file then reads as tagged with nothing.
        try (url as NSURL).setResourceValue(cleaned.isEmpty ? nil : cleaned as NSArray,
                                            forKey: .tagNamesKey)
    }
}
