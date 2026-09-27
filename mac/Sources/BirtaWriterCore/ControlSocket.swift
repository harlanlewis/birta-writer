import Darwin
import Foundation

/// The channel a waiting `bwr --wait` and the app talk over, and what they
/// say on it.
///
/// Everything else the command does ends in `open(1)` handing a file to the
/// app, and `open(1)` cannot carry an answer back. `--wait` needs one: the
/// shell has to block until the document is closed and the bytes have landed,
/// and then learn whether that is what happened. So the app listens on a Unix
/// domain socket and the command connects to it, names the file it is waiting
/// on, and reads one line back.
///
/// A socket rather than a URL scheme, and the socket is under the user's own
/// Application Support at mode 0600. Any process running as the user can
/// already run `bwr`, so a socket only such a process can connect to adds no
/// reach; a registered URL scheme is reachable from any web page, and the
/// payload here is a local file path.
///
/// This file is both ends' one definition of the path, the wire form and the
/// rule for when a wait ends, for the reason `CliInvocation.summonArgument`
/// gives: the command and the app are separate programs, neither can see the
/// other's spelling, and a literal at each end can be renamed apart with every
/// test green. `Waits` is the app's half as a value with no socket in it, so
/// the whole table of what ends a wait, and with what answer, is decidable in
/// a test that opens nothing.
public enum ControlSocket {
    // MARK: where it is

    public static let fileName = "control.sock"

    /// Where the socket lives: in the app's own folder under Application
    /// Support, named by the flavour, so a development build and the release
    /// listen on two sockets and a command belonging to one cannot wait on the
    /// other's windows.
    public static func url(support: URL, flavour: AppFlavor) -> URL {
        support
            .appendingPathComponent(flavour.displayName, isDirectory: true)
            .appendingPathComponent(fileName)
    }

    /// The Application Support folder the two programs meet in.
    ///
    /// `BIRTA_MAC_CLI_SUPPORT` names a throwaway one for a checking run, and
    /// BOTH ends read it: a check that pointed the command at a folder the app
    /// was not listening in would wait on nothing. `standard` supplies the
    /// user's real one, which is a `FileManager` lookup and is injected so the
    /// rule is checkable without one.
    public static func supportDirectory(environment: [String: String],
                                        standard: () -> URL?) -> URL? {
        if let named = environment["BIRTA_MAC_CLI_SUPPORT"], !named.isEmpty {
            return URL(fileURLWithPath: named, isDirectory: true)
        }
        return standard()
    }

    /// The longest path a socket can be bound at.
    ///
    /// `sockaddr_un.sun_path` is a fixed buffer, and a longer path is not
    /// truncated by `bind` but refused by the caller here, by name: the
    /// alternative, `strncpy` into the buffer, binds a socket at a path nobody
    /// asked for and the command then waits on a file that is never created.
    /// Under the user's Application Support the path fits with room to spare;
    /// where it does not fit is a checking run that nests its throwaway folder
    /// deep, which is why the check keeps its folder short.
    public static var maximumPathLength: Int {
        MemoryLayout.size(ofValue: sockaddr_un().sun_path) - 1
    }

    public static func fits(_ path: String) -> Bool {
        path.utf8.count <= maximumPathLength
    }

