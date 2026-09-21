import BirtaWriterCore
import Foundation

/// Runs one `/ai` request as a child process and reports what happened.
///
/// The shell is `/bin/sh -c`, and the request reaches it as a single quoted
/// argument built by `BirtaWriterCore.AgentRequest`, exactly as the extension
/// builds it. The working directory is the document's own folder, so a
/// relative `path.md#L12` reference resolves for the agent the same way it
/// does for the editor.
///
/// What this deliberately does NOT decide is where the edit lands. This runs
/// a child process and reads what it printed; it never sees the buffer, so it
/// cannot tell an edit typed during the run from one the agent made.
/// `Coordinator.finishAgentRun` asks `BirtaWriterCore.AgentLandingPolicy` that,
/// and is the only thing that fills a report's `text`.
@MainActor
final class AgentRunner {
    /// Runs in flight, so the panel can stop them and quitting can too.
    private var running: [String: Process] = [:]
    /// Each live run's corner line, keyed like `running` and ended with it.
    private var relays: [String: ProgressRelay] = [:]

    /// Whether a child process is still working.
    ///
    /// Asked by the unattended-update path, which is the one caller that quits
    /// the app on its own judgement rather than on somebody's word. A run can
    /// take minutes while the panel is hidden and the machine untouched, which
    /// is a state that looks exactly like nobody being there and is not: the
    /// app is working, and quitting kills the child mid-answer.
    var hasRunsInFlight: Bool { !running.isEmpty }

    /// The `PATH` every child gets, or nil to leave the environment alone.
    ///
    /// The person's own, not `launchd`'s. An app opened from the Finder
    /// inherits four system directories and nothing else, so every agent CLI
    /// is off it and the pane's promise that a tool installed and runnable
    /// from Terminal works here is false for everyone.
    /// `LoginShellPath` is what asks their shell; `BirtaWriterCore.ShellPath`
    /// holds the reasoning.
    ///
    /// A closure so a check can watch what actually reaches the child. Read
    /// the other way it is the only way to check this at all: the alternative
    /// is comparing two readings of the same machine, which agree with each
    /// other whether or not anything was applied.
    var childPath: () -> String? = { LoginShellPath.shared.childPath() }

