import Foundation

/// The two questions Jot's file settings actually ask, as two types.
///
/// They were one tangle of switches that overrode each other silently: a
/// "Keep in iCloud Drive" toggle that a chosen path quietly outranked, an
/// "Edit a document instead" toggle that disabled New Note from another pane,
/// and a "Start with a blank note" switch sitting in General deciding what
/// Advanced's paths were even for. Nothing was wrong with any one of them; the
/// problem was that three controls answered two questions and neither question
/// was written down.
///
/// The questions are: WHAT does summoning the panel open, and WHERE do notes
/// live. They are independent, which is why they are separate types and why
/// neither resolver takes the other's value.

/// What summoning Birta Writer Jot opens.
public enum NoteMode: String, CaseIterable, Sendable {
    /// The same note every time, wherever it lives. A scratchpad that survives
    /// a restart is what most people summon a scratchpad for.
    case sameNote
    /// A fresh dated note per session, so the panel is always empty and the
    /// old ones accumulate beside it.
    case newEachSession

    public var title: String {
        switch self {
        case .sameNote: return "The same note every time"
        case .newEachSession: return "A new note each session"
        }
    }
}

/// Where Birta Writer Jot keeps its notes.
///
/// Three answers, and the third is what made the old pair confusing: choosing
/// a folder of your own outranks the iCloud switch entirely, so the switch
/// decided nothing while a path was set and said nothing about it either.
/// Here it is a third option in the same control, which is what it always was.
public enum NoteHome: String, CaseIterable, Sendable {
    case iCloud
    case documents
    case chosen

    public var title: String {
        switch self {
        case .iCloud: return "iCloud Drive"
        case .documents: return "Documents"
        case .chosen: return "Choose a folder…"
        }
    }

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
/// a match, which is what `matching(template:)` returns nil for.
///
/// Deliberately no VS Code routes. The extension's picker offers a Chat view
/// and a clipboard fallback beside these, and neither means anything in an app
/// with no chat view.
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

    /// The preset a stored command came from, or nil for one the user wrote.
    ///
    /// Exact, not by binary name. Two presets could share a binary one day,
    /// and a template that merely starts with `claude` is a command someone
    /// edited: showing the preset for it would claim the popup describes a
    /// field it no longer matches.
    public static func matching(template: String) -> AgentPreset? {
        allCases.first { $0.template == template }
    }

    /// The default, and the one a fresh install runs.
    public static let fallback = AgentPreset.claudeCode
}
