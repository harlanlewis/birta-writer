import BirtaWriterCore
import Foundation

/// The `PATH` a person's Terminal would give a command, read by running their
/// login shell and asking it.
///
/// `BirtaWriterCore.ShellPath` holds the reasoning and every decidable part of
/// this: which shell, which flags, and how the answer is fenced off from
/// whatever else an rc file prints. What is here is the one thing that cannot
/// be pure, which is running the shell.
///
/// Its one reader is the terminal command's row in Settings, which says
/// whether the directory `bwr` is linked into is on that `PATH`. So the shell
/// runs only when that row is in front of somebody with the command installed,
/// never at launch: running a person's whole startup arrangement is not free,
/// and most launches never open Settings. Every ask runs the shell again
/// rather than reusing an answer, because the answer is a fact about files the
/// person edits, and the reason they came back to Settings may be that they
/// just edited one.
///
/// Main-thread only. The shell runs on a background queue and the answer is
/// delivered back on the main queue, so the row that asked can redraw from it
/// directly.
final class LoginShellPath {
    static let shared = LoginShellPath()

    /// How long the shell gets before it is ended.
    ///
    /// A backstop against a startup file that blocks rather than a budget for
    /// a slow one. What it bounds is an rc file waiting for something that is
    /// not coming, which would otherwise hold a pipe for the rest of the
    /// session under a name nothing of ours would ever reap.
    static let defaultCap: TimeInterval = 4

    let cap: TimeInterval
    /// The shell to run, for a check that needs one that misbehaves. Nil is
    /// the person's own, which is the only thing the app ever passes.
    private let shellOverride: String?

    /// Who is waiting on the run in flight, or nil when none is. Several asks
    /// while one shell runs share its answer instead of starting more shells:
    /// a window coming forward redraws the row more than once.
    private var waiting: [(String?) -> Void]?
    /// Which run `waiting` belongs to, so an answer that arrives after its
    /// waiters were given up on is not handed to the next run's.
    private var generation = 0

    init(shell: String? = nil, cap: TimeInterval = LoginShellPath.defaultCap) {
        self.shellOverride = shell
        self.cap = cap
    }

    /// Run the shell, and hand `answer` its `PATH`, or nil when it did not
    /// say one, which the caller reads as "not known" rather than as "there
    /// is no PATH".
    func ask(_ answer: @escaping (String?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        if waiting != nil {
            waiting?.append(answer)
            return
        }
        waiting = [answer]
        generation += 1
        let thisRun = generation
        DispatchQueue.global(qos: .utility).async { [self] in
            let path = run()
            DispatchQueue.main.async { [self] in finish(thisRun, path) }
        }
        // The waiters are answered on time even when the run is not. Ending
        // the shell closes its end of the pipe, but anything it started that
        // inherited that pipe holds it open, and the read below would wait on
        // it for as long as that lives; without this, every later ask would
        // join a run that is never going to finish.
        DispatchQueue.main.asyncAfter(deadline: .now() + cap + 2) { [self] in
            finish(thisRun, nil)
        }
    }

    private func finish(_ run: Int, _ path: String?) {
        guard run == generation, let answers = waiting else { return }
        waiting = nil
        for answer in answers { answer(path) }
    }

    /// Run the shell and read its answer. Nil for anything that did not come
    /// back with a fenced value.
    private func run() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shellOverride
            ?? ShellPath.shell(fromEnvironment: ProcessInfo.processInfo.environment))
        process.arguments = ShellPath.arguments()
        let pipe = Pipe()
        process.standardOutput = pipe
        // Discarded rather than interleaved. An interactive shell writes
        // warnings and job-control chatter to stderr, and none of it is the
        // answer; the markers are what separate signal from noise on stdout.
        process.standardError = FileHandle.nullDevice
        // Nothing to read from, so a startup file that asks a question sees
        // EOF and moves on instead of waiting out the cap.
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        // TERM first, so a startup file can finish what it is doing, and then
        // KILL by this process's own id, because an interactive shell may
        // ignore a TERM and there is nothing here for it to clean up.
        let bound = DispatchWorkItem {
            guard process.isRunning else { return }
            process.terminate()
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + cap, execute: bound)
        // Read to EOF BEFORE waiting on exit, and in that order: a shell that
        // printed more than a pipe holds blocks on its next write, and a
        // reader that waits for exit first would be waiting for a process
        // that is waiting for it.
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        process.waitUntilExit()
        bound.cancel()
        guard let output = String(data: data, encoding: .utf8) else { return nil }
        return ShellPath.path(fromOutput: output)
    }
}