    /// - Parameters:
    ///   - requestId: the webview's id for this run; every report carries it.
    ///   - line: the composed request line, already including its reference.
    ///   - template: the command template from Settings.
    ///   - workingDirectory: the document's folder.
    ///   - progress: one short line of what the run is doing, for the page's
    ///     corner notice (`agentProgress`), on the main actor. Throttled, never
    ///     repeated, and never called once the run has reported its end.
    ///   - report: status back to the page, on the main actor.
    func run(
        requestId: String,
        line: String,
        template: String,
        workingDirectory: URL,
        progress: @escaping (String) -> Void = { _ in },
        report: @escaping (AgentRunStatus) -> Void
    ) {
        let command = AgentRequest.expand(
            template: template, quotedPrompt: AgentRequest.shellQuote(line))
        let harness = AgentRequest.harnessName(from: template)

        // What the run is doing, read out of what the harness already prints
        // and adding nothing to the user's command: `AgentProgress.swift`. The
        // reader runs on the pipes' own queues, and only the lines it answers
        // cross to the main actor, in the order they were read.
        let feed = ProgressFeed()
        let relay = ProgressRelay(post: progress)
        let process = launch(
            command: command, workingDirectory: workingDirectory,
            // The relay is held weakly here as well, so the run's own
            // `relays` entry is its only owner and letting go of that ends the
            // line for good: see `ProgressRelay`.
            onChunk: { [weak self, weak relay] data, stream in
                guard let shown = feed.read(data, stream: stream) else { return }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        // A line for a run that has ended is not news, and one
                        // arriving after `done` would put a working notice back
                        // in the corner of a finished run.
                        guard let self, let relay, self.relays[requestId] === relay else { return }
                        relay.offer(shown)
                    }
                }
            }
        ) { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case let .couldNotStart(reason):
                // Nearly always a harness that is not installed. Say that
                // rather than the errno.
                self.end(requestId)
                report(.init(status: "failed", harness: harness, text: nil,
                             message: "Could not run \(harness ?? "the agent"): \(reason)"))
            case .signalled:
                guard self.end(requestId) != nil else { return }
                report(.init(status: "cancelled", harness: harness, text: nil, message: nil))
            case let .exited(status, output):
                // Already removed means `stop` reported it; a cancelled run
                // must not also report done.
                guard self.end(requestId) != nil else { return }
                if status == 0 {
                    report(.init(status: "done", harness: harness, text: nil, message: nil))
                } else {
                    report(.init(
                        status: "failed", harness: harness, text: nil,
                        message: Self.failureMessage(status: status, output: output,
                                                     harness: harness, feed: feed)))
                }
            }
        }
        guard let process else { return }
        running[requestId] = process
        relays[requestId] = relay
        report(.init(status: "running", harness: harness, text: nil, message: nil))
    }

    /// Forget a run, which is also what stops its corner line: letting go of
    /// the relay is what keeps a line queued behind the throttle from posting
    /// after the run's end has been reported. Answers the process when the run
    /// was still live.
    @discardableResult
    private func end(_ requestId: String) -> Process? {
        relays.removeValue(forKey: requestId)
        return running.removeValue(forKey: requestId)
    }

    /// Run the command once with a trivial prompt and hand back what it
    /// printed, for the Test button in Settings.
    ///
    /// Separate from `run` because it answers a different question and must
    /// not touch the note. A `/ai` run edits the document's own folder; this
    /// only asks whether the command in the field starts, authenticates and
    /// prints something, so it runs in a folder of its own that is removed
    /// afterwards. A tool that decides to write a file while saying hello
    /// writes it there.
    ///
    /// The transcript is the POINT here, unlike `AgentRunStatus.text`: the
    /// person who clicked Test wants to see what the tool said, and on a
    /// failure the tool's own error is the only thing that tells them what to
    /// fix. Nothing from here ever reaches the page.
    /// How long a test may take before the app stops waiting.
    ///
    /// Generous, because the tools this runs think for a while and a test that
    /// gave up early would report a working command as broken. It is a
    /// backstop rather than a policy: what it catches is a command that never
    /// returns at all, which would otherwise leave the button saying Testing
    /// for the rest of the session.
    static let probeTimeout: TimeInterval = 90

    func probe(template: String, report: @escaping (AgentProbeResult) -> Void) {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mac-agent-test-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            report(AgentProbeResult(succeeded: false, transcript: "",
                                    failure: error.localizedDescription))
            return
        }
        let command = AgentRequest.expand(
            template: template, quotedPrompt: AgentRequest.shellQuote(AgentRequest.probePrompt))
        // One report, whichever of the two arrives first. Without this a
        // command that answers just as the timeout fires reports twice, and
        // the sheet opens over a sheet.
        var reported = false
        let once: (AgentProbeResult) -> Void = { result in
            guard !reported else { return }
            reported = true
            try? FileManager.default.removeItem(at: directory)
            report(result)
        }
        let child = launch(command: command, workingDirectory: directory, onChunk: nil) { outcome in
            switch outcome {
            case let .exited(status, output):
                once(AgentProbeResult(
                    succeeded: status == 0, transcript: output,
                    failure: status == 0 ? nil : "The command exited with status \(status)."))
            case let .signalled(output):
                once(AgentProbeResult(succeeded: false, transcript: output,
                                      failure: "The command was stopped before it finished."))
            case let .couldNotStart(reason):
                once(AgentProbeResult(succeeded: false, transcript: "", failure: reason))
            }
        }
        guard let child else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.probeTimeout) {
            guard !reported, child.isRunning else { return }
            // SIGTERM, so the tool can clean up after itself. Its own
            // termination handler is what reports, through `once`.
            child.terminate()
            once(AgentProbeResult(
                succeeded: false, transcript: "",
                failure: "The command did not answer within "
                    + "\(Int(Self.probeTimeout)) seconds, so Birta Writer stopped waiting."))
        }
    }

    /// How a child process ended, as the three answers a caller can act on.
    enum LaunchOutcome {
        /// Ran and exited. The status is the shell's; the string is both
        /// streams, interleaved.
        case exited(status: Int32, output: String)
        /// Killed by a signal, which for us means `stop` terminated it.
        case signalled(output: String)
        /// Never started, which is nearly always a command that is not on
        /// PATH. The reason is the localized error.
        case couldNotStart(reason: String)
    }

    /// Start `/bin/sh -c command` and report how it ended, on the main actor.
    ///
    /// Returns the process for a caller that has to be able to stop it, and
    /// nil when it could not start, in which case `finished` has already run.
    ///
    /// Output is drained WHILE the child runs, not in the termination handler.
    /// A pipe holds about 64KB, and a child that fills it blocks on its next
    /// write; if the only reader waits for termination, termination never
    /// comes and the run hangs forever. An agent's transcript passes 64KB
    /// easily, so this is the ordinary case rather than a large one.
    ///
    /// `onChunk` sees every chunk of each stream as it arrives, tagged with the
    /// stream it came from, OFF the main actor. The two streams are two pipes
    /// rather than one for its sake: a progress reader keeps a partial line per
    /// stream, and one pipe can splice a stderr write into the middle of a
    /// stdout event line.
    @discardableResult
    private func launch(command: String, workingDirectory: URL,
                        onChunk: ((Data, AgentProgressReader.Stream) -> Void)?,
                        finished: @escaping @MainActor (LaunchOutcome) -> Void) -> Process? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = workingDirectory
        if let path = childPath() {
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = path
            process.environment = environment
        }
        // Two pipes, one transcript: the transcript is for the person reading
        // the failure, and interleaving is how they read it, so both streams
        // append to it in the order their chunks arrive.
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        // Nothing to read from. A CLI that decides to ask a question wants an
        // answer from a terminal that is not there, and inheriting the app's
        // stdin means it waits for one forever with its marker still spinning;
        // reading EOF, it gives up and exits, which is a failure somebody can
        // see and act on.
        process.standardInput = FileHandle.nullDevice

        let collected = Collected()
        let streams: [(pipe: Pipe, stream: AgentProgressReader.Stream)] =
            [(outPipe, .stdout), (errPipe, .stderr)]
        for (pipe, stream) in streams {
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                // Zero bytes is EOF; clearing the handler here is what lets the
                // file handle close rather than spinning on an empty pipe.
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                    return
                }
                collected.append(chunk)
                onChunk?(chunk, stream)
            }
        }

        process.terminationHandler = { ended in
            // Whatever arrived between the last readability callback and exit.
            var tail = Data()
            for (pipe, stream) in streams {
                let rest = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
                pipe.fileHandleForReading.readabilityHandler = nil
                if !rest.isEmpty { onChunk?(rest, stream) }
                tail.append(rest)
            }
            let output = collected.take(appending: tail)
            let reason = ended.terminationReason
            let status = ended.terminationStatus
            Task { @MainActor in
                finished(reason == .uncaughtSignal
                         ? .signalled(output: output)
                         : .exited(status: status, output: output))
            }
        }

        do {
            try process.run()
        } catch {
            finished(.couldNotStart(reason: error.localizedDescription))
            return nil
        }
        return process
    }

    /// Stop one run. SIGTERM, so the harness can clean up after itself.
    func stop(requestId: String, report: (AgentRunStatus) -> Void) {
        guard let process = end(requestId) else { return }
        process.terminate()
        report(.init(status: "cancelled", harness: nil, text: nil, message: nil))
    }

    /// Stop everything, for termination.
    func stopAll() {
        for (_, process) in running { process.terminate() }
        running.removeAll()
        relays.removeAll()
    }

    /// What a failed run says went wrong.
    ///
    /// A structured run prints its events on stdout, so the transcript's last
    /// line is JSON rather than a reason. There the reason is stderr's last
    /// line, which is where a run that failed before its first event has its
    /// cause, and otherwise what the harness last SAID; the extension's
    /// `askAgent` chooses between the same two. Anything else keeps the
    /// transcript's last line.
    private static func failureMessage(status: Int32, output: String, harness: String?,
                                       feed: ProgressFeed) -> String {
        let lastLine: (String) -> String = { text in
            text.split(whereSeparator: \.isNewline).last.map(String.init)?
                .trimmingCharacters(in: .whitespaces) ?? ""
        }
        let summary = feed.summary()
        let tail = summary.structured
            ? [lastLine(summary.stderr), summary.said ?? ""].first { !$0.isEmpty } ?? ""
            : lastLine(output)
        let name = harness ?? "The agent"
        return tail.isEmpty ? "\(name) exited with status \(status)." : tail
    }
}

