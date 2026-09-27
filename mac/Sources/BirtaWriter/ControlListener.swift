import BirtaWriterCore
import Darwin
import Foundation

/// The app's end of `bwr --wait`: a listening socket, one connection per
/// waiting shell, and the answer written back when `WindowSet` says so.
///
/// Nothing here decides anything. What a shell is told and when is
/// `ControlSocket.Waits`, held by `WindowSet` beside the gestures that end a
/// wait; this is the descriptors and the run loop. Every callback runs on the
/// main thread, because the registry lives with the windows and a close is a
/// main-thread gesture.
///
/// One request per connection and one answer per connection, after which the
/// app closes it. A shell that goes first (Ctrl-C, a closed terminal) reads as
/// end of file here and is reported so its wait is forgotten.
@MainActor
final class ControlListener {
    typealias Connection = ControlSocket.Waits.Connection

    let socket: URL
    private var listenFD: Int32 = -1
    private var listener: DispatchSourceRead?
    private var connections: [Connection: (fd: Int32, source: DispatchSourceRead, buffer: [UInt8])] = [:]
    private var nextConnection: Connection = 1

    var onRequest: ((Connection, ControlSocket.Request) -> Void)?
    var onDisconnect: ((Connection) -> Void)?

    init(socket: URL) {
        self.socket = socket
    }

    /// Bind and start accepting. Throws for the reasons `ControlSocket.listen`
    /// names; the app logs them and runs without a socket, since the summon
    /// key and every file open work exactly as before.
    func start() throws {
        let fd = try ControlSocket.listen(at: socket)
        Self.setNonBlocking(fd)
        listenFD = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler { [weak self] in self?.acceptPending() }
        source.setCancelHandler { close(fd) }
        source.resume()
        listener = source
    }

    /// Close every connection without answering, and take the socket file
    /// away so a shell arriving after this sees nothing listening rather than
    /// a file that refuses.
    func stop() {
        for id in Array(connections.keys) { drop(id) }
        listener?.cancel()
        listener = nil
        listenFD = -1
        unlink(socket.path)
    }

    /// Write the answer and close the connection. The registry has already
    /// forgotten this shell, so no disconnect is reported for it.
    func answer(_ answer: ControlSocket.Waits.Answer) {
        guard let connection = connections[answer.connection] else { return }
        ControlSocket.send(ControlSocket.encode(answer.reply), on: connection.fd)
        drop(answer.connection)
    }

    private func acceptPending() {
        while let fd = ControlSocket.accept(on: listenFD) {
            Self.setNonBlocking(fd)
            let id = nextConnection
            nextConnection += 1
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
            source.setEventHandler { [weak self] in self?.readable(id) }
            source.setCancelHandler { close(fd) }
            connections[id] = (fd, source, [])
            source.resume()
        }
    }

    private func readable(_ id: Connection) {
        guard let connection = connections[id] else { return }
        var chunk = [UInt8](repeating: 0, count: 4096)
        let got = read(connection.fd, &chunk, chunk.count)
        if got < 0, errno == EAGAIN { return }
        guard got > 0 else {
            drop(id)
            onDisconnect?(id)
            return
        }
        connections[id]?.buffer.append(contentsOf: chunk[0..<got])
        while let newline = connections[id]?.buffer.firstIndex(of: 0x0A) {
            let line = Array(connections[id]!.buffer[...newline])
            connections[id]?.buffer.removeSubrange(...newline)
            if let request = ControlSocket.decodeRequest(Data(line)) {
                onRequest?(id, request)
            }
        }
    }

    private func drop(_ id: Connection) {
        guard let connection = connections.removeValue(forKey: id) else { return }
        // Cancelling runs the cancel handler, which is what closes the fd.
        connection.source.cancel()
    }

    /// A read source fires when bytes are there, and `accept` on a listening
    /// socket when a connection is; non-blocking is what turns "nothing more"
    /// into a return rather than a stalled main thread.
    private static func setNonBlocking(_ fd: Int32) {
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    }
}
