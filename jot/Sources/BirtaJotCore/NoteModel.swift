import Foundation

/// The two questions Jot's file settings actually ask, as two types.
///
/// The questions are: WHAT does summoning the panel open, and WHERE do notes
/// live. They are independent, which is why they are separate types and why
/// neither resolver takes the other's value. A control that answered a bit of
/// each is what makes a settings pane impossible to reason about, because
/// there is then no question a row is the answer to.

/// What summoning Birta Writer Jot opens.
public enum NoteMode: String, CaseIterable, Sendable {
    /// The same note every time, wherever it lives. A scratchpad that survives
    /// a restart is what most people summon a scratchpad for.
    case sameNote
    /// A fresh dated note per session, so the panel is always empty and the
    /// old ones accumulate beside it.
    case newEachSession

    /// What the menu calls it.
    ///
    /// Named for what you GET rather than for the policy: the row asks what a
    /// new window opens with, so the answers are the two things it could open,
    /// and "the same note every time" was a description of the setting rather
    /// than of either outcome.
    public var title: String {
        switch self {
        case .sameNote: return "Last open file"
        case .newEachSession: return "New file"
        }
    }
}

/// Where Birta Writer Jot keeps its notes.
///
/// Three answers, and the third outranks the other two: a folder of your own
/// is where notes are whatever the iCloud preference says. The surfaces show
/// that as a switch plus a Location row, and both of them clear the chosen
/// path when the switch goes on, so the switch is never left deciding
/// nothing.
public enum NoteHome: String, CaseIterable, Sendable {
    case iCloud
    case documents
    case chosen

    /// Which home is in force, given the two things stored and what the
    /// machine can actually do.
    ///
    /// A chosen path wins over everything, then the iCloud preference, and
    /// iCloud falls back to Documents when iCloud Drive is switched off rather
    /// than failing. The fallback is silent in behaviour and NOT in the
    /// interface: the row says the service is off and the note is on this Mac.
    public static func inForce(preferICloud: Bool,
                               hasChosenPath: Bool,
                               iCloudAvailable: Bool) -> NoteHome {
        if hasChosenPath { return .chosen }
        return preferICloud && iCloudAvailable ? .iCloud : .documents
    }
}

/// The agent command presets the Settings popup offers.
///
/// A list of terminal agents by the binary they install, which is the part
/// that does not rot: a flag can change under us, and `claude` will still be
/// what Claude Code is called. Custom is not a case here; it is the absence of
/// a match: choosing one WRITES the command field and is then done with,
/// and the field is what runs.
///
/// Deliberately no VS Code routes. The extension's picker offers a Chat view
/// and a clipboard fallback beside these, and neither means anything in an app
/// with no chat view.
/// Whether this host can hand a prompt to an agent at all.
///
/// A rule rather than a stored flag, because there are TWO ways to have no
/// agent and the row, the capability and the slash command all have to agree
/// with both of them: the switch is off, or there is no command to run. A
/// capability that answered only the switch would offer `/ai` on a host whose
/// command field is empty, which is a menu entry that runs nothing.
///
/// Pure, and here rather than in `Prefs`, so it can be checked without a
/// defaults domain: the app's own store is the real user's, and a test that
/// wrote to it to exercise this would change somebody's settings.
public enum AgentAvailability {
    public static func isAvailable(enabled: Bool, command: String) -> Bool {
        enabled && !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public enum AgentPreset: String, CaseIterable, Sendable {
    case claudeCode
    case codex
    case cursor
    case gemini
    case copilot
    case opencode
    case aider
    case amp
    case goose

    public var title: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex CLI"
        case .cursor: return "Cursor CLI"
        case .gemini: return "Gemini CLI"
        case .copilot: return "GitHub Copilot CLI"
        case .opencode: return "OpenCode"
        case .aider: return "Aider"
        case .amp: return "Amp"
        case .goose: return "Goose"
        }
    }

    /// What choosing it writes into the command field. `{prompt}` is the
    /// placeholder `AgentRequest.expand` substitutes.
    public var template: String {
        switch self {
        case .claudeCode: return "claude -p {prompt} --permission-mode acceptEdits"
        case .codex: return "codex exec --full-auto {prompt}"
        case .cursor: return "cursor-agent -p {prompt}"
        case .gemini: return "gemini -p {prompt}"
        case .copilot: return "copilot -p {prompt}"
        case .opencode: return "opencode run {prompt}"
        case .aider: return "aider --message {prompt}"
        case .amp: return "amp -x {prompt}"
        case .goose: return "goose run -t {prompt}"
        }
    }

    /// The default, and the one a fresh install runs.
    public static let fallback = AgentPreset.claudeCode
}
