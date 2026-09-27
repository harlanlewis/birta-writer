import XCTest
@testable import BirtaWriterCore

/// The channel `bwr --wait` waits on: where it is, what crosses it, and what
/// ends a wait with which answer.
///
/// The registry is a value, so every row of the table (a close, a second wait
/// on the same file, a quit, a shell that went away) is asked with no window
/// and no socket. The socket half is asked with a real one, in a folder of
/// its own, because the bytes' journey through `bind`, `connect`, `accept`,
/// `send` and `readLine` is the one part no value can stand in for.
final class ControlSocketTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        // Short on purpose: the socket path has to fit `sun_path`, and the
        // test that checks the refusal for a long one builds its own.
        dir = URL(fileURLWithPath: "/tmp/bwr-t-\(getpid())-\(Int.random(in: 0..<100_000))", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: where it is

    func testTheSocketShouldLiveUnderTheFlavoursOwnFolder() {
        let support = URL(fileURLWithPath: "/Users/someone/Library/Application Support")
        for flavour in AppFlavor.allCases {
            let url = ControlSocket.url(support: support, flavour: flavour)
            XCTAssertEqual(url.lastPathComponent, ControlSocket.fileName)
            XCTAssertEqual(url.deletingLastPathComponent().lastPathComponent, flavour.displayName, "\(flavour)")
        }
        // Two flavours, two sockets: a development build's command must not
        // wait on the release's windows.
        XCTAssertNotEqual(ControlSocket.url(support: support, flavour: .release),
                          ControlSocket.url(support: support, flavour: .dev))
    }

    func testTheSupportFolderShouldBeTheSeamsWhenNamedAndTheStandardOneOtherwise() {
        let named = ControlSocket.supportDirectory(environment: ["BIRTA_MAC_CLI_SUPPORT": "/tmp/check"],
                                                   standard: { URL(fileURLWithPath: "/real") })
        XCTAssertEqual(named?.path, "/tmp/check")
        let standard = ControlSocket.supportDirectory(environment: ["BIRTA_MAC_CLI_SUPPORT": ""],
                                                      standard: { URL(fileURLWithPath: "/real") })
        XCTAssertEqual(standard?.path, "/real")
        XCTAssertNil(ControlSocket.supportDirectory(environment: [:], standard: { nil }))
    }

    /// The boundary is `sun_path`'s own size, read from the struct rather
    /// than written here, and a path one byte over is refused by name.
    func testAPathThatDoesNotFitTheAddressShouldBeRefusedRatherThanTruncated() throws {
        let limit = ControlSocket.maximumPathLength
        XCTAssertGreaterThan(limit, 80)
        let exact = String(repeating: "a", count: limit)
        XCTAssertTrue(ControlSocket.fits(exact))
        XCTAssertNotNil(ControlSocket.address(for: exact))
        let over = exact + "a"
        XCTAssertFalse(ControlSocket.fits(over))
        XCTAssertNil(ControlSocket.address(for: over))
        XCTAssertThrowsError(try ControlSocket.listen(at: URL(fileURLWithPath: "/" + over))) { error in
            XCTAssertEqual(error as? ControlSocket.SocketError, .pathTooLong("/" + over))
        }
    }

    func testTheAddressShouldCarryThePathBytesAndTheFamily() {
        let address = try! XCTUnwrap(ControlSocket.address(for: "/tmp/x.sock"))
        XCTAssertEqual(Int32(address.sun_family), AF_UNIX)
        let bytes = withUnsafeBytes(of: address.sun_path) { Array($0.prefix(12)) }
        XCTAssertEqual(bytes, Array("/tmp/x.sock".utf8) + [0])
    }

    // MARK: the wire

    /// The exact bytes, because `mac/scripts/check-cli.sh` and a shell
    /// reading the socket by hand both see this spelling and nothing else.
    func testTheRequestShouldBeOneJSONObjectOnOneLine() {
        XCTAssertEqual(String(decoding: ControlSocket.encode(.wait(path: "/a/b.md")), as: UTF8.self),
                       "{\"wait\":\"/a/b.md\"}\n")
        XCTAssertEqual(String(decoding: ControlSocket.encode(.closed), as: UTF8.self), "{\"reply\":\"closed\"}\n")
    }

    func testEveryRequestAndReplyShouldSurviveTheWire() {
        for request in [ControlSocket.Request.wait(path: "/a/b.md"), .wait(path: "/with space/and \"quotes\"")] {
            XCTAssertEqual(ControlSocket.decodeRequest(ControlSocket.encode(request)), request)
        }
        let replies: [ControlSocket.Reply] = [.closed, .superseded, .quit, .writeFailed("disk full")]
        for reply in replies {
            XCTAssertEqual(ControlSocket.decodeReply(ControlSocket.encode(reply)), reply)
        }
        XCTAssertNil(ControlSocket.decodeRequest(Data("nonsense\n".utf8)))
        XCTAssertNil(ControlSocket.decodeReply(Data("{\"reply\":\"maybe\"}\n".utf8)))
        XCTAssertNil(ControlSocket.decodeReply(ControlSocket.encode(.wait(path: "/x"))), "a request is not a reply")
    }

    /// Zero for `closed` and nothing else. What git reads is zero or not, and
    /// every other answer names the file it was about.
    func testOnlyAClosedDocumentShouldExitZero() {
        let replies: [ControlSocket.Reply] = [.closed, .superseded, .quit, .writeFailed("no space left")]
        var zero = 0
        for reply in replies {
            let exit = ControlSocket.exit(for: reply, file: "COMMIT_EDITMSG")
            if exit.status == 0 {
                zero += 1
                XCTAssertNil(exit.message)
            } else {
                XCTAssertEqual(exit.status, 1, "\(reply)")
                XCTAssertTrue(exit.message?.contains("COMMIT_EDITMSG") == true, "\(reply)")
            }
        }
        XCTAssertEqual(zero, 1)
        XCTAssertEqual(ControlSocket.exit(for: .closed, file: "x").status, 0)
        XCTAssertTrue(ControlSocket.exit(for: .writeFailed("no space left"), file: "x").message?.contains("no space left") == true)
    }

    // MARK: what ends a wait

    func testAWaitShouldEndWhenItsDocumentClosesAndNotWhenAnotherDoes() {
        var waits = ControlSocket.Waits()
        XCTAssertTrue(waits.register(1, path: "/notes/a.md").isEmpty)
        XCTAssertTrue(waits.register(2, path: "/notes/b.md").isEmpty)
        XCTAssertTrue(waits.isWaiting(on: "/notes/a.md"))
        XCTAssertFalse(waits.isWaiting(on: "/notes/c.md"))

        XCTAssertEqual(waits.documentClosed("/notes/b.md", outcome: .written),
                       [.init(connection: 2, reply: .closed)])
        XCTAssertTrue(waits.isWaiting(on: "/notes/a.md"))
        XCTAssertFalse(waits.isWaiting(on: "/notes/b.md"))
        XCTAssertEqual(waits.count, 1)
        // A close of a file nobody waits on answers nobody.
        XCTAssertTrue(waits.documentClosed("/notes/b.md", outcome: .written).isEmpty)
    }

    /// The concurrency rule. The first shell must not read the second's edit
    /// as its own finished one.
    func testASecondWaitOnTheSameFileShouldEndTheFirstNonzero() {
        var waits = ControlSocket.Waits()
        _ = waits.register(1, path: "/g/COMMIT_EDITMSG")
        let answers = waits.register(2, path: "/g/COMMIT_EDITMSG")
        XCTAssertEqual(answers, [.init(connection: 1, reply: .superseded)])
        XCTAssertNotEqual(ControlSocket.exit(for: answers[0].reply, file: "COMMIT_EDITMSG").status, 0)
        // The second is the live one, and only it is answered by the close.
        XCTAssertEqual(waits.documentClosed("/g/COMMIT_EDITMSG", outcome: .written),
                       [.init(connection: 2, reply: .closed)])
        XCTAssertTrue(waits.isEmpty)
    }

    func testAWriteThatFailedShouldEndTheWaitWithTheReason() {
        var waits = ControlSocket.Waits()
        _ = waits.register(7, path: "/n/a.md")
        XCTAssertEqual(waits.documentClosed("/n/a.md", outcome: .writeFailed("read-only volume")),
                       [.init(connection: 7, reply: .writeFailed("read-only volume"))])
    }

    func testAQuitShouldEndEveryWaitNonzero() {
        var waits = ControlSocket.Waits()
        _ = waits.register(1, path: "/n/a.md")
        _ = waits.register(2, path: "/n/b.md")
        let answers = waits.quitting()
        XCTAssertEqual(Set(answers.map(\.connection)), [1, 2])
        XCTAssertTrue(answers.allSatisfy { $0.reply == .quit })
        XCTAssertTrue(waits.isEmpty)
        XCTAssertTrue(waits.quitting().isEmpty)
    }

    /// Ctrl-C in the shell. The document stays open and nothing is answered.
    func testAShellThatWentAwayShouldBeForgottenWithoutAnAnswer() {
        var waits = ControlSocket.Waits()
        _ = waits.register(1, path: "/n/a.md")
        waits.forget(1)
        XCTAssertFalse(waits.isWaiting(on: "/n/a.md"))
        XCTAssertTrue(waits.documentClosed("/n/a.md", outcome: .written).isEmpty)
    }

    /// The shell and the app spell one file differently and must agree: the
    /// shell resolves against its own directory, LaunchServices standardizes,
    /// and `/tmp` is a symlink into `/private`.
    func testTwoSpellingsOfOneFileShouldBeOneWait() throws {
        let real = dir.appendingPathComponent("real", isDirectory: true)
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let file = real.appendingPathComponent("note.md")
        try "x".write(to: file, atomically: true, encoding: .utf8)
        let link = dir.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

        var waits = ControlSocket.Waits()
        _ = waits.register(1, path: link.appendingPathComponent("note.md").path)
        XCTAssertTrue(waits.isWaiting(on: file.path))
        XCTAssertTrue(waits.isWaiting(on: "/private" + file.path), "the /private spelling of /tmp")
        XCTAssertTrue(waits.isWaiting(on: real.appendingPathComponent("../real/note.md").path))
        XCTAssertEqual(waits.documentClosed(file.path, outcome: .written).map(\.connection), [1])
    }

    // MARK: the descriptors

    /// Round trip through a real socket: the mode, the request, the reply,
    /// and the end of the connection.
    func testARequestAndAReplyShouldCrossARealSocket() throws {
        let url = dir.appendingPathComponent(ControlSocket.fileName)
        let listener = try ControlSocket.listen(at: url)
        defer { close(listener); unlink(url.path) }
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        let client = try XCTUnwrap(ControlSocket.connect(to: url))
        XCTAssertTrue(ControlSocket.send(ControlSocket.encode(.wait(path: "/g/COMMIT_EDITMSG")), on: client))
        let server = try XCTUnwrap(ControlSocket.accept(on: listener))
        let request = try XCTUnwrap(ControlSocket.readLine(on: server))
        XCTAssertEqual(ControlSocket.decodeRequest(request), .wait(path: "/g/COMMIT_EDITMSG"))

        XCTAssertTrue(ControlSocket.send(ControlSocket.encode(.writeFailed("full")), on: server))
        close(server)
        let reply = try XCTUnwrap(ControlSocket.readLine(on: client))
        XCTAssertEqual(ControlSocket.decodeReply(reply), .writeFailed("full"))
        // The app closed after answering: the next read is the end.
        XCTAssertNil(ControlSocket.readLine(on: client))
        close(client)
    }

    func testNothingListeningShouldBeNilRatherThanAHang() {
        XCTAssertNil(ControlSocket.connect(to: dir.appendingPathComponent("absent.sock")))
    }

    /// The file a dead process left behind is a corpse and is replaced; a
    /// live listener is left alone and reported.
    func testAStaleSocketFileShouldBeReplacedAndALiveOneRefused() throws {
        let url = dir.appendingPathComponent(ControlSocket.fileName)
        let first = try ControlSocket.listen(at: url)
        XCTAssertThrowsError(try ControlSocket.listen(at: url)) { error in
            XCTAssertEqual(error as? ControlSocket.SocketError, .inUse(url.path))
        }
        close(first)
        // The file is still there and nobody answers on it.
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertNil(ControlSocket.connect(to: url))
        let second = try ControlSocket.listen(at: url)
        XCTAssertNotNil(ControlSocket.connect(to: url).map { close($0) })
        close(second)
        unlink(url.path)
    }

    /// A peer that closed must not take the writer down with SIGPIPE; `send`
    /// reports it instead.
    func testWritingToAPeerThatWentAwayShouldReportRatherThanSignal() throws {
        let url = dir.appendingPathComponent(ControlSocket.fileName)
        let listener = try ControlSocket.listen(at: url)
        defer { close(listener); unlink(url.path) }
        let client = try XCTUnwrap(ControlSocket.connect(to: url))
        let server = try XCTUnwrap(ControlSocket.accept(on: listener))
        close(client)
        // The first write may be accepted into the buffer; the second sees
        // the reset. Either way the process is still here to assert it.
        _ = ControlSocket.send(ControlSocket.encode(.closed), on: server)
        let second = ControlSocket.send(ControlSocket.encode(.closed), on: server)
        XCTAssertFalse(second)
        close(server)
    }
}
