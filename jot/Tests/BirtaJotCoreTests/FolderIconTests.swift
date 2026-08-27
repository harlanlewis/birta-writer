import XCTest
@testable import BirtaJotCore

/// What decides whether a notes folder wears the app's mark, and where the mark
/// sits on it.
final class FolderIconTests: XCTestCase {
    private let folder = URL(fileURLWithPath: "/tmp/jot-test/Birta Writer")

    /// The name ends in a carriage return, which is invisible everywhere it is
    /// printed. A constant spelled `Icon\n` would look identical in a diff, in
    /// a terminal and in a review, and would silently mark nothing.
    func testTheMarkerShouldBeNamedWithACarriageReturn() {
        XCTAssertEqual(FolderIcon.markerName, "Icon\r")
        XCTAssertTrue(FolderIcon.markerName.hasSuffix("\r"))
        XCTAssertFalse(FolderIcon.markerName.hasSuffix("\n"))
    }

    func testAFolderWithTheMarkerShouldCountAsMarked() {
        let marked = folder.appendingPathComponent("Icon\r")

        XCTAssertTrue(FolderIcon.isMarked(folder, exists: { $0 == marked }))
        XCTAssertFalse(FolderIcon.isMarked(folder, exists: { _ in false }))
    }

    /// A folder somebody has already given a picture to is left alone. This is
    /// the difference between marking a folder once and re-deciding on every
    /// launch, which would take a choice away from anybody who had made one.
    func testAFolderThatAlreadyCarriesAnIconShouldBeLeftAlone() {
        XCTAssertFalse(FolderIcon.shouldMark(folder,
                                             isDirectory: { _ in true },
                                             exists: { _ in true }))
    }

    /// Badging a folder creates it, and the folders this app names include ones
    /// it may only be about to use. A location somebody is still choosing on
    /// the first-run screen must not be brought into being by a decoration.
    func testAFolderThatIsNotThereShouldNotBeCreatedByBadgingIt() {
        XCTAssertFalse(FolderIcon.shouldMark(folder,
                                             isDirectory: { _ in false },
                                             exists: { _ in false }))
    }

    func testAnUnmarkedFolderThatExistsShouldBeMarked() {
        XCTAssertTrue(FolderIcon.shouldMark(folder,
                                            isDirectory: { _ in true },
                                            exists: { _ in false }))
    }

    /// Centred across, and BELOW the middle going up.
    ///
    /// The vertical number is the only interesting one: a folder icon is not
    /// vertically symmetric, because the tab occupies the top, so a mark
    /// centred on the image reads as floating above the front face it is
    /// supposed to be sitting on.
    func testTheMarkShouldSitCentredAcrossAndBelowTheMiddle() {
        let size = CGSize(width: 512, height: 512)
        let rect = FolderIcon.markRect(in: size)

        XCTAssertEqual(rect.midX, size.width / 2, accuracy: 0.001, "not centred across the folder")
        XCTAssertLessThan(rect.midY, size.height / 2, "the mark should sit on the front face, not above it")
        XCTAssertEqual(rect.width, rect.height, accuracy: 0.001, "the app's icon is square")
    }

    /// It has to leave the folder looking like a folder. A mark that filled the
    /// icon would cover the tab, and the tab is the whole of what says "folder"
    /// rather than "document".
    func testTheMarkShouldLeaveTheFolderReadableAsAFolder() {
        let size = CGSize(width: 512, height: 512)
        let rect = FolderIcon.markRect(in: size)

        XCTAssertLessThan(rect.width, size.width * 0.7, "the mark crowds the folder out")
        XCTAssertGreaterThan(rect.width, size.width * 0.35, "the mark is too small to recognise")
        XCTAssertTrue(size.height - rect.maxY > size.height * 0.1,
                      "the mark reaches into the folder's tab")
        XCTAssertTrue(rect.minY > 0, "the mark hangs off the bottom of the folder")
    }

    /// Scaling is proportional, so the same composition is used at whatever
    /// size the Finder asks for.
    func testTheMarkShouldScaleWithTheFolder() {
        let small = FolderIcon.markRect(in: CGSize(width: 128, height: 128))
        let large = FolderIcon.markRect(in: CGSize(width: 512, height: 512))

        XCTAssertEqual(large.width / small.width, 4, accuracy: 0.001)
        XCTAssertEqual(large.minY / small.minY, 4, accuracy: 0.001)
    }
}