/// One run's progress reader, fed from the two pipes' own queues.
///
/// The reader is not thread-safe and the two readability handlers can run at
/// once, so every touch is under the lock. It also keeps stderr's tail, which
/// a structured run's failure report quotes.
private final class ProgressFeed {
    private let lock = NSLock()
    private let reader = AgentProgressReader()
    private var stderrTail = Data()
    /// Enough for a last line and no more: this lives as long as the run.
    private static let tailBytes = 4096

    func read(_ chunk: Data, stream: AgentProgressReader.Stream) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if stream == .stderr {
            stderrTail.append(chunk)
            if stderrTail.count > Self.tailBytes {
                stderrTail = Data(stderrTail.suffix(Self.tailBytes))
            }
        }
        return reader.read(chunk, stream: stream)
    }

    func summary() -> (structured: Bool, stderr: String, said: String?) {
        lock.lock()
        defer { lock.unlock() }
        return (reader.isStructured, String(decoding: stderrTail, as: UTF8.self), reader.lastSaid)
    }
}

/// One run's corner line on its way to the page: at most one per window,
/// leading edge then trailing, and never the same line twice
/// (`BirtaWriterCore.AgentProgressThrottle` holds that decision).
///
/// The run OWNS it, through `AgentRunner.relays`, and the window's timer holds
/// it weakly. So dropping it is what stops the line: a run whose end has been
/// reported has already let go, and the line queued behind the throttle dies
/// with it rather than putting a working notice back in a finished run's
/// corner. Nothing else keeps it alive, which is why that `weak` is the
/// mechanism and not a precaution.
@MainActor
private final class ProgressRelay {
    private var throttle = AgentProgressThrottle()
    private let post: (String) -> Void

