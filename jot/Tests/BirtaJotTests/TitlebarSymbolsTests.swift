import AppKit
import XCTest
@testable import BirtaJot

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

    /// Render one shipped symbol the way the button does, and weigh it.
    ///
    /// Drawn into the button's OWN cell rather than into the glyph's bounds,
    /// which is the only comparison that means anything: the three images are
    /// different sizes and AppKit centres each of them in the same box, so a
    /// measurement in each glyph's own bounds compares three boxes instead of
    /// what is drawn in them.
    private func ink(of symbol: String) -> Ink? {
        let config = NSImage.SymbolConfiguration(pointSize: TitlebarActionsView.symbolPointSize,
                                                 weight: .medium)
        guard let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(config) else { return nil }
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

    func testEveryShippedSymbolShouldBalanceOnTheSameLineAsTheOthers() {
        let measured = TitlebarActionsView.shipped.map { ($0.symbol, ink(of: $0.symbol)) }
        // The instrument's own arm, twice over. A symbol name the system does
        // not have renders nothing, and a set that measured nothing agrees
        // with itself perfectly; so does a set of one.
        for (symbol, ink) in measured {
            XCTAssertNotNil(ink, "\(symbol) drew no ink, so nothing below measured it")
        }
        let centres = measured.compactMap { $0.1?.centre }
        XCTAssertEqual(centres.count, TitlebarActionsView.shipped.count)
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

    func testTheMeasurementShouldSeeAGlyphThatHangsLow() {
        // The arm that says the check above can fail at all. `square.and.pencil`
        // is the mark this row used to carry and the reason the measurement
        // exists, so it stands in as a known-bad input: it must come out
        // clearly lower than the two symbols still shipped beside it.
        //
        // Without this, a measurement that returned the same number for
        // everything would pass the set silently, and it did: the bounding-box
        // version put this glyph within half a pixel of the others.
        guard let low = ink(of: "square.and.pencil"),
              let folder = ink(of: "folder"),
              let clock = ink(of: "clock") else {
            return XCTFail("a symbol used as a reference did not resolve")
        }
        XCTAssertGreaterThan(low.centre - folder.centre, 0.5,
                             "the measurement cannot tell a low glyph from a centred one")
        XCTAssertGreaterThan(low.centre - clock.centre, 0.5)
    }
}
