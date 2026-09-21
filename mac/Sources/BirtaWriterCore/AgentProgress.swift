import Foundation

/// What a live `/ai` run is doing, as one short line, read out of whatever the
/// harness is already printing. A literal port of
/// `src/agentBridge/agentProgress.ts` (MAR-474); that file's header carries the
/// reasoning, and both are held to the same cases in
/// `shared/__fixtures__/agentProgressCases.json`.
///
/// The line is advisory and transient: it never reaches the document or the
/// view-state bag, and it dies with the run that produced it. Nothing here
/// writes anywhere.
///
/// Harnesses are told apart by the SHAPE of what they print, never by name:
/// content-block streams (Claude Code's `--output-format stream-json
/// --verbose`), item streams (`codex exec --json`), and the last plain line of
/// anything else.
///
/// REASONING CONTENT IS NEVER RENDERED. A thinking step is the word `Thinking`,
/// never its text. The corner is not a transcript.
///
/// One thing here is NOT part of the port and must not be looked for on the
/// other side: `transcriptLines`, which reads a FINISHED transcript for the
/// Mac app's Settings Test button. The extension has no such button, so there
/// is nothing there for it to drift from. It reuses the port's own reading
/// whole (`classify`) and only takes a different view of the answer, which is
/// what keeps the recognition written once.
///
/// Where the port differs, and why the cases cannot see it:
/// - Partial lines are held as BYTES and split on the CR and LF bytes, which
///   never occur inside a multi-byte UTF-8 sequence, so a character split
///   across two pipe reads is decoded whole. The extension decodes each chunk
///   on its own. The unbounded-line cap counts those bytes, where the
///   extension counts UTF-16 units; the two agree on ASCII.
/// - `clamp` cuts at a character boundary, so it never splits a surrogate pair
///   the way a UTF-16 `slice` can; lengths are still counted in UTF-16, as the
///   extension counts them. Its whitespace collapse is ICU's `\s` against the
///   extension's JavaScript `\s`, which differ on two characters nobody's
///   output has yet carried: ICU counts U+0085, JavaScript counts U+FEFF.
public final class AgentProgressReader {
    /// A display line is a glance, not a transcript.
    public static let lineMax = 72
    /// The harness's own last words, kept for the reports that quote them.
    static let saidMax = 400
    /// A stream that never sends a newline is not buffered without bound.
    static let maxPending = 64 * 1024

    /// Which stream a chunk came from; each keeps its own partial line.
    public enum Stream: String {
        case stdout, stderr
    }

    private var pending: [Stream: Data] = [.stdout: Data(), .stderr: Data()]
    /// Whether this run printed events in a shape this reader knows.
    public private(set) var isStructured = false
    /// The harness's own last words, when the stream carried them. What a
    /// failure report quotes instead of a tail of JSON.
    public private(set) var lastSaid: String?

    public init() {}

    /// Feed one chunk of text. Answers the newest line worth showing, or nil
    /// when the chunk said nothing new.
    public func read(_ chunk: String, stream: Stream) -> String? {
        read(Data(chunk.utf8), stream: stream)
    }

    /// Feed one chunk of bytes, as a pipe hands it over.
    ///
    /// Intermediate lines inside one chunk are dropped rather than queued: the
    /// corner shows what is happening now.
    public func read(_ chunk: Data, stream: Stream) -> String? {
        var buffer = pending[stream] ?? Data()
        buffer.append(chunk)
        var latest: String?
        var start = buffer.startIndex
        var index = buffer.startIndex
        // A bare CR is a redraw rather than a continuation, so a progress bar
        // becomes one line per frame. CRLF yields an empty line between the
        // two, which reduces to nothing.
        while index < buffer.endIndex {
            let byte = buffer[index]
            if byte == 0x0A || byte == 0x0D {
                let raw = String(decoding: buffer[start..<index], as: UTF8.self)
                if let line = reduce(raw) { latest = line }
                start = buffer.index(after: index)
            }
            index = buffer.index(after: index)
        }
        let remainder = Data(buffer[start..<buffer.endIndex])
        pending[stream] = remainder.count > Self.maxPending ? Data() : remainder
        return latest
    }

    /// Where a harness's output breaks into lines: at CR and at LF, and
    /// nowhere else.
    ///
    /// The same rule `read` applies to bytes, so the corner and the Test sheet
    /// cut the stream in the same places. Swift's own `isNewline` is the wrong
    /// rule here and fails on real output: it also breaks on U+2028, U+0085,
    /// U+000B and U+000C, and U+2028 is legal RAW inside a JSON string, so an
    /// event carrying one arrives as two halves that parse as nothing and the
    /// sheet shows the JSON a reader was never meant to see. Splitting by
    /// `Character` is wrong in the other direction, because CRLF is one
    /// Character and matches neither of the two this breaks on.
    static func rawLines(_ text: String) -> [String] {
        text.unicodeScalars
            .split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r" })
            .map { String(String.UnicodeScalarView($0)) }
    }

