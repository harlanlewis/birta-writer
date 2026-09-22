import XCTest
@testable import BirtaWriterCore

/// The ports of the note scanner and the link resolver, held to the
/// TypeScript they port through the golden file
/// `shared/__tests__/fixtures/noteLinksGolden.json`.
///
/// `shared/__tests__/noteLinksGolden.test.ts` regenerates that file from
/// `readNote` and `linkResolver.ts` on every run and fails when it is stale, so
/// what it holds is what the TypeScript answers today; this requires the Swift
/// to answer the same, input for input. A pattern changed on one side only
/// reddens one suite or the other. The header of that test has the command
/// that rewrites the file.
final class NoteLinksGoldenTests: XCTestCase {
    private struct Golden: Decodable {
        struct Link: Decodable, Equatable {
            let kind: String
            let href: String
            let path: String
            let text: String
            let line: Int
        }

        struct Meta: Decodable, Equatable {
            let title: String?
            let type: String?
            let tags: [String]
            let status: String?
            let trust: String?
            let staleAfter: String?
        }

        struct Reading: Decodable, Equatable {
            let links: [Link]
            let meta: Meta
        }

        struct Note: Decodable {
            let name: String
            let content: String
            let reading: Reading
        }

        struct Case: Decodable {
            let doc: String
            let target: String
            let wiki: Bool
            let expected: String?
        }

        struct Resolver: Decodable {
            let root: String
            let files: [String]
            let cases: [Case]
        }

        let notes: [Note]
        let resolver: Resolver
    }

    private func golden() throws -> Golden {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("shared/__tests__/fixtures/noteLinksGolden.json")
        return try JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
    }

    private func swiftReading(_ content: String) -> Golden.Reading {
        let reading = NoteLinks.readNote(content)
        return Golden.Reading(
            links: reading.links.map {
                Golden.Link(kind: $0.kind.rawValue, href: $0.href, path: $0.path, text: $0.text, line: $0.line)
            },
            meta: Golden.Meta(title: reading.meta.title, type: reading.meta.type, tags: reading.meta.tags,
                              status: reading.meta.status, trust: reading.meta.trust,
                              staleAfter: reading.meta.staleAfter))
    }

    func testEveryRecordedNoteShouldBeReadAsTheTypeScriptReadsIt() throws {
        let notes = try golden().notes
        // The golden's own reach: a file that recorded nothing would be
        // matched by a reader that reads nothing.
        XCTAssertGreaterThanOrEqual(notes.count, 100)
        let recorded = notes.flatMap(\.reading.links)
        for kind in ["link", "wiki", "source"] {
            XCTAssertGreaterThan(recorded.filter { $0.kind == kind }.count, 5, "\(kind) references recorded")
        }
        var disagreements: [String] = []
        for note in notes {
            let ours = swiftReading(note.content)
            if ours != note.reading {
                disagreements.append("\(note.name):\n  typescript \(note.reading)\n  swift      \(ours)")
            }
        }
        XCTAssertEqual(disagreements, [], disagreements.joined(separator: "\n"))
    }

    func testEveryRecordedResolutionShouldLandWhereTheTypeScriptLandsIt() throws {
        let recorded = try golden().resolver
        XCTAssertGreaterThanOrEqual(recorded.cases.count, 200)
        XCTAssertGreaterThanOrEqual(recorded.cases.filter { $0.expected != nil }.count, 100)
        let resolver = NoteLinkResolver(root: recorded.root, files: recorded.files)
        var disagreements: [String] = []
        for c in recorded.cases {
            let ours = c.wiki ? resolver.resolveWiki(c.target, from: c.doc) : resolver.resolveLink(c.target, from: c.doc)
            if ours != c.expected {
                disagreements.append("\(c.wiki ? "wiki" : "link") \(c.target.debugDescription) from \(c.doc): "
                    + "typescript \(c.expected ?? "nil") swift \(ours ?? "nil")")
            }
        }
        XCTAssertEqual(disagreements, [], disagreements.joined(separator: "\n"))
    }
}
