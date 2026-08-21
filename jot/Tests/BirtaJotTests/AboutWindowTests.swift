import AppKit
import BirtaJotCore
import XCTest
@testable import BirtaJot

/// The About window, built and laid out and read back before anything shows it.
///
/// `AboutInfoTests` holds what the window SAYS; this holds that it draws it.
/// The two are worth keeping apart for the reason the first-run screen is: a
/// line that is decided correctly and then never added to a stack is invisible
/// to every check written over the declaration alone.
///
/// The window is built from an injected `AboutInfo` rather than from the
/// bundle, because a test host has neither a version nor a copyright of its
/// own, and a window drawing neither cannot be checked for drawing both.
@MainActor
final class AboutWindowTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private static let info = AboutInfo(name: "Birta Writer Jot [TEST]",
                                        shortVersion: "2026.821.0",
                                        copyright: "Copyright © 2026 Somebody")

    private func text(in view: NSView) -> [String] {
        var found: [String] = []
        if let field = view as? NSTextField { found.append(field.stringValue) }
        for subview in view.subviews { found += text(in: subview) }
        return found
    }

    private func links(in view: NSView) -> [(title: String, url: URL)] {
        var found: [(title: String, url: URL)] = []
        if let button = view as? LinkButton { found.append((title: button.title, url: button.url)) }
        for subview in view.subviews { found += links(in: subview) }
        return found
    }

    private func laidOutContent(of controller: AboutWindowController) throws -> NSView {
        let view = try XCTUnwrap(controller.window?.contentView)
        view.layoutSubtreeIfNeeded()
        return view
    }

    func testTheWindowShouldDrawTheNameTheVersionAndTheCopyright() throws {
        let drawn = text(in: try laidOutContent(of: AboutWindowController(info: Self.info)))
        XCTAssertTrue(drawn.contains(Self.info.name), drawn.joined(separator: " | "))
        XCTAssertTrue(drawn.contains("Version 2026.821.0"), drawn.joined(separator: " | "))
        XCTAssertTrue(drawn.contains("Copyright © 2026 Somebody"), drawn.joined(separator: " | "))
    }

    /// Every link the type declares reaches the window, pointing where it says.
    ///
    /// Both halves matter: a button drawn with the wrong destination looks
    /// exactly like one drawn with the right one, and titles alone would pass
    /// with all three pointing at the same page.
    func testTheWindowShouldDrawEveryDeclaredLinkPointingWhereItSays() throws {
        let drawn = links(in: try laidOutContent(of: AboutWindowController(info: Self.info)))
        XCTAssertEqual(drawn.map(\.title), AboutLink.allCases.map(\.title))
        XCTAssertEqual(drawn.map(\.url), AboutLink.allCases.map(\.url))
    }

    /// A bundle-less build has no copyright, and the line goes rather than
    /// standing empty. Checked against the same window WITH one, so this
    /// cannot pass by the walk having reached nothing.
    func testAnAbsentCopyrightShouldDrawNoLineAtAll() throws {
        let without = AboutInfo(name: Self.info.name, shortVersion: "2026.821.0", copyright: nil)
        let drawnWithout = text(in: try laidOutContent(of: AboutWindowController(info: without)))
        let drawnWith = text(in: try laidOutContent(of: AboutWindowController(info: Self.info)))

        XCTAssertEqual(drawnWithout.count + 1, drawnWith.count)
        XCTAssertFalse(drawnWithout.contains(where: \.isEmpty), drawnWithout.joined(separator: " | "))
        XCTAssertTrue(drawnWithout.contains("Version 2026.821.0"))
    }

    /// The window is as wide as the row of links needs.
    ///
    /// The failure this exists for is a link added or renamed past the width a
    /// fixed window was drawn to, which clips the last one: the row still lays
    /// out, and nothing else in the app has an opinion about it.
    func testTheWindowShouldBeWideEnoughForTheRowOfLinksItDraws() throws {
        let controller = AboutWindowController(info: Self.info)
        let contentView = try laidOutContent(of: controller)
        let window = try XCTUnwrap(controller.window)
        let row = try XCTUnwrap(rowOfLinks(in: contentView))

        let available = window.contentRect(forFrameRect: window.frame).width
        XCTAssertGreaterThanOrEqual(
            available,
            row.fittingSize.width + AboutWindowController.Metrics.horizontalPadding * 2,
            "the links row is wider than the window drawing it")
        XCTAssertGreaterThanOrEqual(available, contentView.fittingSize.width)
        XCTAssertGreaterThanOrEqual(available, AboutWindowController.Metrics.minWidth)
    }

    /// Modeless, closable, and out of the Window menu: the shape every About
    /// window on the system has.
    func testTheWindowShouldBehaveTheWayAnAboutWindowDoes() throws {
        let window = try XCTUnwrap(AboutWindowController(info: Self.info).window)
        XCTAssertTrue(window.styleMask.contains(.closable))
        XCTAssertFalse(window.styleMask.contains(.resizable))
        XCTAssertTrue(window.isExcludedFromWindowsMenu)
        // The controller owns it and reopens the same one; released on close,
        // reopening would be a message to a freed window.
        XCTAssertFalse(window.isReleasedWhenClosed)
        // Set for VoiceOver even though the titlebar draws nothing.
        XCTAssertEqual(window.title, "About \(Self.info.name)")
        XCTAssertEqual(window.titleVisibility, .hidden)
    }

    private func rowOfLinks(in view: NSView) -> NSStackView? {
        if let stack = view as? NSStackView, !stack.arrangedSubviews.isEmpty,
           stack.arrangedSubviews.allSatisfy({ $0 is LinkButton }) {
            return stack
        }
        for subview in view.subviews {
            if let found = rowOfLinks(in: subview) { return found }
        }
        return nil
    }
}
