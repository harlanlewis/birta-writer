import AppKit
import XCTest
@testable import BirtaWriter

/// Whether the titlebar's three symbols sit on one line, measured off the
/// pixels rather than judged off a screenshot.
///
/// The geometry checks elsewhere put every BOX in the right place, and a box
/// in the right place is not the claim: AppKit centres an image in its button,
/// so a glyph whose ink hangs off centre inside its own image is drawn low
/// while every frame in the app reports correct. `square.and.pencil` is the
/// case that taught this. Its bounding box is centred like the others, because
/// the pencil tip reaches as far up as the square reaches down; what is not
/// centred is where the WEIGHT is, and weight is what the eye reads.
///
/// So the measurement is the ink's centre of mass, alpha weighted, taken in
/// the cell the button actually draws into. A bounding box cannot see this
/// defect and was tried first.
@MainActor
final class TitlebarSymbolsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    /// Where a symbol's ink balances, in pixels from the middle of the cell.
    /// Positive is low, because a bitmap's y grows downward.
    private struct Ink {
        let centre: Double
        let mass: Double
    }

    /// Render one shipped mark the way the button does, and weigh it.
    ///
    /// Drawn into the button's OWN cell rather than into the glyph's bounds,
    /// which is the only comparison that means anything: the images are
    /// different sizes and AppKit centres each of them in the same box, so a
    /// measurement in each glyph's own bounds compares boxes instead of what
    /// is drawn in them.
    ///
    /// Through `Glyph` rather than through `NSImage(systemSymbolName:)`, which
    /// is what lets this measure the drawn pane mark on the same axis as the
    /// symbols. A check that could only see SF Symbols would have gone on
    /// passing while the one mark this band does not get from the system sat
    /// off the line.
    private func ink(of glyph: TitlebarActionsView.Glyph) -> Ink? {
        guard var image = glyph.image(named: nil) else { return nil }
        if let config = glyph.symbolConfiguration,
           let configured = image.withSymbolConfiguration(config) {
            image = configured
        }
        let width = Int(TitlebarActionsView.buttonWidth)
        let height = Int(TitlebarActionsView.buttonHeight)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                                         pixelsWide: width, pixelsHigh: height,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.black.set()
        let size = image.size
        image.draw(in: NSRect(x: (CGFloat(width) - size.width) / 2,
                              y: (CGFloat(height) - size.height) / 2,
                              width: size.width, height: size.height))
        NSGraphicsContext.restoreGraphicsState()

        var weighted = 0.0
        var mass = 0.0
        for y in 0..<height {
            for x in 0..<width {
                guard let colour = rep.colorAt(x: x, y: y) else { continue }
                let alpha = Double(colour.alphaComponent)
                guard alpha > 0.05 else { continue }
                weighted += alpha * Double(y)
                mass += alpha
            }
        }
        guard mass > 0 else { return nil }
        return Ink(centre: weighted / mass - Double(height - 1) / 2, mass: mass)
    }

    /// Every symbol the titlebar draws, both rows of it: they sit on one axis
    /// across the whole band, so the leading toggle has to balance with the
    /// file buttons at the other end of the name rather than only with itself.
    private static let allShipped = TitlebarActionsView.leadingShipped + TitlebarActionsView.shipped

    func testEveryShippedSymbolShouldBalanceOnTheSameLineAsTheOthers() {
        let measured = Self.allShipped.map { (String(describing: $0.glyph), ink(of: $0.glyph)) }
        // The instrument's own arm, twice over. A symbol name the system does
        // not have renders nothing, and a set that measured nothing agrees
        // with itself perfectly; so does a set of one.
        for (symbol, ink) in measured {
            XCTAssertNotNil(ink, "\(symbol) drew no ink, so nothing below measured it")
        }
        // And the set really holds both kinds, or the sentence above about
        // measuring the drawn mark on the symbols' axis is describing a run
        // that never drew one.
        XCTAssertTrue(Self.allShipped.contains { if case .pane = $0.glyph { return true } else { return false } },
                      "no drawn mark in the set, so only SF Symbols were compared")
        XCTAssertTrue(Self.allShipped.contains { if case .symbol = $0.glyph { return true } else { return false } })
        let centres = measured.compactMap { $0.1?.centre }
        XCTAssertEqual(centres.count, Self.allShipped.count)
        XCTAssertGreaterThan(centres.count, 1, "one symbol cannot disagree with anything")

        let spread = (centres.max() ?? 0) - (centres.min() ?? 0)
        // Half a pixel, and the number is load-bearing rather than picked to
        // look careful. It has to admit the difference between two marks that
        // both look centred and refuse the difference a reader can see, and
        // the case this was written for is a whole pixel out. A tolerance of a
        // pixel would call that set balanced, which is the one answer it must
        // not give.
        XCTAssertLessThan(spread, 0.5, """
            the titlebar's symbols do not balance on one line: \
            \(measured.map { "\($0.0) \(String(format: "%+.2f", $0.1?.centre ?? 0))" }.joined(separator: ", "))
            """)
    }

    /// The pane mark's divider is on the LEADING side, which is the whole
    /// claim the glyph exists to make.
    ///
    /// `paneGlyphParity.test.ts` holds the numbers against the page's SVG and
    /// cannot see this: every number can be right and the mark still drawn
    /// mirrored, which is the one defect that would make the two ends of the
    /// band point the same way. So this reads the pixels.
    func testThePaneMarkShouldPutItsDividerOnTheLeadingSide() {
        let image = PaneGlyph.image()
        let size = image.size
        XCTAssertGreaterThan(size.width, 0, "the mark drew nothing to measure")
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                                         pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else {
            return XCTFail("no bitmap to draw into")
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.black.set()
        image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()

        // Ink per column, measured across the middle band only, so the
        // frame's own top and bottom edges (which are ink in every column)
        // cannot drown the divider out.
        let width = Int(size.width), height = Int(size.height)
        var columns = [Double](repeating: 0, count: width)
        for y in (height / 3)..<(height * 2 / 3) {
            for x in 0..<width {
                columns[x] += Double(rep.colorAt(x: x, y: y)?.alphaComponent ?? 0)
            }
        }
        XCTAssertGreaterThan(columns.reduce(0, +), 0, "the band measured no ink at all")

        // The page's own x, and its reflection. Asked as a pair rather than as
        // a peak: a mark drawn mirrored has ink at the reflection and none
        // here, a centred one has ink at neither, and each fails on its own
        // line. Both columns are clear of the frame's two sides, so what is
        // being read is the divider and nothing else.
        let here = Int((PaneGlyph.dividerX / PaneGlyph.viewBox * size.width).rounded())
        let mirrored = width - here
        XCTAssertGreaterThan(columns[here], 0,
                             "no divider at the page's x: the mark is centred, mirrored, or not drawn")
        XCTAssertEqual(columns[mirrored], 0, accuracy: 0.01,
                       "ink at the reflection: the mark is drawn the wrong way round")
    }

    func testTheMeasurementShouldSeeAGlyphThatHangsLow() {
        // The arm that says the check above can fail at all. `square.and.pencil`
        // is the mark this row used to carry and the reason the measurement
        // exists, so it stands in as a known-bad input: it must come out
        // clearly lower than the two symbols still shipped beside it.
        //
        // Without this, a measurement that returned the same number for
        // everything would pass the set silently, and it did: the bounding-box
        // version put this glyph within half a pixel of the others.
        guard let low = ink(of: .symbol("square.and.pencil")),
              let folder = ink(of: .symbol("folder")),
              let command = ink(of: .symbol("command")) else {
            return XCTFail("a symbol used as a reference did not resolve")
        }
        XCTAssertGreaterThan(low.centre - folder.centre, 0.5,
                             "the measurement cannot tell a low glyph from a centred one")
        XCTAssertGreaterThan(low.centre - command.centre, 0.5)
    }
}
