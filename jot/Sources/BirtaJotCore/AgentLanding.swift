import Foundation

/// What a finished `/ai` run does to the panel.
public enum AgentLanding: Equatable, Sendable {
    /// The agent left the file as it found it. Nothing to bring in.
    case settle
    /// Take the file as the buffer's new truth: the panel holds nothing the
    /// run has not seen, so the ordinary reload carries the change in.
    case reload
    /// The panel holds bytes the run never saw. The file is NOT read over
    /// them; its bytes go to the page instead, which merges the agent's
    /// changes around what was typed
    /// (`webview/plugins/agentPending.ts`, `applyAgentResult`).
    case merge(diskText: String)

    /// Whether the buffer takes the file's bytes here, rather than the page.
    public var reloadsBuffer: Bool {
        if case .reload = self { return true }
        return false
    }

    /// What the page's `agentRun` `text` field carries, and the ONLY thing
    /// that ever fills it: the document's bytes, never a console transcript.
    /// Absent means there is nothing for the page to merge.
    public var pageText: String? {
        if case .merge(let diskText) = self { return diskText }
        return nil
    }
}

/// Where a finished `/ai` run's edit lands, as one pure function.
///
/// This is the extension's rule rather than a second one
/// (`src/agentBridge/askAgent.ts`, the tail of `askAgent`): a document with no
/// unsaved edits is reloaded and the page told there is nothing to merge; a
/// document the user changed during the run is never reloaded over, and gets
/// the file's bytes to merge around what they typed.
///
/// `handoff` is what the agent opened: the buffer as it was written to disk
/// immediately before the run started. It is the reference for both questions,
/// which is what keeps the answer independent of the autosave setting. Jot's
/// own `isEdited` flag cannot answer the second one, because with autosave on
/// it clears every time the debounce fires, so a burst typed during a run
/// reads as a buffer in step with the file.
public enum AgentLandingPolicy {
    public static func landing(handoff: String, onDisk: String, buffer: String) -> AgentLanding {
        // Nothing was written, so there is nothing to bring in and nothing to
        // merge, whatever the panel holds. Asked first because the other two
        // answers both assume the file moved.
        if onDisk == handoff { return .settle }
        if buffer != handoff { return .merge(diskText: onDisk) }
        return .reload
    }
}
