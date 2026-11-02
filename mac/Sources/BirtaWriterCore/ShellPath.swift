import Foundation

/// How the app finds the `PATH` a person's Terminal would give a command.
///
/// The problem this exists for: a GUI application launched by the Finder or
/// the Dock inherits `launchd`'s `PATH`, which is `/usr/bin:/bin:/usr/sbin:/sbin`
/// and nothing else. The terminal command's row asks whether the directory
/// it links `bwr` into is on the person's `PATH`, and asked against
/// `launchd`'s it would say no for nearly everybody whose Terminal says yes.
/// So the `PATH` read has to be the one Terminal would have given them.
///
/// Asking the shell is the only way to know. A list of likely directories
/// (`~/.local/bin`, `/opt/homebrew/bin`, and whatever is next) is a guess that
/// goes stale, and it is wrong in the direction that matters: right for most
/// people, and silently wrong for whoever arranged their `PATH` their own way.
/// The login-and-interactive shell reads exactly the files that set `PATH` for
/// that person, so it answers for the arrangement they actually have.
///
/// Pure, and in Core, so the parsing is checkable without
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
    /// can tell "it said nothing" from "it said nothing was on PATH" and
    /// report no problem it has not checked in the first case.
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
}
