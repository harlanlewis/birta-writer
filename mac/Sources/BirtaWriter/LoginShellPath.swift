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

    /// How long a run may take, after which it is answered with nothing and
    /// the shell is ended.
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
        DispatchQueue.global(qos: .utility).async { [self] in
            let path = run()
            DispatchQueue.main.async { [self] in
                let answers = waiting ?? []
                waiting = nil
                for answer in answers { answer(path) }
            }
        }
    }

    /// Run the shell and read its answer, returning within `cap` whatever the
    /// shell does. Nil for anything that did not come back with a fenced value.
    ///
    /// The output is read as it arrives and the read stops at the closing
    /// fence, at end of file, or at the cap, whichever is first. Not a read to
    /// end of file: anything the shell starts in the background inherits the
    /// pipe, and a daemon an rc file launches can hold it open for as long as
    /// it lives, which would leave this run, and every ask waiting on it,
    /// waiting with it.
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

        let lock = NSLock()
        var output = Data()
        let settled = DispatchSemaphore(value: 0)
        let fence = Data(ShellPath.closeMarker.utf8)
        let reader = pipe.fileHandleForReading
        reader.readabilityHandler = { handle in
            let chunk = handle.availableData
            lock.lock()
            defer { lock.unlock() }
            output.append(chunk)
            if chunk.isEmpty || output.range(of: fence) != nil {
                handle.readabilityHandler = nil
                settled.signal()
            }
        }
        do {
            try process.run()
        } catch {
            reader.readabilityHandler = nil
            return nil
        }
        let deadline = DispatchTime.now() + cap
        _ = settled.wait(timeout: deadline)
        reader.readabilityHandler = nil
        try? reader.close()
        // The shell normally exits on its own a moment after it has printed,
        // and is given until the deadline to. One still running then is
        // ended: TERM first, so a startup file can finish what it is doing,
        // then KILL by this process's own id, because an interactive shell
        // may ignore a TERM.
        while process.isRunning, DispatchTime.now() < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        if process.isRunning {
            process.terminate()
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
        lock.lock()
        defer { lock.unlock() }
        return ShellPath.path(fromOutput: String(decoding: output, as: UTF8.self))
    }
}
