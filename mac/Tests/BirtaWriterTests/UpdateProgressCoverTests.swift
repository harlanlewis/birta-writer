import AppKit
import XCTest
@testable import BirtaWriter
import BirtaWriterCore

/// The cover a window wears between a confirmed update and the quit that puts
/// it in. What has to hold is that the page under it is out of reach and that
/// the card saying why sits in the bottom trailing corner, on screen, whatever
/// the window's width.
@MainActor
final class UpdateProgressCoverTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// In a container with a stand-in page beneath it, because `hitTest` takes
    /// its point in the SUPERVIEW's coordinates and what matters is which of
    /// the two siblings a click reaches.
    private func covered(width: CGFloat = 640, height: CGFloat = 400)
        -> (container: NSView, page: NSView, cover: UpdateProgressCover) {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        let page = NSView(frame: container.bounds)
        container.addSubview(page)
        let cover = UpdateProgressCover()
        cover.frame = container.bounds
        container.addSubview(cover, positioned: .above, relativeTo: nil)
        cover.show(UpdatePolicy.downloadingNotice(tag: "v2026.1008.1"),
                   detail: UpdatePolicy.installProgressDetail(appName: "Birta Writer",
                                                              hasUnwrittenBytes: true))
        container.layoutSubtreeIfNeeded()
        return (container, page, cover)
    }

    private func card(of cover: UpdateProgressCover) throws -> NSView {
        cover.card
    }

    func testEveryPointOnThePageShouldReachTheCoverAndNeverThePage() throws {
        let (container, page, cover) = covered()
        let card = try card(of: cover)
        let points = [
            NSPoint(x: 10, y: 390), NSPoint(x: 320, y: 200), NSPoint(x: 630, y: 10),
            // On the card itself: nothing there is a control, so it is the
            // cover's too rather than a hole through to the page.
            cover.convert(NSPoint(x: card.frame.midX, y: card.frame.midY), to: container),
        ]
        for point in points {
            let hit = container.hitTest(point)
            XCTAssertTrue(hit === cover, "\(point) reached \(String(describing: hit))")
            XCTAssertFalse(hit === page)
        }
    }

    func testTheCardShouldSayThePhaseAndWhatHappensNext() {
        let (_, _, cover) = covered()
        XCTAssertEqual(cover.shownText.title, "Downloading 2026.1008.1…")
        XCTAssertTrue(cover.shownText.detail.contains("Editing is paused"))
        cover.show(UpdatePolicy.installingNotice(tag: "v2026.1008.1"), detail: cover.shownText.detail)
        XCTAssertEqual(cover.shownText.title, "Installing 2026.1008.1…")
    }

    func testTheCardShouldSitInTheBottomTrailingCornerAndFitANarrowWindow() throws {
        for width: CGFloat in [640, 300] {
            let (_, _, cover) = covered(width: width)
            let card = try card(of: cover)
            XCTAssertGreaterThan(card.frame.width, 0)
            XCTAssertEqual(card.frame.maxX, width - UpdateProgressCover.inset, accuracy: 0.5, "width \(width)")
            XCTAssertEqual(card.frame.minY, UpdateProgressCover.inset, accuracy: 0.5, "width \(width)")
            XCTAssertGreaterThanOrEqual(card.frame.minX, UpdateProgressCover.inset - 0.5, "width \(width)")
        }
    }

    /// A column left to its labels' own sizes settles at the smallest width
    /// its constraints allow, truncating the title and dropping the detail's
    /// last line. Read back as what each label NEEDS against what it was given.
    func testTheCardShouldShowItsWordsWholeAtAComfortableWidth() {
        let (_, _, cover) = covered(width: 640)
        let title = cover.titleLabel
        XCTAssertGreaterThanOrEqual(title.frame.width, title.intrinsicContentSize.width - 0.5,
                                    "the title is truncated at a width that has room for it")
        let detail = cover.detailLabel
        let needed = detail.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: detail.frame.width,
                                                             height: .greatestFiniteMagnitude)).height
        XCTAssertGreaterThanOrEqual(detail.frame.height, needed - 0.5, "the detail lost a line")
        XCTAssertGreaterThan(needed, title.frame.height, "the detail should wrap onto more than one line")
    }

    func testANarrowWindowShouldStillShowTheWholeDetail() {
        let (_, _, cover) = covered(width: 220)
        let detail = cover.detailLabel
        let needed = detail.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: detail.frame.width,
                                                             height: .greatestFiniteMagnitude)).height
        XCTAssertGreaterThanOrEqual(detail.frame.height, needed - 0.5)
    }

    func testTheCoverShouldDimThePageInItsOwnPaper() throws {
        let (_, _, cover) = covered()
        cover.paper = .black
        let ground = try XCTUnwrap(cover.layer?.backgroundColor.flatMap(NSColor.init(cgColor:)))
        XCTAssertEqual(ground.alphaComponent, UpdateProgressCover.dimAlpha, accuracy: 0.01)
        XCTAssertLessThan(UpdateProgressCover.dimAlpha, 1, "an opaque cover hides the note rather than dimming it")
    }

    func testTheCoverShouldTakeKeysSoTheyNeverReachThePage() {
        let (_, _, cover) = covered()
        XCTAssertTrue(cover.acceptsFirstResponder)
    }
}
