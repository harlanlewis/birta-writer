import XCTest
@testable import BirtaWriterCore

/// The port of the heading resolver, held to the TypeScript it ports through
/// the golden file `shared/__tests__/fixtures/headingTargetGolden.json`.
///
/// `shared/__tests__/headingTargetGolden.test.ts` regenerates that file from
/// `shared/headingTarget.ts` on every run and fails when it is stale, so what
/// it holds is what the TypeScript answers today; this requires the Swift to
/// answer the same, input for input. The header of that test has the command
/// that rewrites the file.
final class HeadingTargetGoldenTests: XCTestCase {
    private struct Golden: Decodable {
        struct Heading: Decodable {
            let level: Int
            let text: String
            let line: Int
        }

        struct Case: Decodable {
            let fragment: String
            let line: Int?
        }

        struct Document: Decodable {
            let name: String
            let content: String
            let lineCount: Int
            let headings: [Heading]
            let cases: [Case]
        }

        struct Slug: Decodable {
            let text: String
            let rendered: String
            let slug: String
        }

        struct Target: Decodable {
            let kind: String
            let line: Int?
            let fragment: String?
        }

        struct Word: Decodable {
            let word: String
            let target: Target?
        }

        let documents: [Document]
        let slugs: [Slug]
        let words: [Word]
    }

    private func golden() throws -> Golden {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .deletingLastPathComponent()  // repo
            .appendingPathComponent("shared/__tests__/fixtures/headingTargetGolden.json")
        return try JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
    }

    func testTheScanFindsTheHeadingsTheTypeScriptFinds() throws {
        let documents = try golden().documents
        // A golden that reached nothing would be matched by a port that finds
        // nothing; the TypeScript asserts the file's own reach, and this
        // asserts the file was read.
        XCTAssertGreaterThan(documents.count, 50)
        for doc in documents {
            let scanned = HeadingTarget.scan(doc.content)
            XCTAssertEqual(scanned.map(\.line), doc.headings.map(\.line), doc.name)
            XCTAssertEqual(scanned.map(\.level), doc.headings.map(\.level), doc.name)
            XCTAssertEqual(scanned.map(\.text), doc.headings.map(\.text), doc.name)
            XCTAssertEqual(HeadingTarget.lineCount(doc.content), doc.lineCount, doc.name)
        }
    }

    func testEveryPlaceNameLandsWhereTheTypeScriptLandsIt() throws {
        var asked = 0
        for doc in try golden().documents {
            for item in doc.cases {
                asked += 1
                XCTAssertEqual(HeadingTarget.headingLine(in: doc.content, fragment: item.fragment), item.line,
                               "\(doc.name): \(item.fragment.debugDescription)")
            }
        }
        XCTAssertGreaterThan(asked, 1000)
    }

    func testRenderedTextAndSlugsMatch() throws {
        let slugs = try golden().slugs
        XCTAssertGreaterThan(slugs.count, 100)
        for item in slugs {
            XCTAssertEqual(HeadingTarget.rendered(item.text), item.rendered, item.text.debugDescription)
            XCTAssertEqual(HeadingTarget.slugify(item.rendered), item.slug, item.text.debugDescription)
        }
    }

    func testTheWordsAfterAtParseAsTheTypeScriptParsesThem() throws {
        let words = try golden().words
        XCTAssertGreaterThan(words.count, 15)
        for item in words {
            let expected: HeadingTarget.Target? = item.target.map {
                $0.kind == "line" ? .line($0.line ?? -1) : .heading($0.fragment ?? "")
            }
            XCTAssertEqual(HeadingTarget.parse(item.word), expected, item.word.debugDescription)
        }
    }
}
