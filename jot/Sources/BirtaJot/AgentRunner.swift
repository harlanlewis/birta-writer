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
/// What this deliberately does NOT do, and what the extension does instead:
/// there is no merge of the agent's edit around what you typed while it ran.
/// Jot reloads the file when the run finishes, so an edit made in the panel
/// during a run is the losing side. That is a real difference and the reason
/// `jot/README.md` says so rather than leaving it to be discovered; the merge
/// engine lives in the extension's TypeScript and porting it is a larger job
/// than making the feature reachable.
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

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = workingDirectory
        // Both streams to one pipe: the transcript is for the person reading
        // the failure, and interleaving is how they read it.
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        // Drained WHILE the child runs, not in the termination handler.
        // A pipe holds about 64KB, and a child that fills it blocks on its
        // next write; if the only reader waits for termination, termination
        // never comes and the run hangs forever with its marker still
        // spinning. An agent's transcript passes 64KB easily, so this is the
        // ordinary case rather than a large one. Verified by reproduction: a
        // child writing 400KB against a read-at-termination handler never
        // finishes.
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

        process.terminationHandler = { [weak self] finished in
            // Whatever arrived between the last readability callback and exit.
            let tail = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
            pipe.fileHandleForReading.readabilityHandler = nil
            let output = collected.take(appending: tail)
            Task { @MainActor [weak self] in
                guard let self, self.running.removeValue(forKey: requestId) != nil else {
                    // Already removed means `stop` reported it; a cancelled run
                    // must not also report done.
                    return
                }
                if finished.terminationReason == .uncaughtSignal {
                    report(.init(status: "cancelled", harness: harness, text: nil, message: nil))
                } else if finished.terminationStatus == 0 {
                    report(.init(status: "done", harness: harness, text: output, message: nil))
                } else {
                    report(.init(
                        status: "failed", harness: harness, text: output,
                        message: Self.failureMessage(status: finished.terminationStatus,
                                                     output: output, harness: harness)))
                }
            }
        }

        do {
            try process.run()
        } catch {
            // The command could not start at all, which is nearly always a
            // harness that is not installed. Say that rather than the errno.
            report(.init(status: "failed", harness: harness, text: nil,
                         message: "Could not run \(harness ?? "the agent"): \(error.localizedDescription)"))
            return
        }
        running[requestId] = process
        report(.init(status: "running", harness: harness, text: nil, message: nil))
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

/// One report about a run, in the shape the page's `agentRun` message takes.
struct AgentRunStatus {
    let status: String
    let harness: String?
    let text: String?
    let message: String?
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
