import XCTest
@testable import BirtaWriterCore

/// What a publishing target withdraws, decided without a menu.
///
/// The membership table itself is held against the page's by
/// `shared/__tests__/syntaxSetsPort.test.ts`, so what is worth pinning here is
/// the behaviour that table is read THROUGH, and the one distinction the
/// storage has to keep: an empty stored list is a choice, and a missing one is
/// not.
final class SyntaxSetsTests: XCTestCase {
    func testEveryTargetShouldSpellSomething() {
        // A target that provides nothing is a switch that does nothing, and
        // `CaseIterable` is what makes this ask about a target added later.
        for set in SyntaxSet.allCases {
            XCTAssertFalse(SyntaxScope.features(of: set).isEmpty, "\(set) spells nothing")
        }
    }

    func testEveryTargetShouldHaveALabelAndASentenceOfItsOwn() {
        // Two rows reading the same words are two rows nobody can tell apart,
        // and the Settings pane draws one per target.
        let labels = SyntaxSet.allCases.map(\.label)
        let captions = SyntaxSet.allCases.map(\.caption)
        XCTAssertEqual(Set(labels).count, labels.count)
        XCTAssertEqual(Set(captions).count, captions.count)
        for text in labels + captions {
            XCTAssertFalse(text.isEmpty)
        }
    }

    func testNoTargetShouldSpellAFeatureNoOtherTargetLacks() {
        // A feature every target provides can never be withdrawn while any
        // target is on, which makes it part of the CommonMark floor wearing a
        // feature's clothes.
        for feature in SyntaxFeature.allCases {
            let providers = SyntaxSet.allCases.filter { SyntaxScope.features(of: $0).contains(feature) }
            XCTAssertFalse(providers.isEmpty, "no target spells \(feature)")
            XCTAssertLessThan(providers.count, SyntaxSet.allCases.count,
                              "\(feature) is spelled by every target, so nothing withdraws it")
        }
    }

    func testACommonMarkCommandShouldSurviveEveryTargetBeingOff() {
        for id in ["toggleBold", "insertCodeBlock", "toggleBlockquote", "toggleBulletList"] {
            XCTAssertTrue(SyntaxScope.allows(command: id, in: []), id)
        }
    }

    func testACommandWritingAnUnspelledSyntaxShouldBeWithdrawn() {
        for id in ["insertTable", "toggleStrikethrough", "insertFootnote", "insertMath"] {
            XCTAssertFalse(SyntaxScope.allows(command: id, in: []), id)
        }
    }

    func testACommandThatEditsWhatIsAlreadyThereShouldNeverBeWithdrawn() {
        // The rule the whole feature stands on: a document renders everything
        // it contains under every target, so a note holding a task list keeps
        // its tick box even where the editor no longer offers to make one.
        XCTAssertFalse(SyntaxScope.allows(command: "toggleTaskList", in: []))
        XCTAssertTrue(SyntaxScope.allows(command: "toggleTaskChecked", in: []))
        XCTAssertTrue(SyntaxScope.allows(command: "uncheckAllTasks", in: []))
    }

    func testTargetsShouldCombineAsAUnionRatherThanAnIntersection() {
        // Highlights are Obsidian's alone and fenced divs are Pandoc's alone,
        // so an intersection would withdraw both.
        let both: Set<SyntaxSet> = [.obsidian, .pandoc]
        XCTAssertTrue(SyntaxScope.allows(.highlight, in: both))
        XCTAssertTrue(SyntaxScope.allows(.fencedDiv, in: both))
        XCTAssertFalse(SyntaxScope.allows(.calc, in: both))
    }

    func testAnUnknownStoredNameShouldBeDroppedWithoutTakingTheKnownOnesWithIt() {
        XCTAssertEqual(SyntaxScope.sets(from: ["gfm", "markdownExtra"]), [.gfm])
    }

    func testAnEmptyStoredListShouldStayEmptyRatherThanReadingAsUnset() {
        // This is the CommonMark-only target. Reading it as "nothing stored"
        // would put every tool back the next time the app launched, silently
        // undoing the one choice the reader made deliberately.
        XCTAssertTrue(SyntaxScope.sets(from: []).isEmpty)
    }

    func testTheStoredSpellingShouldBeInVocabularyOrder() {
        // So writing the same choice twice does not churn the defaults domain,
        // and so a stored list is readable.
        XCTAssertEqual(SyntaxScope.stored([.pandoc, .gfm]), ["gfm", "pandoc"])
        XCTAssertEqual(SyntaxScope.stored(SyntaxScope.all), SyntaxSet.allCases.map(\.rawValue))
    }

    func testStoringAndReadingBackShouldRoundTrip() {
        for set in SyntaxSet.allCases {
            XCTAssertEqual(SyntaxScope.sets(from: SyntaxScope.stored([set])), [set])
        }
        XCTAssertEqual(SyntaxScope.sets(from: SyntaxScope.stored(SyntaxScope.all)), SyntaxScope.all)
    }
}