    init(post: @escaping (String) -> Void) {
        self.post = post
    }

    func offer(_ line: String) {
        guard let now = throttle.offer(line) else { return }
        send(now)
    }

    private func send(_ line: String) {
        post(line)
        DispatchQueue.main.asyncAfter(deadline: .now() + AgentProgressThrottle.window) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let next = self.throttle.windowClosed() else { return }
                self.send(next)
            }
        }
    }
}

/// What the Test button in Settings found out.
///
/// A transcript rather than a sentence, because the question it answers is
/// "what did the tool say". `failure` is the app's own summary of how it ended,
/// and it is nil exactly when the command exited cleanly.
struct AgentProbeResult {
    let succeeded: Bool
    /// Both streams, interleaved, exactly as the child printed them.
    let transcript: String
    /// How it went wrong, in our words. Nil on success.
    let failure: String?
}

/// One report about a run, in the shape the page's `agentRun` message takes.
struct AgentRunStatus {
    let status: String
    let harness: String?
    /// The DOCUMENT's bytes, for the page to merge around whatever was typed
    /// while the run was live, and nothing else. `AgentRunner` always leaves
    /// this nil: it watches a child process rather than the buffer, so it
    /// cannot answer the question this field is the answer to. The one filler
    /// is `Coordinator.finishAgentRun`, through `merging(_:)`.
    ///
    /// A console transcript must never reach it. The page treats what arrives
    /// here as the file and merges it into the note.
    let text: String?
    let message: String?

    /// The same report, carrying the file's bytes for the page's merge.
    func merging(_ diskText: String) -> AgentRunStatus {
        AgentRunStatus(status: status, harness: harness, text: diskText, message: message)
    }
}


/// A byte buffer two queues touch: the readability handler fills it off a
/// background queue while the termination handler drains it on another. Small
/// and lock-based on purpose; the alternative is an actor, and the readability
/// handler is not async.
private final class Collected {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock()
        data.append(chunk)
        lock.unlock()
    }

    func take(appending tail: Data) -> String {
        lock.lock()
        data.append(tail)
        let all = data
        lock.unlock()
        return String(data: all, encoding: .utf8) ?? ""
    }
}
