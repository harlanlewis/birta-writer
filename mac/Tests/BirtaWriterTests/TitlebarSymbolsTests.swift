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

    /// How many samples per point the pane mark is measured at.
    ///
    /// Four, and the number is load-bearing. What this file has to be able to
    /// see is half a stroke width, which on a 16 point mark is two thirds of a
    /// point; measured at one sample per point, an edge two thirds of a point
    /// out lands in the same column as one that is right, and the check passes
    /// over the exact defect it was written for. That is not a hypothetical:
    /// the first version of this measured at 1x and a deliberate revert to the
    /// wrong geometry went green.
    private static let paneSamplesPerPoint = 4

    /// Ink per sample column of the pane mark, across its middle band, in
    /// units of "how much of the band is inked".
    ///
    /// The middle band only, so the frame's own top and bottom edges (which
    /// are ink in every column) cannot drown out what is between them.
    private func paneColumns(filled: Bool = false) -> [Double] {
        let image = PaneGlyph.image(paneFilled: filled)
        let up = Self.paneSamplesPerPoint
        let width = Int(image.size.width) * up, height = Int(image.size.height) * up
        guard width > 0, let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0,
        ) else { return [] }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.black.set()
        image.draw(in: NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        NSGraphicsContext.restoreGraphicsState()

        var columns = [Double](repeating: 0, count: width)
        let band = (height / 3)..<(height * 2 / 3)
        for y in band {
            for x in 0..<width {
                columns[x] += Double(rep.colorAt(x: x, y: y)?.alphaComponent ?? 0)
            }
        }
        return columns.map { $0 / Double(band.count) }
    }

    /// A sample column's index for a point on the page's own 24-unit axis.
    private func paneSample(at unit: CGFloat) -> Int {
        Int((unit / PaneGlyph.viewBox * PaneGlyph.drawnSize).rounded()) * Self.paneSamplesPerPoint
    }

    /// Where the ink starts and stops, in POINTS, so the assertions read on
    /// the page's own scale rather than in samples.
    private func paneInkEdges(_ columns: [Double]) -> (first: Double, last: Double)? {
        guard let first = columns.firstIndex(where: { $0 > 0.05 }),
              let last = columns.lastIndex(where: { $0 > 0.05 }) else { return nil }
        let up = Double(Self.paneSamplesPerPoint)
        return (Double(first) / up, Double(last + 1) / up)
    }

    /// The pane mark's divider is on the LEADING side, which is the whole
    /// claim the glyph exists to make.
    ///
    /// `paneGlyphParity.test.ts` holds the numbers against the page's SVG and
    /// cannot see this: every number can be right and the mark still drawn
    /// mirrored, which is the one defect that would make the two ends of the
    /// band point the same way. So this reads the pixels.
    func testThePaneMarkShouldPutItsDividerOnTheLeadingSide() {
        let columns = paneColumns()
        XCTAssertFalse(columns.isEmpty, "the mark drew nothing to measure")
        XCTAssertGreaterThan(columns.reduce(0, +), 0, "the band measured no ink at all")

        // The page's own x, and its reflection. Asked as a pair rather than as
        // a peak: a mark drawn mirrored has ink at the reflection and none
        // here, a centred one has ink at neither, and each fails on its own
        // line. Both columns are clear of the frame's two sides, so what is
        // being read is the divider and nothing else.
        let here = paneSample(at: PaneGlyph.dividerX)
        XCTAssertGreaterThan(columns[here], 0,
                             "no divider at the page's x: the mark is centred, mirrored, or not drawn")
        XCTAssertEqual(columns[columns.count - here], 0, accuracy: 0.01,
                       "ink at the reflection: the mark is drawn the wrong way round")
    }

    /// The mark is the size the page draws it, which the numbers cannot say.
    ///
    /// This is the check the parity test could not be. An SVG stroke straddles
    /// its path; a stroke inset inside the path draws a mark one stroke width
    /// smaller on every side, with tighter corners, out of numbers that all
    /// match. That is what this drew before, and beside the page's mark a few
    /// inches away it was visibly not the same glyph while every check passed.
    ///
    /// So the OUTER extent of the ink is measured and compared with where the
    /// browser puts it: the frame's path inset by `frameInset`, less half a
    /// stroke for the half that falls outside.
    func testThePaneMarkShouldBeTheSizeTheBrowserDrawsIt() {
        let columns = paneColumns()
        XCTAssertFalse(columns.isEmpty, "the mark drew nothing to measure")
        guard let ink = paneInkEdges(columns) else {
            return XCTFail("no ink in the band, so neither edge means anything")
        }
        let scale = PaneGlyph.drawnSize / PaneGlyph.viewBox
        let stroke = PaneGlyph.strokeWidth * scale
        let outerLeft = PaneGlyph.frameInset * scale - stroke / 2
        let outerRight = (PaneGlyph.viewBox - PaneGlyph.frameInset) * scale + stroke / 2
        // A third of a point, which is half of what this has to discriminate:
        // an inset stroke puts each edge half a stroke width (two thirds of a
        // point) inside where the browser puts it. The tolerance is for
        // antialiasing at the sampling rate above, and it is deliberately
        // smaller than the defect rather than merely "small".
        XCTAssertEqual(ink.first, Double(outerLeft), accuracy: 0.34,
                       "the frame starts in the wrong place: the stroke is not straddling its path")
        XCTAssertEqual(ink.last, Double(outerRight), accuracy: 0.34,
                       "the frame ends in the wrong place: the stroke is not straddling its path")
    }

    /// The filled state inks the PANE and nothing else.
    func testTheFilledPaneMarkShouldInkTheLeadingPaneAndNotTheRest() {
        let plain = paneColumns()
        let filled = paneColumns(filled: true)
        XCTAssertFalse(plain.isEmpty || filled.isEmpty, "a state drew nothing to measure")

        // Between the frame's left edge and the divider there is one column of
        // ink in the plain mark and a solid block in the filled one. Sampled
        // in the middle of that run rather than at its edges, which belong to
        // the frame and the divider in both states.
        let mid = paneSample(at: (PaneGlyph.frameInset + PaneGlyph.dividerX) / 2)
        XCTAssertEqual(plain[mid], 0, accuracy: 0.01, "the plain mark has ink inside its pane")
        XCTAssertGreaterThan(filled[mid], 0.9, "the filled mark does not ink its pane")

        // ...and the other side of the divider is empty in both, or this is a
        // mark that fills itself rather than its pane.
        let beyond = paneSample(at: (PaneGlyph.dividerX + PaneGlyph.viewBox - PaneGlyph.frameInset) / 2)
        XCTAssertEqual(plain[beyond], 0, accuracy: 0.01)
        XCTAssertEqual(filled[beyond], 0, accuracy: 0.01,
                       "the fill ran past the divider, so it is not the pane that is inked")

        // The frame did not move between the states, which is what makes them
        // two states of one mark rather than two marks.
        XCTAssertEqual(paneInkEdges(plain)?.first, paneInkEdges(filled)?.first)
        XCTAssertEqual(paneInkEdges(plain)?.last, paneInkEdges(filled)?.last)
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