    /// One line of a harness's output, told apart ONCE.
    ///
    /// The corner and a finished transcript read the same output and want
    /// different things from it, and the part that must not be written twice
    /// is the recognition: which shapes exist, and what an event of one says.
    /// What each caller then does with the answer is its own policy.
    private enum Reduced {
        /// A structured event in a shape this reader knows: the line it is
        /// worth showing (nil for an event that says nothing), and the
        /// harness's own words where it spoke, unclamped and uncut.
        case event(line: String?, said: String?)
        /// Anything else, with the terminal's own drawing already taken out.
        case plain(String)
    }

    /// Classify one raw line, or nil when there was nothing on it.
    private func classify(_ raw: String) -> Reduced? {
        let text = Self.plainLine(raw)
        if text.isEmpty { return nil }
        if text.hasPrefix("{"), let event = Self.parse(text),
           let shape = Shape.allCases.first(where: { $0.recognizes(event) }) {
            isStructured = true
            var spoken: String?
            let line = shape.display(event) { said in
                spoken = said
                self.lastSaid = Self.clamp(said, Self.saidMax)
            }
            return .event(line: line, said: spoken)
        }
        return .plain(text)
    }

    private func reduce(_ raw: String) -> String? {
        switch classify(raw) {
        case .none: return nil
        case let .event(line, _): return line
        case let .plain(text): return isStructured ? nil : Self.clamp(text, Self.lineMax)
        }
    }

    /// A FINISHED transcript as a person reads it, or nil when it carried no
    /// structured event and what the harness printed is already prose.
    ///
    /// For the Mac app's Settings Test button, which prints what a command
    /// said and now runs commands that print events. The corner's reading is
    /// reused whole; three things differ, each because a sheet is not a
    /// glance:
    ///
    /// - every line is kept, not only the newest of a chunk;
    /// - a text block is kept WHOLE rather than cut to its opening line and
    ///   clamped, because what the tool said is what the reader came for;
    /// - a plain line SURVIVES a structured stream instead of being dropped.
    ///   That last one is load-bearing: a run that emitted events and then
    ///   failed says why on stderr, in prose, and the corner's rule (a glance
    ///   showing stray output beside events reads as noise) would throw away
    ///   the one sentence the reader can act on.
    ///
    /// Nil rather than the lines, so a caller holding a plain transcript shows
    /// the bytes the child printed rather than a reconstruction of them.
    public static func transcriptLines(_ transcript: String) -> [String]? {
        let reader = AgentProgressReader()
        var lines: [String] = []
        for raw in Self.rawLines(transcript) {
            guard let reduced = reader.classify(raw) else { continue }
            let shown: String?
            switch reduced {
            case let .event(line, said): shown = said ?? line
            case let .plain(text): shown = text
            }
            // Never the same line twice in a row, which is the throttle's own
            // rule applied without a clock: three thinking events in a row are
            // one `Thinking` to a reader either way.
            guard let shown, !shown.isEmpty, shown != lines.last else { continue }
            lines.append(shown)
        }
        return reader.isStructured ? lines : nil
    }

    // MARK: shapes

    /// `recognizes` is deliberately separate from `display`: an event whose
    /// shape is known but which says nothing (a session opening, a turn
    /// ending) still proves the stream is structured, and that is what
    /// silences the plain fallback.
    enum Shape: CaseIterable {
        /// An envelope per message carrying `content` blocks of `text`,
        /// `tool_use` or `thinking`, every event stamped with its session.
        case contentBlocks
        /// A flat event per thread, turn and item, the item carrying its kind.
        case items

        func recognizes(_ event: [String: Any]) -> Bool {
            guard let type = event["type"] as? String else { return false }
            switch self {
            case .contentBlocks:
                return event["session_id"] is String
            case .items:
                return type.hasPrefix("item.") || type.hasPrefix("turn.") || type.hasPrefix("thread.")
            }
        }

        func display(_ event: [String: Any], said: (String) -> Void) -> String? {
            switch self {
            case .contentBlocks: return Self.contentBlockLine(event, said: said)
            case .items: return Self.itemLine(event, said: said)
            }
        }

        private static func contentBlockLine(_ event: [String: Any], said: (String) -> Void) -> String? {
            let type = event["type"] as? String
            if type == "system" {
                // The only system event worth a line says a model is thinking;
                // its token count is a number nobody can act on.
                return event["subtype"] as? String == "thinking_tokens" ? AgentProgressReader.thinkingWord : nil
            }
            guard type == "assistant", let message = event["message"] as? [String: Any],
                  let content = message["content"] as? [Any] else { return nil }
            var line: String?
            for case let block as [String: Any] in content {
                switch block["type"] as? String {
                case "thinking":
                    // The word, never the content.
                    line = AgentProgressReader.thinkingWord
                case "text":
                    guard let text = AgentProgressReader.str(block["text"]) else { continue }
                    said(text)
                    line = AgentProgressReader.clamp(AgentProgressReader.opening(text), AgentProgressReader.lineMax)
                case "tool_use":
                    if let name = AgentProgressReader.str(block["name"]) {
                        line = AgentProgressReader.clamp(
                            AgentProgressReader.toolLine(name, block["input"]), AgentProgressReader.lineMax)
                    }
                default:
                    continue
                }
            }
            return line
        }

