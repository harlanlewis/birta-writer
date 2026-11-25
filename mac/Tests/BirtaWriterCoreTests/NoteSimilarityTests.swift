import XCTest
@testable import BirtaWriterCore

/// Which notes are alike (`NoteSimilarity`): what a note is embedded from, and
/// which pairs survive the centring, the threshold and the mutual top-k. The
/// vectors are made up here, so every claim is about the rules rather than
/// about a model; one case asks the real embedding, where the Mac has it.
final class NoteSimilarityTests: XCTestCase {
    func testAnExcerptShouldBeTheTitleAndTheBodysOpeningWithoutFrontmatterOrMarkup() {
        let text = "---\ntitle: X\ntags: [a]\n---\n# Heading\n\nSee [[Other note]] and **this**.\n"
        XCTAssertEqual(NoteSimilarity.excerpt(title: "Plan", text: text), "Plan. Heading See Other note and this")
        XCTAssertEqual(NoteSimilarity.excerpt(title: "Empty", text: "---\na: 1\n---\n"), "Empty")
        let long = String(repeating: "word ", count: 500)
        XCTAssertLessThanOrEqual(NoteSimilarity.excerpt(title: "T", text: long).count, NoteSimilarity.excerptLength + 3)
    }

    /// Two tight groups along two axes, all sharing one large common
    /// component, as every note in one language does.
    private func vectors() -> [String: [Float]] {
        let common: [Float] = [5, 5, 5, 5]
        let around: [String: [Float]] = [
            "a1.md": [1, 0, 0, 0], "a2.md": [0.9, 0.1, 0, 0], "a3.md": [0.95, 0, 0.05, 0],
            "b1.md": [0, 0, 1, 0], "b2.md": [0, 0.05, 0.9, 0], "b3.md": [0, 0, 0.95, 0.1],
        ]
        return around.mapValues { zip($0, common).map { $0 + $1 } }
    }

    func testNotesInOneGroupShouldPairAndNotesInDifferentGroupsShouldNot() {
        let pairs = NoteSimilarity.pairs(vectors())
        let joined = Set(pairs.map { "\($0.a)+\($0.b)" })
        XCTAssertTrue(joined.contains("a1.md+a2.md"))
        XCTAssertTrue(joined.contains("b1.md+b2.md"))
        XCTAssertFalse(pairs.contains { $0.a.hasPrefix("a") != $0.b.hasPrefix("a") },
                       "the common component, once removed, should not join the groups: \(joined)")
        XCTAssertTrue(pairs.allSatisfy { $0.a < $0.b && $0.score >= NoteSimilarity.threshold })
    }

    /// Without centring, the shared component makes every pair look alike;
    /// this is the case that proves the subtraction is load-bearing.
    func testRawCosinesShouldBeTooAlikeToRankWhichIsWhyTheMeanIsRemoved() {
        let v = vectors()
        func cos(_ a: [Float], _ b: [Float]) -> Float {
            zip(a, b).map(*).reduce(0, +) / (sqrt(a.map { $0 * $0 }.reduce(0, +)) * sqrt(b.map { $0 * $0 }.reduce(0, +)))
        }
        XCTAssertGreaterThan(cos(v["a1.md"]!, v["b1.md"]!), 0.9)
    }

    func testANoteShouldKeepAtMostPerNotePartnersAndOnlyMutualOnes() {
        // One hub alike to everything a little, and a tight group around it.
        var v: [String: [Float]] = [:]
        for i in 0..<8 { var x = [Float](repeating: 0, count: 10); x[i] = 1; x[9] = 0.3; v["n\(i).md"] = x }
        let pairs = NoteSimilarity.pairs(v)
        let count = Dictionary(grouping: pairs.flatMap { [$0.a, $0.b] }, by: { $0 }).mapValues(\.count)
        XCTAssertTrue(count.values.allSatisfy { $0 <= NoteSimilarity.perNote })
    }

    func testTooFewOrMismatchedVectorsShouldGiveNoPairs() {
        XCTAssertEqual(NoteSimilarity.pairs([:]), [])
        XCTAssertEqual(NoteSimilarity.pairs(["a.md": [1, 0]]), [])
        XCTAssertEqual(NoteSimilarity.pairs(["a.md": [1, 0], "b.md": [1, 0, 0]]), [])
    }

    func testTheIndexShouldCarryThePairsAndEmbedAnUnchangedNoteOnce() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let axes = ["a1": 0, "a2": 0, "b1": 2, "b2": 2, "c1": 4, "c2": 4]
        for (name, _) in axes { try "# \(name)\n".write(to: root.appendingPathComponent("\(name).md"), atomically: true, encoding: .utf8) }
        var embedded = 0
        let indexer = FolderIndexer(root: root, embed: { text in
            embedded += 1
            let name = String(text.prefix(2))
            var v = [Float](repeating: 0, count: 6)
            v[axes[name]!] = 1
            v[axes[name]! + 1] = name.hasSuffix("1") ? 0.1 : 0
            return v
        })
        let first = indexer.build()
        XCTAssertEqual(Set(first.similar.map { "\($0.a)+\($0.b)" }), ["a1.md+a2.md", "b1.md+b2.md", "c1.md+c2.md"])
        XCTAssertEqual(embedded, 6)
        let json = first.jsonObject
        let wire = try XCTUnwrap(json["similar"] as? [[String: Any]])
        XCTAssertEqual(wire.first?["a"] as? String, "a1.md")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(json))
        _ = indexer.build()
        XCTAssertEqual(embedded, 6, "an unchanged note is not embedded again")
    }

    /// The real model, where this Mac has it: two notes on one subject should
    /// pair, and no note should pair with one on an unrelated subject, once
    /// centred against a few others. Skipped on a Mac without the model.
    func testTheSystemEmbeddingShouldPutTwoNotesOnOneSubjectCloserThanToAnUnrelatedOne() throws {
        guard let embed = NoteSimilarity.systemEmbedder() else { throw XCTSkip("no English contextual embedding installed on this Mac") }
        let texts = [
            "voice1.md": "Transcription overeager acting as agent. The voice transcriber took actions instead of writing down what I said.",
            "voice2.md": "Voice recording feedback on agentic actions. The assistant should confirm before doing anything.",
            "game.md": "Hardest 49ers game and the odds this weekend.",
            "hire.md": "Senior product designer role profile. What we look for in a senior design hire.",
            "errand.md": "Errands: registration sticker, stamps, envelopes.",
        ]
        // Through `excerpt`, as the index embeds a note: the title, then the
        // body's words.
        var vectors: [String: [Float]] = [:]
        for (path, text) in texts {
            vectors[path] = try XCTUnwrap(embed(NoteSimilarity.excerpt(title: String(path.dropLast(3)), text: text)))
        }
        let pairs = NoteSimilarity.pairs(vectors)
        XCTAssertTrue(pairs.contains { $0.a == "voice1.md" && $0.b == "voice2.md" }, "\(pairs)")
        XCTAssertTrue(pairs.allSatisfy { $0.a.hasPrefix("voice") && $0.b.hasPrefix("voice") },
                      "only the two voice notes are alike: \(pairs)")
    }
}
