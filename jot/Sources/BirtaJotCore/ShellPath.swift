import Foundation

/// How Jot finds the `PATH` a person's Terminal would give a command.
///
/// The problem this exists for: a GUI application launched by the Finder or
/// the Dock inherits `launchd`'s `PATH`, which is `/usr/bin:/bin:/usr/sbin:/sbin`
/// and nothing else. Every agent CLI the AI Agent pane offers installs
/// somewhere else, so `/ai` and its Test button report a tool the person uses
/// daily as not installed. The pane's own promise is the standard to meet:
/// it says the tool must be "runnable from Terminal", so what a command gets
/// has to be what Terminal would have given it.
///
/// Asking the shell is the only way to know. A list of likely directories
/// (`~/.local/bin`, `/opt/homebrew/bin`, and whatever is next) is a guess that
/// goes stale, and it is wrong in the direction that matters: it would find
/// most tools and fail silently on the one somebody installed their own way.
/// The login-and-interactive shell reads exactly the files that set `PATH` for
/// that person, so it answers for the arrangement they actually have.
///
/// Pure, and in Core, so the parsing and the merge are checkable without
/// running a shell. `LoginShellPath` in the app is what runs one.
public enum ShellPath {
    /// Fences around the answer, so an rc file that prints a greeting, a
    /// version banner or a prompt cannot be read as part of the value.
    ///
    /// Not optional, and not a "take the last line" rule: an rc file is
    /// somebody's own program and may print after the value as easily as
    /// before it. A pair of markers is the only reading that does not depend
    /// on what else is in the output.
    public static let openMarker = "__BIRTA_PATH_BEGIN__"
    public static let closeMarker = "__BIRTA_PATH_END__"

    /// The one line the shell is asked to run.
    ///
    /// `printenv` rather than `$PATH`, and that is not a style choice. In fish
    /// `PATH` is a LIST, so `"$PATH"` renders it space-separated and every
    /// directory in it is lost; `printenv` reads the exported variable, which
    /// is colon-separated in every shell because that is the form a child
    /// process is handed. Three plain commands rather than one substitution,
    /// for the same reason: `$(...)` is not fish's spelling.
    ///
    /// `printf` rather than `echo` for the fences, which in some shells eats a
    /// leading `-` and interprets backslashes.
    public static let script =
        "printf '\(openMarker)'; printenv PATH; printf '\(closeMarker)'"

    /// How to invoke it: login AND interactive.
    ///
    /// Both flags, because the two together are what read the whole set of
    /// files people actually put `PATH` in. Login alone misses `.zshrc`,
    /// which is where a zsh user's `PATH` most often is, and zsh has been the
    /// macOS default since Catalina; interactive alone misses `.zprofile` and
    /// `.bash_profile`, which is where Homebrew's own installer writes.
    public static func arguments(script: String = ShellPath.script) -> [String] {
        ["-i", "-l", "-c", script]
    }

    /// The shell to ask: the one the person's account uses, or `/bin/zsh`.
    ///
    /// `SHELL` is what Terminal itself opens, so it is the right question.
    /// The fallback is the macOS default rather than `/bin/sh`, because `sh`
    /// reads none of the files this is here to read.
    public static func shell(fromEnvironment environment: [String: String]) -> String {
        let named = environment["SHELL"] ?? ""
        return named.hasPrefix("/") ? named : "/bin/zsh"
    }

    /// The value between the markers, or nil when the shell never printed one.
    ///
    /// Nil rather than an empty string for a shell that failed, so a caller
    /// can tell "it said nothing" from "it said nothing was on PATH" and keep
    /// what it already had in the first case.
    public static func path(fromOutput output: String) -> String? {
        guard let open = output.range(of: openMarker),
              let close = output.range(of: closeMarker, range: open.upperBound..<output.endIndex)
        else { return nil }
        // Trimmed, because `printenv` ends its line and the newline is not
        // part of the value.
        let value = String(output[open.upperBound..<close.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    /// The `PATH` a child gets: what the shell reported, then anything the
    /// app already had that the shell did not mention.
    ///
    /// A merge rather than a replacement. The shell's answer comes first
    /// because it is the person's own ordering, and theirs is what decides
    /// between two copies of a tool; the inherited entries are kept behind it
    /// because dropping them could take away a directory the app was given
    /// deliberately, and there is no version of this feature that is improved
    /// by having fewer places to look.
    ///
    /// Empty segments are dropped. A trailing colon in `PATH` means the
    /// current directory on some shells, and the current directory of an
    /// agent run is the person's note folder.
    public static func childPath(resolved: String?, inherited: String?) -> String? {
        let entries = [resolved, inherited]
            .compactMap { $0 }
            .flatMap { $0.split(separator: ":", omittingEmptySubsequences: true).map(String.init) }
        var seen = Set<String>()
        let unique = entries.filter { seen.insert($0).inserted }
        return unique.isEmpty ? nil : unique.joined(separator: ":")
    }
}
