import XCTest
@testable import BirtaWriterCore

/// The matcher's three claims: what matches, what does not, and which of two
/// matches a person would want first.
final class FuzzyMatchTests: XCTestCase {
    private func score(_ query: String, _ candidate: String) -> Int? {
        FuzzyMatch.match(query, in: candidate)?.score
    }

    func testASubsequenceMatchesAndAnythingElseDoesNot() {
        XCTAssertNotNil(FuzzyMatch.match("ital", in: "Italic"))
        XCTAssertNotNil(FuzzyMatch.match("sca", in: "Save a Copy As…"), "letters in order, not adjacent")
        XCTAssertNotNil(FuzzyMatch.match("BOLD", in: "bold"), "case never matters")
        XCTAssertNil(FuzzyMatch.match("italx", in: "Italic"), "a letter the candidate lacks refuses the match")
        XCTAssertNil(FuzzyMatch.match("lati", in: "Italic"), "order matters")
    }

    /// The greedy walk alone refused these: it jumped from the T to a
    /// later word-start H and then found no m, on a title that starts with
    /// the query. The plain alignment stands in when it refuses.
    func testATitleThatStartsWithTheQueryIsNeverRefused() {
        let slate = FuzzyMatch.match("theme", in: "Theme › Harlan Slate")
        XCTAssertEqual(slate?.ranges, [0..<5], "the first word, as a run")
        XCTAssertNotNil(FuzzyMatch.match("theme", in: "Theme › System Theme"))
        XCTAssertNotNil(FuzzyMatch.match("theme", in: "Theme › Harlan Terminal (Amber)"))
        XCTAssertEqual(FuzzyMatch.match("sho", in: "Show Hidden Files")?.ranges, [0..<3],
                       "the shipped case: the H of Hidden took the h, and no o follows it")
        XCTAssertNil(FuzzyMatch.match("themez", in: "Theme › Harlan Slate"), "still a subsequence test: no z")
    }

    func testAnEmptyQueryMatchesEverythingAndMarksNothing() {
        let match = FuzzyMatch.match("", in: "Anything")
        XCTAssertEqual(match, FuzzyMatch.Match(score: 0, ranges: []))
    }

    func testTheRangesNameTheLettersMatchedAndMergeARun() {
        let match = FuzzyMatch.match("bo", in: "Bold")!
        XCTAssertEqual(match.ranges, [0..<2], "an adjacent run is one range")
        let spread = FuzzyMatch.match("sc", in: "Save a Copy As…")!
        XCTAssertEqual(spread.ranges, [0..<1, 7..<8], "the C of Copy, a word start, not the c nowhere else")
    }

    func testWordStartsOutrankLettersInsideAWord() {
        XCTAssertGreaterThan(score("sca", "Save a Copy As…")!, score("sca", "Strikethrough Case Aside")!,
                             "three word starts beat one word start and two buried letters")
        XCTAssertGreaterThan(score("b", "Bold")!, score("b", "Table")!)
    }

    func testARunOfLettersOutranksTheSameLettersScattered() {
        XCTAssertGreaterThan(score("bold", "Bold")!, score("bold", "Blockquote outdent lift down")!)
    }

    func testAShorterCandidateWinsATie() {
        XCTAssertGreaterThan(score("fold", "Fold")!, score("fold", "Fold every heading in the whole document")!)
    }

    func testACamelCaseCapitalIsAWordStart() {
        let match = FuzzyMatch.match("hp", in: "openHostPreferences")!
        XCTAssertEqual(match.ranges, [4..<5, 8..<9])
    }

    func testAPathMatchesOnItsSegments() {
        let match = FuzzyMatch.match("nb", in: "notes/sub/b.md")!
        XCTAssertEqual(match.ranges, [0..<1, 10..<11], "the b that starts a segment, past the b in sub")
    }
}
