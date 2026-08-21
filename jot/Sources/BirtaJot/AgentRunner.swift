import BirtaJotCore
import Foundation

/// Runs one `/ai` request as a child process and reports what happened.
///
/// The shell is `/bin/sh -c`, and the request reaches it as a single quoted
/// argument built by `BirtaJotCore.AgentRequest`, exactly as the extension
/// builds it. The working directory is the document's own folder, so a
/// relative `path.md#L12` reference resolves for the agent the same way it
/// does for the editor.
///
/// What this deliberately does NOT decide is where the edit lands. This runs
/// a child process and reads what it printed; it never sees the buffer, so it
/// cannot tell an edit typed during the run from one the agent made.
/// `Coordinator.finishAgentRun` asks `BirtaJotCore.AgentLandingPolicy` that,
/// and is the only thing that fills a report's `text`.
@MainActor
final class AgentRunner {
    /// Runs in flight, so the panel can stop them and quitting can too.
    private var running: [String: Process] = [:]

    /// - Parameters:
    ///   - requestId: the webview's id for this run; every report carries it.
    ///   - line: the composed request line, already including its reference.
    ///   - template: the command template from Settings.
    ///   - workingDirectory: the document's folder.
    ///   - report: status back to the page, on the main actor.
    func run(
        requestId: String,
        line: String,
        template: String,
        workingDirectory: URL,
        report: @escaping (AgentRunStatus) -> Void
    ) {
        let command = AgentRequest.expand(
            template: template, quotedPrompt: AgentRequest.shellQuote(line))
        let harness = AgentRequest.harnessName(from: template)

        let process = launch(command: command, workingDirectory: workingDirectory) {
            [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case let .couldNotStart(reason):
                // Nearly always a harness that is not installed. Say that
                // rather than the errno.
                self.running.removeValue(forKey: requestId)
                report(.init(status: "failed", harness: harness, text: nil,
                             message: "Could not run \(harness ?? "the agent"): \(reason)"))
            case .signalled:
                guard self.running.removeValue(forKey: requestId) != nil else { return }
                report(.init(status: "cancelled", harness: harness, text: nil, message: nil))
            case let .exited(status, output):
                // Already removed means `stop` reported it; a cancelled run
                // must not also report done.
                guard self.running.removeValue(forKey: requestId) != nil else { return }
                if status == 0 {
                    report(.init(status: "done", harness: harness, text: nil, message: nil))
                } else {
                    report(.init(
                        status: "failed", harness: harness, text: nil,
                        message: Self.failureMessage(status: status, output: output,
                                                     harness: harness)))
                }
            }
        }
        guard let process else { return }
        running[requestId] = process
        report(.init(status: "running", harness: harness, text: nil, message: nil))
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
    /// How long a test may take before Jot stops waiting.
    ///
    /// Generous, because the tools this runs think for a while and a test that
    /// gave up early would report a working command as broken. It is a
    /// backstop rather than a policy: what it catches is a command that never
    /// returns at all, which would otherwise leave the button saying Testing
    /// for the rest of the session.
    static let probeTimeout: TimeInterval = 90

    func probe(template: String, report: @escaping (AgentProbeResult) -> Void) {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("jot-agent-test-\(UUID().uuidString)")
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
        let child = launch(command: command, workingDirectory: directory) { outcome in
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
    @discardableResult
    private func launch(command: String, workingDirectory: URL,
                        finished: @escaping @MainActor (LaunchOutcome) -> Void) -> Process? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = workingDirectory
        // Both streams to one pipe: the transcript is for the person reading
        // the failure, and interleaving is how they read it.
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        // Nothing to read from. A CLI that decides to ask a question wants an
        // answer from a terminal that is not there, and inheriting the app's
        // stdin means it waits for one forever with its marker still spinning;
        // reading EOF, it gives up and exits, which is a failure somebody can
        // see and act on.
        process.standardInput = FileHandle.nullDevice

        let collected = Collected()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            // Zero bytes is EOF; clearing the handler here is what lets the
            // file handle close rather than spinning on an empty pipe.
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            collected.append(chunk)
        }

        process.terminationHandler = { ended in
            // Whatever arrived between the last readability callback and exit.
            let tail = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
            pipe.fileHandleForReading.readabilityHandler = nil
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
        guard let process = running.removeValue(forKey: requestId) else { return }
        process.terminate()
        report(.init(status: "cancelled", harness: nil, text: nil, message: nil))
    }

    /// Stop everything, for termination.
    func stopAll() {
        for (_, process) in running { process.terminate() }
        running.removeAll()
    }

    private static func failureMessage(status: Int32, output: String, harness: String?) -> String {
        let tail = output.split(separator: "\n").last.map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        let name = harness ?? "The agent"
        return tail.isEmpty ? "\(name) exited with status \(status)." : tail
    }
}

/// What the Test button in Settings found out.
///
/// A transcript rather than a sentence, because the question it answers is
/// "what did the tool say". `failure` is Jot's own summary of how it ended,
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
