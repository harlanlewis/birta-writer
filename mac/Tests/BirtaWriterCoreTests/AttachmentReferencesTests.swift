import XCTest
@testable import BirtaWriterCore

final class AttachmentReferencesTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("mac-refs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: finding references

    func testFindsAnImageReferenceIntoTheAttachmentsFolder() {
        let found = AttachmentReferences.find(in: "text\n\n![a shot](Attachments/ab12.png)\n")

        XCTAssertEqual(found, [.init(reference: "Attachments/ab12.png", name: "ab12.png")])
    }

    func testFindsSeveralInDocumentOrderWithoutRepeats() {
        let md = """
        ![one](Attachments/a.png)
        ![two](Attachments/b.png)
        ![again](Attachments/a.png)
        """

        XCTAssertEqual(AttachmentReferences.find(in: md).map(\.name), ["a.png", "b.png"])
    }

    func testIgnoresImagesOutsideTheAttachmentsFolder() {
        let md = """
        ![remote](https://example.com/x.png)
        ![sibling](photo.png)
        ![up](../elsewhere/Attachments/x.png)
        ![absolute](/Users/someone/Attachments/x.png)
        """

        XCTAssertEqual(AttachmentReferences.find(in: md), [])
    }

    func testIgnoresALinkThatIsNotAnImage() {
        // `[text](Attachments/a.png)` is a link to the file, not an embed. The
        // store never writes one, and treating it as an attachment would make
        // Save As copy files the document merely points at.
        XCTAssertEqual(AttachmentReferences.find(in: "[see the file](Attachments/a.png)"), [])
    }

    func testIgnoresANestedPathInsideTheFolder() {
        // The store writes flat names; a nested path is either hand-authored or
        // an attempt to reach out of the folder, and neither is ours to move.
        XCTAssertEqual(AttachmentReferences.find(in: "![x](Attachments/sub/a.png)"), [])
        XCTAssertEqual(AttachmentReferences.find(in: "![x](Attachments/../secret.png)"), [])
    }

    func testDecodesAPercentEncodedSpace() {
        let found = AttachmentReferences.find(in: "![x](Attachments/my%20shot.png)")

        XCTAssertEqual(found.map(\.name), ["my shot.png"])
    }

    func testAnEmptyAltStillCounts() {
        XCTAssertEqual(AttachmentReferences.find(in: "![](Attachments/a.png)").map(\.name), ["a.png"])
    }

    // MARK: the migration plan

    func testAPlanCopiesOnlyTheFilesTheDocumentNames() {
        let source = dir.appendingPathComponent("Scratchpad.md")
        let target = dir.appendingPathComponent("out/Note.md")
        let md = "![used](Attachments/used.png)"

        let plan = AttachmentReferences.migrationPlan(markdown: md, from: source, to: target)

        XCTAssertEqual(plan.copies.count, 1)
        XCTAssertEqual(plan.copies[0].from.lastPathComponent, "used.png")
        XCTAssertEqual(plan.copies[0].to,
                       dir.appendingPathComponent("out/Attachments/used.png"))
    }

    func testAPlanIsEmptyWhenTheDocumentReferencesNoAttachments() {
        let plan = AttachmentReferences.migrationPlan(
            markdown: "just words\n\n![remote](https://example.com/x.png)",
            from: dir.appendingPathComponent("a.md"),
            to: dir.appendingPathComponent("out/b.md"))

        XCTAssertTrue(plan.isEmpty)
    }

    func testSavingIntoTheSameFolderNeedsNoCopies() {
        // Save As onto a sibling of the scratchpad: the folder is already the
        // right one, and copying a file over itself is at best wasted work.
        let plan = AttachmentReferences.migrationPlan(
            markdown: "![x](Attachments/a.png)",
            from: dir.appendingPathComponent("Scratchpad.md"),
            to: dir.appendingPathComponent("Graduated.md"))

        XCTAssertTrue(plan.isEmpty)
    }

    // MARK: applying a plan

    func testApplyCopiesTheFilesAndReportsNoFailures() throws {
        let source = dir.appendingPathComponent("Scratchpad.md")
        let target = dir.appendingPathComponent("out/Note.md")
        let store = AttachmentStore()
        let reference = try store.save(Data("png bytes".utf8), mimeType: "image/png", besideDocument: source)
        let md = "![x](\(reference))"

        let failed = AttachmentReferences.apply(
            AttachmentReferences.migrationPlan(markdown: md, from: source, to: target))

        XCTAssertEqual(failed, [])
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("out/\(reference)")),
                       Data("png bytes".utf8))
    }

    func testApplyReportsAMissingSourceRatherThanThrowing() {
        let source = dir.appendingPathComponent("Scratchpad.md")
        let target = dir.appendingPathComponent("out/Note.md")

        let failed = AttachmentReferences.apply(
            AttachmentReferences.migrationPlan(markdown: "![x](Attachments/gone.png)",
                                               from: source, to: target))

        XCTAssertEqual(failed, ["gone.png"])
    }

    func testApplyCarriesOnPastAFailure() throws {
        let source = dir.appendingPathComponent("Scratchpad.md")
        let target = dir.appendingPathComponent("out/Note.md")
        let store = AttachmentStore()
        let good = try store.save(Data("real".utf8), mimeType: "image/png", besideDocument: source)
        let md = "![missing](Attachments/gone.png)\n![real](\(good))"

        let failed = AttachmentReferences.apply(
            AttachmentReferences.migrationPlan(markdown: md, from: source, to: target))

        XCTAssertEqual(failed, ["gone.png"])
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: dir.appendingPathComponent("out/\(good)").path),
            "the file that could be copied must still arrive")
    }

    func testTheReferenceItselfNeverChanges() {
        // The document text is not rewritten, and that is the point of naming
        // the folder rather than pathing to it: the same relative reference is
        // correct in both homes.
        let md = "![x](Attachments/a.png)"
        let plan = AttachmentReferences.migrationPlan(
            markdown: md,
            from: dir.appendingPathComponent("Scratchpad.md"),
            to: dir.appendingPathComponent("out/Note.md"))

        XCTAssertEqual(plan.copies[0].to.lastPathComponent,
                       AttachmentReferences.find(in: md)[0].name)
    }
}
