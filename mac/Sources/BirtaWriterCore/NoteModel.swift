import Foundation

/// The two questions the app's file settings actually ask, as two types.
///
/// The questions are: WHAT does summoning the panel open, and WHERE do notes
/// live. They are independent, which is why they are separate types and why
/// neither resolver takes the other's value. A control that answered a bit of
/// each is what makes a settings pane impossible to reason about, because
/// there is then no question a row is the answer to.

/// What summoning Birta Writer opens.
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

/// Where Birta Writer keeps its notes.
///
/// ONE two-way choice, and each side of it has a default. The iCloud switch
/// picks the branch: on is the folder the app derives inside iCloud Drive, off
/// is a folder of your own, which starts at the one under Documents and
/// becomes whatever you name in the Location row.
///
/// Three cases for two branches, because `chosen` and `documents` are that one
/// branch reported apart. Whether the folder was named or taken as given is
/// worth knowing to a settings report and to the launch check that notices a
/// derived folder moving, and it changes nothing about which of the two
/// answers the switch gave.
///
/// The stored path is the OFF branch's own value rather than an override of
/// the switch. That is what keeps the switch from ever deciding nothing
/// without anything having to throw the path away to manage it: the path is
/// read only while the branch that owns it is in force, so a folder somebody
/// named survives a trip through iCloud and back.
public enum NoteHome: String, CaseIterable, Sendable {
    case iCloud
    case documents
    case chosen

    /// Which home is in force, given the two things stored and what the
    /// machine can actually do.
    ///
    /// The switch decides first, and iCloud needs iCloud Drive actually
    /// switched on: without it the branch falls to the user's own folder
    /// rather than failing, which is the one they last named if there is one
    /// and the one under Documents otherwise. That fallback is silent in
    /// behaviour and NOT in the interface: the row says the service is off and
    /// the note is on this Mac.
    public static func inForce(preferICloud: Bool,
                               hasChosenPath: Bool,
                               iCloudAvailable: Bool) -> NoteHome {
        if preferICloud && iCloudAvailable { return .iCloud }
        return hasChosenPath ? .chosen : .documents
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
    case pi
    case hermes

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
        case .pi: return "Pi"
        case .hermes: return "Hermes"
        }
    }

    /// Where the tool's own documentation is, for the link Settings draws
    /// under the command field.
    ///
    /// The vendor's page rather than a wrapper or a mirror, and the entry
    /// point somebody who has not installed the tool needs: an install and a
    /// first run. What is NOT here is a deep link to the flag in `template`,
    /// which is the thing most likely to move under us; a quickstart is the
    /// most durable page any of these projects have.
    ///
    /// Exhaustive rather than optional, so a preset added without a
    /// destination is a compile error rather than a link that quietly stops
    /// appearing. `AgentPresetTests` asks every case for one.
    public var documentation: URL {
        switch self {
        case .claudeCode: return URL(string: "https://code.claude.com/docs/en/quickstart")!
        case .codex: return URL(string: "https://learn.chatgpt.com/docs/codex/cli")!
        case .cursor: return URL(string: "https://cursor.com/cli")!
        case .gemini: return URL(string: "https://google-gemini.github.io/gemini-cli/docs/")!
        case .copilot: return URL(string: "https://docs.github.com/en/copilot/how-tos/copilot-cli")!
        case .opencode: return URL(string: "https://opencode.ai/docs/cli/")!
        case .aider: return URL(string: "https://aider.chat/docs/")!
        case .amp: return URL(string: "https://ampcode.com/manual")!
        case .goose: return URL(string: "https://goose-docs.ai/docs/quickstart/")!
        case .pi: return URL(string: "https://pi.dev/docs/latest/quickstart")!
        case .hermes:
            return URL(string: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart")!
        }
    }

    /// What choosing it writes into the command field. `{prompt}` is the
    /// placeholder `AgentRequest.expand` substitutes.
    ///
    /// The non-interactive form of each tool, and only ever the flags it takes
    /// to edit a note in the folder it was pointed at. What a template must
    /// not carry is a preference: no model, no reasoning effort, no verbosity.
    /// Those are the user's, the field below the menu is where they add them,
    /// and a preset that shipped with one would be making that choice for
    /// everybody who picked a tool from a list.
    ///
    /// Codex needs both of its flags to run at all here, and neither is
    /// optional: `codex exec` refuses outside a git repository, and a notes
    /// folder is not one; and without a sandbox naming a writable workspace it
    /// may only read, which is not what `/ai` is for.
    ///
    /// A flag is the part of this most likely to move under us, and nothing
    /// here can notice when one does: a preset is a string, and the tool that
    /// rejects it is not on this machine. What that costs is the Test button
    /// saying it did not work, with the tool's own usage message underneath,
    /// which is the case that button is for.
    public var template: String {
        switch self {
        case .claudeCode: return "claude -p {prompt} --permission-mode acceptEdits"
        case .codex: return "codex exec --sandbox workspace-write --skip-git-repo-check {prompt}"
        case .cursor: return "cursor-agent -p {prompt}"
        case .gemini: return "gemini -p {prompt}"
        case .copilot: return "copilot -p {prompt}"
        case .opencode: return "opencode run {prompt}"
        case .aider: return "aider --message {prompt}"
        case .amp: return "amp -x {prompt}"
        case .goose: return "goose run -t {prompt}"
        case .pi: return "pi -p {prompt}"
        case .hermes: return "hermes -z {prompt}"
        }
    }

    /// The default, and the one a fresh install runs.
    public static let fallback = AgentPreset.claudeCode

    /// The program a command line runs: its first word, with any path and any
    /// surrounding quotes taken off.
    ///
    /// Everything after it is arguments, and arguments are exactly what the
    /// user is expected to have changed. `claude -p {prompt}` and
    /// `/opt/homebrew/bin/claude --model opus -p {prompt}` are the same tool.
    static func program(of command: String) -> String? {
        let head = command
            .split(whereSeparator: \.isWhitespace)
            .first
            .map(String.init)?
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        guard let head, let name = head.split(separator: "/").last, !name.isEmpty else {
            return nil
        }
        return name.lowercased()
    }

    /// The preset a command is running, or nil for one this does not
    /// recognise.
    ///
    /// Compared program to program, so the menu can say which tool is selected
    /// without claiming to be the setting: the field below it is what runs,
    /// and a command whose flags have been edited is still the same tool. A
    /// command naming nothing here is not an error, it is somebody running
    /// their own thing, and the menu says so by naming no tool at all.
    public static func matching(command: String) -> AgentPreset? {
        guard let running = program(of: command) else { return nil }
        return allCases.first { program(of: $0.template) == running }
    }
}
