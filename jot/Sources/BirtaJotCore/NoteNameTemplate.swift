import Foundation

/// What a new note is called, from a template the user can edit.
///
/// The tokens are `strftime(3)`'s, and they are its own rather than a dialect
/// that resembles it: this calls the C function, so `%Y-%m-%d` here means what
/// it means in `date(1)`, in a shell prompt, and in every other tool on the
/// machine. Inventing a placeholder vocabulary would be one more thing to
/// learn and one more thing to document, in exchange for nothing.
///
/// Everything else this does is about the difference between a date format and
/// a FILENAME. `strftime` will happily produce `08/20/26` for `%D`, and a
/// slash in a name is a path separator rather than a character, so expansion
/// is only the first half; the second half is making the result safe to put on
/// disk, and refusing to return something unusable when it cannot.
public enum NoteNameTemplate {
    /// The default, and the shape the help text is written against: the note
    /// is filed by day, which is what a scratchpad accumulating beside itself
    /// wants.
    public static let `default` = "Jot %Y-%m-%d.md"

    /// The extension a note always ends up with, whatever the template says.
    public static let ext = "md"

    /// The tokens worth printing under the field.
    ///
    /// SIX of the dozens `strftime` defines, chosen because they are the ones
    /// somebody naming a note by date and time actually reaches for. The rest
    /// are a link away rather than a wall of text under a settings row, and
    /// they all work: this is a shortlist, not the supported set.
    public static let helpText =
        "%Y year, %m month, %d day, %H hour, %M minute, %S second. "
        + "Any other strftime format works too."

    /// Where the full list lives.
    ///
    /// The POSIX specification rather than a man page on one host or a blog:
    /// it is the document every implementation is written against, including
    /// the one this calls, and it is the least likely of the candidates to
    /// move.
    public static let referenceURL = URL(
        string: "https://pubs.opengroup.org/onlinepubs/9699919799/functions/strftime.html")!

    /// The characters a filename may not carry.
    ///
    /// The same pair `DocumentName` refuses from the rename field, for the
    /// same reasons: `/` is the path separator, and `:` is what the Finder
    /// still shows as one. Replaced rather than refused here, because a
    /// template is expanded without anybody watching and a note that cannot be
    /// created is worse than one with a hyphen in its name.
    static let unsafe: Set<Character> = ["/", ":"]

    /// The template expanded against `date`, as a filename.
    ///
    /// Always returns something usable. A template that expands to nothing, or
    /// to nothing but separators, falls back to the default rather than
    /// producing a file called `.md` or a name that is all hyphens: the
    /// setting is a preference about spelling, and no spelling of it should be
    /// able to stop a new note being made.
    public static func expand(_ template: String, at date: Date = Date(),
                              timeZone: TimeZone = .current) -> String {
        let expanded = strftime(template, date, timeZone).map(sanitize) ?? ""
        guard usable(expanded) else {
            // The fallback is expanded too rather than returned literally, or
            // a broken template would put `Jot %Y-%m-%d.md` on disk verbatim.
            let safe = strftime(Self.default, date, timeZone).map(sanitize) ?? ""
            return withExtension(usable(safe) ? safe : "Jot")
        }
        return withExtension(expanded)
    }

    /// The stem and extension a caller numbering collisions needs.
    ///
    /// `Coordinator.unusedURL(in:stem:extension:)` takes the two apart, so
    /// splitting here keeps the split in one place and keeps `Note 2.md`
    /// numbering the stem rather than landing on `Note.md 2`.
    public static func parts(_ template: String, at date: Date = Date(),
                             timeZone: TimeZone = .current) -> (stem: String, ext: String) {
        let name = expand(template, at: date, timeZone: timeZone)
        let url = URL(fileURLWithPath: name)
        return (url.deletingPathExtension().lastPathComponent, url.pathExtension)
    }

    /// `strftime(3)` itself, against a pinned C locale.
    ///
    /// Nil when the function refuses, which it does for a result that will not
    /// fit and, indistinguishably, for one that is genuinely empty. The caller
    /// treats both as "use the default", which is the right answer either way.
    private static func strftime(_ format: String, _ date: Date, _ timeZone: TimeZone) -> String? {
        var seconds = time_t(date.timeIntervalSince1970)
        var parts = tm()
        // `localtime_r` reads the process time zone rather than an argument,
        // so the offset is applied by hand. That keeps this testable against a
        // fixed zone instead of only against whatever the machine is set to.
        seconds += time_t(timeZone.secondsFromGMT(for: date))
        guard gmtime_r(&seconds, &parts) != nil else { return nil }
        var buffer = [CChar](repeating: 0, count: 1024)
        let written = Foundation.strftime(&buffer, buffer.count, format, &parts)
        guard written > 0 else { return nil }
        return String(cString: buffer)
    }

    /// A filename out of whatever the format produced.
    ///
    /// Only the two path characters and surrounding whitespace. A LEADING dot
    /// is deliberately left alone rather than trimmed away, because trimming
    /// it turns `.md` into the perfectly plausible name `md`, and a template
    /// with no name in front of its extension is one somebody has not finished
    /// typing. `usable` is what refuses it, so the fallback happens instead.
    private static func sanitize(_ name: String) -> String {
        String(name.map { unsafe.contains($0) ? "-" : $0 })
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether a sanitized name is worth writing to disk.
    ///
    /// Nothing at all, or a hidden file. Both are what a half-finished
    /// template looks like, and neither is a thing anybody meant to ask for.
    private static func usable(_ name: String) -> Bool {
        !name.isEmpty && !name.hasPrefix(".")
    }

    /// `.md` on the end, without doubling one that is already there.
    private static func withExtension(_ name: String) -> String {
        name.lowercased().hasSuffix(".\(ext)") ? name : "\(name).\(ext)"
    }
}