        private static func itemLine(_ event: [String: Any], said: (String) -> Void) -> String? {
            guard let item = event["item"] as? [String: Any] else { return nil }
            switch item["type"] as? String {
            case "agent_message":
                guard let text = AgentProgressReader.str(item["text"]) else { return nil }
                said(text)
                return AgentProgressReader.clamp(AgentProgressReader.opening(text), AgentProgressReader.lineMax)
            case "command_execution":
                guard let command = AgentProgressReader.str(item["command"]) else { return nil }
                return AgentProgressReader.clamp("Running \(command)", AgentProgressReader.lineMax)
            case "file_change":
                guard let changes = item["changes"] as? [Any] else { return nil }
                let paths = changes.compactMap { change in
                    (change as? [String: Any]).flatMap { AgentProgressReader.str($0["path"]) }
                }
                if paths.isEmpty { return nil }
                return paths.count == 1
                    ? AgentProgressReader.clamp("Editing \(AgentProgressReader.basename(paths[0]))", AgentProgressReader.lineMax)
                    : "Editing \(paths.count) files"
            default:
                return nil
            }
        }
    }

    /// What a thinking step is shown as, whatever it carried.
    static let thinkingWord = "Thinking"

    // MARK: text

    /// The inputs a tool call is named by, in the order a caller would read
    /// them. Generic key names rather than a tool list.
    static let pathKeys = ["file_path", "path"]
    static let phraseKeys = ["command", "pattern", "url", "query"]

    /// CSI and OSC sequences, which a harness drawing a progress bar emits freely.
    private static let ansi = try! NSRegularExpression(
        pattern: #"\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)"#)
    /// C0 controls other than tab, which survive the ANSI strip as mojibake.
    private static let controls = try! NSRegularExpression(
        pattern: #"[\u0000-\u0008\u000B-\u001F\u007F]"#)
    private static let whitespaceRun = try! NSRegularExpression(pattern: #"\s+"#)

    private static func replacing(_ regex: NSRegularExpression, in text: String, with template: String) -> String {
        regex.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    /// One line of prose, with the terminal's own drawing taken out.
    public static func plainLine(_ raw: String) -> String {
        replacing(controls, in: replacing(ansi, in: raw, with: ""), with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `text`, whitespace collapsed, cut to `max` UTF-16 units with an
    /// ellipsis when it does not fit.
    static func clamp(_ text: String, _ max: Int) -> String {
        let collapsed = replacing(whitespaceRun, in: text, with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if collapsed.utf16.count <= max { return collapsed }
        var kept = ""
        var units = 0
        for character in collapsed {
            let width = character.utf16.count
            if units + width > max - 1 { break }
            kept.append(character)
            units += width
        }
        while let last = kept.last, last.isWhitespace { kept.removeLast() }
        return kept + "…"
    }

    /// The last path segment, so a corner line says the file rather than the tree.
    static func basename(_ path: String) -> String {
        path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    }

    /// The first non-blank line of a block of prose.
    static func opening(_ text: String) -> String {
        text.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? ""
    }

    /// A string with something in it, trimmed; nil for anything else.
    static func str(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// What a tool call is named by: its own name, plus the input that identifies it.
    static func toolLine(_ name: String, _ input: Any?) -> String {
        guard let input = input as? [String: Any] else { return name }
        for key in pathKeys {
            if let value = str(input[key]) { return "\(name) \(basename(value))" }
        }
        for key in phraseKeys {
            if let value = str(input[key]) { return "\(name) \(value)" }
        }
        return name
    }

    /// A JSON object, or nil for anything else: prose, as far as this reader
    /// is concerned.
    static func parse(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

/// No more than one progress line per run per window, leading edge then
/// trailing, and never the same line twice in a row. A port of `sendProgress`
/// in `src/agentBridge/askAgent.ts`; the timer is the caller's, so this holds
/// only the decision and a test can drive it without a clock.
public struct AgentProgressThrottle {
    /// The window, in seconds. The extension's `PROGRESS_THROTTLE_MS`.
    public static let window: TimeInterval = 0.4

    private var sent: String?
    private var queued: String?
    private var windowOpen = false

    public init() {}

    /// Offer a line. Answers it when it should be sent NOW, in which case the
    /// caller posts it and starts a window; nil when it was queued or is not
    /// news.
    ///
    /// The comparison is against what will be shown NEXT, the queued line when
    /// there is one, so A then B then A inside one window ends on A rather
    /// than on a B the run has already moved past.
    public mutating func offer(_ line: String) -> String? {
        if line == (queued ?? sent) { return nil }
        if windowOpen {
            queued = line
            return nil
        }
        sent = line
        windowOpen = true
        return line
    }

    /// The window has closed. Answers the queued line when there is one worth
    /// sending, in which case a new window has opened for it.
    public mutating func windowClosed() -> String? {
        windowOpen = false
        guard let next = queued else { return nil }
        queued = nil
        return offer(next)
    }
}