    /// `path` as the address `bind` and `connect` take, or nil when it does not
    /// fit.
    public static func address(for path: String) -> sockaddr_un? {
        guard fits(path) else { return nil }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: bytes)
        }
        return address
    }

    // MARK: the wire

    /// What the command says. One JSON object on one line.
    public enum Request: Equatable, Sendable {
        /// Block until the document at this absolute path is closed.
        case wait(path: String)
    }

    /// What the app answers, once, and then closes the connection.
    public enum Reply: Equatable, Sendable {
        /// The document closed and the bytes the close decided on are on disk.
        /// The one answer the shell exits 0 on.
        case closed
        /// A second `--wait` on the same file arrived while this one was
        /// waiting. The first shell must not read that as a finished edit.
        case superseded
        /// The app quit while the document was still open. The quit wrote the
        /// buffer, but nobody closed the document, and a caller such as git
        /// treats an editor that went away as an interrupted edit.
        case quit
        /// The close's write did not reach the disk.
        case writeFailed(String)
    }

    public static func encode(_ request: Request) -> Data {
        switch request {
        case let .wait(path):
            return line(["wait": path])
        }
    }

    public static func encode(_ reply: Reply) -> Data {
        switch reply {
        case .closed: return line(["reply": "closed"])
        case .superseded: return line(["reply": "superseded"])
        case .quit: return line(["reply": "quit"])
        case let .writeFailed(reason): return line(["reply": "writeFailed", "reason": reason])
        }
    }

    public static func decodeRequest(_ line: Data) -> Request? {
        guard let object = object(line), let path = object["wait"] as? String else { return nil }
        return .wait(path: path)
    }

    public static func decodeReply(_ line: Data) -> Reply? {
        guard let object = object(line), let reply = object["reply"] as? String else { return nil }
        switch reply {
        case "closed": return .closed
        case "superseded": return .superseded
        case "quit": return .quit
        case "writeFailed": return .writeFailed(object["reason"] as? String ?? "")
        default: return nil
        }
    }

    private static func line(_ object: [String: String]) -> Data {
        // Sorted keys and unescaped slashes, so the line is one spelling per
        // value and a path reads as a path, which is what lets a check assert
        // the bytes rather than parse them.
        var data = (try? JSONSerialization.data(withJSONObject: object,
                                                options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
        data.append(0x0A)
        return data
    }

    private static func object(_ line: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: line) as? [String: Any]
    }

    /// What the shell does with each answer: its exit status, and the sentence
    /// on standard error when that is not 0.
    ///
    /// Everything but `closed` is nonzero, and it is one code rather than a
    /// code per case: what a caller such as git reads is zero or not, and the
    /// sentence is what a person reads. 2 is left to the parser's refusals,
    /// which are about the words typed rather than about what the app did.
    public static func exit(for reply: Reply, file: String) -> (status: Int32, message: String?) {
        switch reply {
        case .closed:
            return (0, nil)
        case .superseded:
            return (1, "a second --wait on \(file) took over; this one did not finish")
        case .quit:
            return (1, "Birta Writer quit before \(file) was closed")
        case let .writeFailed(reason):
            return (1, "Birta Writer could not write \(file): \(reason)")
        }
    }

    // MARK: what ends a wait

    /// How a document's close left its file.
    public enum CloseOutcome: Equatable, Sendable {
        /// The bytes the close decided on are on disk, which includes a
        /// Discard: the close settled the file, and what it holds is what
        /// the caller should read.
        case written
        case writeFailed(String)
    }

    /// The shells waiting on documents, and what each is told when.
    ///
    /// A value with no socket in it. The app feeds it the events that can end
    /// a wait and sends whatever answers come back; the rules are all here.
    ///
    /// Files are compared by resolved path (`identity(of:)`), because the
    /// shell resolves `.` and `..` against its own directory and the app
    /// standardizes what LaunchServices hands it, and `/tmp` and `/private/tmp`
    /// are one place. The file exists by the time either end names it, so the
    /// symlink walk has something to walk.
    public struct Waits: Equatable, Sendable {
        public typealias Connection = Int

        public struct Answer: Equatable, Sendable {
            public let connection: Connection
            public let reply: Reply

            public init(connection: Connection, reply: Reply) {
                self.connection = connection
                self.reply = reply
            }
        }

        private struct Entry: Equatable {
            let connection: Connection
            let key: String
        }

        private var entries: [Entry] = []

        public init() {}

        public var isEmpty: Bool { entries.isEmpty }
        public var count: Int { entries.count }

        /// Whether a shell is waiting on this file.
        ///
        /// Also what admits an extensionless file the app would otherwise
        /// turn away: a path a shell has declared it is waiting on is a path
        /// the caller chose, and `git commit` names `COMMIT_EDITMSG`.
        public func isWaiting(on path: String) -> Bool {
            let key = ControlSocket.identity(of: path)
            return entries.contains { $0.key == key }
        }

        /// A shell starts waiting on `path`.
        ///
        /// A wait already on the same file ends NONZERO, so its shell does not
        /// take an interrupted edit for a finished one: with two `git commit`s
        /// pointed at one message file, the first must fail rather than commit
        /// whatever the second one's editing left.
        public mutating func register(_ connection: Connection, path: String) -> [Answer] {
            let key = ControlSocket.identity(of: path)
            let superseded = entries.filter { $0.key == key }
            entries.removeAll { $0.key == key }
            entries.append(Entry(connection: connection, key: key))
            return superseded.map { Answer(connection: $0.connection, reply: .superseded) }
        }

        /// The document at `path` closed, and the close's write has landed or
        /// failed. Every shell waiting on it is answered.
        public mutating func documentClosed(_ path: String, outcome: CloseOutcome) -> [Answer] {
            let key = ControlSocket.identity(of: path)
            let ended = entries.filter { $0.key == key }
            entries.removeAll { $0.key == key }
            let reply: Reply
            switch outcome {
            case .written: reply = .closed
            case let .writeFailed(reason): reply = .writeFailed(reason)
            }
            return ended.map { Answer(connection: $0.connection, reply: reply) }
        }

        /// The app is going. Every wait ends, nonzero.
        public mutating func quitting() -> [Answer] {
            let all = entries
            entries.removeAll()
            return all.map { Answer(connection: $0.connection, reply: .quit) }
        }

        /// The shell went away first (Ctrl-C, or its terminal closed). Nothing
        /// to answer; the document stays open.
        public mutating func forget(_ connection: Connection) {
            entries.removeAll { $0.connection == connection }
        }
    }

    /// One spelling for a file, whichever way either program named it.
    public static func identity(of path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
    }

    // MARK: the descriptors

    public enum SocketError: Error, Equatable {
        case pathTooLong(String)
        /// Something is already listening there: another copy of the same
        /// flavour is running.
        case inUse(String)
        case failed(String, errno: Int32)
    }

    /// A listening socket at `url`, mode 0600, or a reason there is none.
    ///
    /// A file left by a process that died is removed first, and told apart
    /// from a live listener by connecting to it: a connect that is refused is
    /// a corpse, and one that succeeds is another instance, which is left
    /// alone. Unlinking a live one would strand every shell about to wait on
    /// it.
    public static func listen(at url: URL) throws -> Int32 {
        let path = url.path
        guard var address = address(for: path) else { throw SocketError.pathTooLong(path) }
        if FileManager.default.fileExists(atPath: path) {
            if let live = connect(to: url) {
                close(live)
                throw SocketError.inUse(path)
            }
            unlink(path)
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.failed("socket", errno: errno) }
        noSigpipe(fd)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else {
            let code = errno
            close(fd)
            throw SocketError.failed("bind", errno: code)
        }
        // Mode after the bind, which creates the file under the umask.
        chmod(path, 0o600)
        guard Darwin.listen(fd, 8) == 0 else {
            let code = errno
            close(fd)
            unlink(path)
            throw SocketError.failed("listen", errno: code)
        }
        return fd
    }

    /// A connection to whatever listens at `url`, or nil when nothing does.
    public static func connect(to url: URL) -> Int32? {
        guard var address = address(for: url.path) else { return nil }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        noSigpipe(fd)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            close(fd)
            return nil
        }
        return fd
    }

    /// Take one connection off a listening socket, or nil when none is
    /// pending.
    public static func accept(on listener: Int32) -> Int32? {
        let fd = Darwin.accept(listener, nil, nil)
        guard fd >= 0 else { return nil }
        noSigpipe(fd)
        return fd
    }

    /// Write all of `data`, or say it could not be.
    @discardableResult
    public static func send(_ data: Data, on fd: Int32) -> Bool {
        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { raw -> Int in
                Darwin.write(fd, raw.baseAddress! + offset, data.count - offset)
            }
            if written <= 0 { return false }
            offset += written
        }
        return true
    }

    /// Read up to and including the next newline, blocking; nil when the
    /// peer closed without sending one.
    public static func readLine(on fd: Int32) -> Data? {
        var line = Data()
        var byte: UInt8 = 0
        while true {
            let got = Darwin.read(fd, &byte, 1)
            if got <= 0 { return line.isEmpty ? nil : line }
            line.append(byte)
            if byte == 0x0A { return line }
        }
    }

    /// A peer that has gone kills the writer with SIGPIPE unless the socket
    /// says otherwise; EPIPE from `write` is what `send` reports instead.
    private static func noSigpipe(_ fd: Int32) {
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    }
}
