import XCTest
import UniformTypeIdentifiers
@testable import BirtaJotCore

final class DocumentTypesTests: XCTestCase {
    /// Enumerated from the type rather than written out, so a fourth format
    /// joins every case below on the day it is added.
    func testEveryOpenedExtensionShouldBeAccepted() {
        XCTAssertFalse(DocumentTypes.opened.isEmpty, "no formats enumerated")
        for ext in DocumentTypes.opened {
            XCTAssertTrue(DocumentTypes.accepts(URL(fileURLWithPath: "/a/b/page.\(ext)")), ext)
        }
    }

    /// The Finder hands over the file's own spelling, and `README.MD` is a file
    /// people really have.
    func testAnUppercaseExtensionShouldBeAccepted() {
        for ext in DocumentTypes.opened {
            let upper = ext.uppercased()
            XCTAssertTrue(DocumentTypes.accepts(URL(fileURLWithPath: "/a/b/page.\(upper)")), upper)
        }
    }

    /// `open -a` passes whatever it is given, so the refusal is the half that
    /// has to work: nothing but a real extension may get through.
    func testAnythingElseShouldBeRefused() {
        for name in ["notes.txt", "notes", "page.md.bak", "mdx", "archive.mdxx", "shot.png"] {
            XCTAssertFalse(DocumentTypes.accepts(URL(fileURLWithPath: "/a/b/\(name)")), name)
        }
    }

    /// The list is lowercased, which is what `accepts` lowercasing the file's
    /// extension rests on. Spell one entry in capitals and every file of that
    /// format is turned away.
    func testTheListShouldBeLowercasedAndFreeOfDuplicates() {
        XCTAssertEqual(DocumentTypes.opened, DocumentTypes.opened.map { $0.lowercased() })
        XCTAssertEqual(Set(DocumentTypes.opened).count, DocumentTypes.opened.count)
    }

    /// A drop of several files, which is what a Finder selection sends.
    func testTheFirstOpenableFileShouldBeTheOneChosen() {
        let shot = URL(fileURLWithPath: "/a/shot.png")
        let note = URL(fileURLWithPath: "/a/note.\(DocumentTypes.opened[0])")
        let other = URL(fileURLWithPath: "/a/other.\(DocumentTypes.opened[0])")
        // Not simply the first: a selection whose first file this app cannot
        // open should still open the note further down it.
        XCTAssertEqual(DocumentTypes.firstToOpen(from: [shot, note, other]), note)
        XCTAssertEqual(DocumentTypes.firstToOpen(from: [note, other]), note)
    }

    /// Nothing openable still yields a URL, because the caller has a refusal to
    /// word and needs a file to name in it.
    func testAnUnopenableListShouldStillNameItsFirstFile() {
        let shot = URL(fileURLWithPath: "/a/shot.png")
        XCTAssertEqual(DocumentTypes.firstToOpen(from: [shot]), shot)
        XCTAssertNil(DocumentTypes.firstToOpen(from: []))
    }

    /// The two lists are different sizes on purpose, so the relation between
    /// them is worth stating: every file this app creates is one it can open
    /// again, and one the Finder will offer it back.
    func testTheWrittenExtensionShouldBeOneTheEditorOpens() {
        XCTAssertTrue(DocumentTypes.opened.contains(DocumentTypes.written), DocumentTypes.written)
        XCTAssertEqual(DocumentTypes.written, NoteNameTemplate.ext)
    }

    /// The fallback exists because an EMPTY `allowedContentTypes` is a panel
    /// that accepts any name at all, which is the opposite of what a caller
    /// asking for one type wants.
    func testTheWrittenContentTypesShouldNeverBeEmpty() {
        let types = DocumentTypes.writtenContentTypes
        XCTAssertFalse(types.isEmpty)
        // The lookup can legitimately fall back, so the extension is asserted
        // only where the lookup actually resolved to a real type.
        for type in types where type != .plainText {
            XCTAssertEqual(type.preferredFilenameExtension, DocumentTypes.written)
        }
    }
}
