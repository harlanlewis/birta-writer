import BirtaWriterCore
import Foundation

/// The `PATH` a person's Terminal would give a command, resolved once per
/// launch by running their login shell and asking it.
///
/// `BirtaWriterCore.ShellPath` holds the reasoning and every decidable part of
/// this: which shell, which flags, how the answer is fenced off from whatever
/// else an rc file prints, and how it merges with what the app already had.
/// What is here is the one thing that cannot be pure, which is running the
/// shell, plus the scheduling around it.
///
/// Resolved EAGERLY at launch, on a background queue, because a shell that
/// reads somebody's whole startup arrangement is not fast and the alternative
/// is paying for it in front of a person who has just clicked Test. By the
/// time any agent run is possible a human has had to reach a menu or a button,
/// so `value()` finds the answer already there and does not wait at all.
///
/// It still waits, with a cap, rather than falling back the moment it is not
/// ready. Falling back would make the FIRST run after launch the one that
/// reports an installed tool as missing, and that run is the Test button,
/// whose entire job is to tell the truth about exactly that.
final class LoginShellPath {
    static let shared = LoginShellPath()

    /// The longest `value` will wait for a shell that has not answered.
    ///
    /// A backstop against a startup file that blocks rather than a budget for
    /// a slow one: the wait is normally already over. What it bounds is an rc
    /// file that waits for something that is not coming, in which case the
    /// app carries on with the `PATH` it was launched with rather than
    /// hanging on the way to a child process.
    static let defaultWaitCap: TimeInterval = 4

    let waitCap: TimeInterval
    /// The shell to run, for a check that needs one that misbehaves. Nil is
    /// the person's own, which is the only thing the app ever passes.
    private let shellOverride: String?

    init(shell: String? = nil, waitCap: TimeInterval = LoginShellPath.defaultWaitCap) {
        self.shellOverride = shell
        self.waitCap = waitCap
    }

    /// One condition rather than a semaphore, because there can be more than
    /// one waiter and a semaphore counts permits: a waiter that timed out
    /// would either eat the permit the next one needed or have to hand back a
    /// permit that then lets a later waiter through early with nothing
    /// resolved. A broadcast wakes every waiter on the one thing that actually
    /// changed, which is `finished`.
    private let state = NSCondition()
    private var started = false
    private var finished = false
    private var resolved: String?

    /// Start resolving, at most once. Safe to call from anywhere, and returns
    /// immediately.
    func prewarm() {
        state.lock()
        let alreadyStarted = started
        started = true
        state.unlock()
        guard !alreadyStarted else { return }
        DispatchQueue.global(qos: .utility).async { [self] in
            let answer = ask()
            state.lock()
            resolved = answer
            finished = true
            state.broadcast()
            state.unlock()
        }
    }

    /// The `PATH` to give a child, or nil to leave the environment alone.
    ///
    /// Merged rather than substituted, so a directory the app was launched
    /// with is never taken away by a shell that did not mention it.
    func childPath(inherited: String? = ProcessInfo.processInfo.environment["PATH"]) -> String? {
        ShellPath.childPath(resolved: value(), inherited: inherited)
    }

    /// What the shell said, waiting for it if it has not said it yet.
    private func value() -> String? {
        prewarm()
        state.lock()
        defer { state.unlock() }
        // A deadline computed ONCE, outside the loop. `wait(until:)` can
        // return without a broadcast, so the loop is what makes this correct;
        // recomputing the deadline inside it would restart the cap on every
        // one of those and turn a bounded wait into an unbounded one.
        let deadline = Date(timeIntervalSinceNow: waitCap)
        while !finished {
            guard state.wait(until: deadline) else { break }
        }
        return resolved
    }

    /// Run the shell and read its answer. Nil for anything that did not come
    /// back with a fenced value, which the caller treats as "keep what we
    /// have" rather than as "there is no PATH".
    private func ask() -> String? {
        let environment = ProcessInfo.processInfo.environment
        let process = Process()
        process.executableURL = URL(
            fileURLWithPath: shellOverride ?? ShellPath.shell(fromEnvironment: environment))
        process.arguments = ShellPath.arguments()
        let pipe = Pipe()
        process.standardOutput = pipe
        // Discarded rather than interleaved. An interactive shell writes
        // warnings and job-control chatter to stderr, and none of it is the
        // answer; the markers are what separate signal from noise on stdout,
        // and stderr has nothing to contribute to that.
        process.standardError = FileHandle.nullDevice
        // Nothing to read from, so a startup file that asks a question sees
        // EOF and moves on instead of waiting out the cap above.
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        // The shell is bounded too, not just the wait for it. Giving up on the
        // answer leaves whoever asked with a usable `PATH`; it does nothing
        // about the shell, which would otherwise sit there holding a pipe for
        // the rest of the session, under a name nothing of ours would ever
        // reap. TERM first, so a startup file can finish what it is doing, and
        // then KILL by this process's own id, because an interactive shell may
        // ignore a TERM and there is nothing here for it to clean up.
        let bound = DispatchWorkItem {
            guard process.isRunning else { return }
            process.terminate()
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + waitCap, execute: bound)
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
