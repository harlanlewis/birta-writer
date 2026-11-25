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
            return NoteSimilarity.Embedding(space: "m", language: "en", vector: v)
        })
        // Reading the folder never waits on the model: the index comes back
        // with no vectors made, and the pairs follow.
        let read = indexer.build()
        XCTAssertEqual(embedded, 0)
        XCTAssertEqual(read.similar, [])
        let first = try XCTUnwrap(indexer.completeSimilarity())
        XCTAssertEqual(Set(first.similar.map { "\($0.a)+\($0.b)" }), ["a1.md+a2.md", "b1.md+b2.md", "c1.md+c2.md"])
        XCTAssertEqual(embedded, 6)
        XCTAssertNil(indexer.completeSimilarity(), "nothing left to make, nothing to re-send")
        // A rebuild with nothing changed keeps the vectors, and the pairs, at once.
        XCTAssertEqual(indexer.build().similar, first.similar)
        let json = first.jsonObject
        let wire = try XCTUnwrap(json["similar"] as? [[String: Any]])
        XCTAssertEqual(wire.first?["a"] as? String, "a1.md")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(json))
        _ = indexer.build()
        XCTAssertNil(indexer.completeSimilarity())
        XCTAssertEqual(embedded, 6, "an unchanged note is not embedded again")
    }

    /// The real model, where this Mac has it: two notes on one subject should
    /// pair, and no note should pair with one on an unrelated subject, once
    /// centred against a few others. Skipped on a Mac without the model.
    func testTheSystemEmbeddingShouldPutTwoNotesOnOneSubjectCloserThanToAnUnrelatedOne() throws {
        let embed = NoteSimilarity.systemEmbedder()
        guard embed("A note about the voice assistant") != nil else { throw XCTSkip("no English contextual embedding installed on this Mac") }
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
            vectors[path] = try XCTUnwrap(embed(NoteSimilarity.excerpt(title: String(path.dropLast(3)), text: text))).vector
        }
        let pairs = NoteSimilarity.pairs(vectors)
        XCTAssertTrue(pairs.contains { $0.a == "voice1.md" && $0.b == "voice2.md" }, "\(pairs)")
        XCTAssertTrue(pairs.allSatisfy { $0.a.hasPrefix("voice") && $0.b.hasPrefix("voice") },
                      "only the two voice notes are alike: \(pairs)")
    }

    /// Two models' spaces, each with a pair of its own: notes are paired
    /// within a space and never across, whatever their vectors say; and a
    /// space of two notes, which centring leaves opposite, pairs nothing.
    func testNotesShouldBeComparedOnlyWithinOneModelsSpace() {
        func e(_ space: String, _ v: [Float]) -> NoteSimilarity.Embedding { .init(space: space, language: "x", vector: v) }
        let embeddings: [String: NoteSimilarity.Embedding] = [
            "a1.md": e("A", [1, 0, 0, 0]), "a2.md": e("A", [0.9, 0.1, 0, 0]), "a3.md": e("A", [0, 0, 1, 0]),
            "b1.md": e("B", [1, 0, 0, 0]), "b2.md": e("B", [0.95, 0.05, 0, 0]), "b3.md": e("B", [0, 0, 0, 1]),
            "c1.md": e("C", [1, 0]), "c2.md": e("C", [0.9, 0.1]),
        ]
        let pairs = NoteSimilarity.pairs(grouped: embeddings)
        XCTAssertTrue(pairs.contains { $0.a == "a1.md" && $0.b == "a2.md" })
        XCTAssertTrue(pairs.contains { $0.a == "b1.md" && $0.b == "b2.md" })
        XCTAssertFalse(pairs.contains { $0.a.prefix(1) != $0.b.prefix(1) }, "\(pairs)")
        XCTAssertFalse(pairs.contains { $0.a.hasPrefix("c") }, "a space of two is not compared: \(pairs)")
    }

    /// A note whose language was guessed differently but read by the same
    /// model stays among its neighbours.
    func testALanguageGuessShouldNotSplitNotesOneModelRead() {
        func e(_ lang: String, _ v: [Float]) -> NoteSimilarity.Embedding { .init(space: "Latin", language: lang, vector: v) }
        let pairs = NoteSimilarity.pairs(grouped: [
            "x1.md": e("en", [1, 0, 0, 0]), "x2.md": e("nl", [0.9, 0.1, 0, 0]),
            "y1.md": e("en", [0, 0, 1, 0]), "y2.md": e("en", [0, 0.05, 0.95, 0]),
        ])
        XCTAssertTrue(pairs.contains { $0.a == "x1.md" && $0.b == "x2.md" }, "\(pairs)")
    }

    /// A save that changes no link keeps the note's old vector until a new
    /// one is made, so the pairs, and the index, do not change in between;
    /// and a note that cannot be embedded is asked once per version, not on
    /// every build.
    func testASaveShouldKeepThePairsAndAFailedEmbeddingShouldNotBeRetried() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let axes = ["a1": 0, "a2": 0, "b1": 2, "b2": 2, "c1": 4, "c2": 4]
        for (name, _) in axes { try "# \(name)\n".write(to: root.appendingPathComponent("\(name).md"), atomically: true, encoding: .utf8) }
        try "# zz\n".write(to: root.appendingPathComponent("zz.md"), atomically: true, encoding: .utf8)
        var asked: [String: Int] = [:]
        let indexer = FolderIndexer(root: root, embed: { text in
            let name = String(text.prefix(2))
            asked[name, default: 0] += 1
            guard let axis = axes[name] else { return nil } // zz cannot be embedded
            var v = [Float](repeating: 0, count: 6)
            v[axis] = 1
            v[axis + 1] = name.hasSuffix("1") ? 0.1 : 0
            return NoteSimilarity.Embedding(space: "m", language: "en", vector: v)
        })
        _ = indexer.build()
        let first = try XCTUnwrap(indexer.completeSimilarity())
        XCTAssertEqual(asked["zz"], 1)
        // Write a1 again with different bytes, which changes its stamp.
        try "# a1\n\nmore\n".write(to: root.appendingPathComponent("a1.md"), atomically: true, encoding: .utf8)
        let saved = indexer.build()
        XCTAssertEqual(saved.similar, first.similar, "the old vector stands in until the new one is made")
        XCTAssertNil(indexer.completeSimilarity(), "re-embedded, same pairs: nothing to re-send")
        XCTAssertEqual(asked["a1"], 2)
        XCTAssertEqual(asked["zz"], 1, "a note that could not be embedded is not asked again while unchanged")
    }

    /// The real model, for a language other than English where this Mac has
    /// it: French notes get vectors, tagged French.
    func testTheSystemEmbeddingShouldReadANoteInItsOwnLanguage() throws {
        let embed = NoteSimilarity.systemEmbedder()
        guard let french = embed("L'assistant vocal doit confirmer avant d'agir en mon nom, et demander la permission") else {
            throw XCTSkip("no French contextual embedding installed on this Mac")
        }
        XCTAssertEqual(french.language, "fr")
        XCTAssertNil(embed(""), "an empty text has no language and no vector")
    }
}
