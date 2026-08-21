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

    /// The window is as wide as the column of links needs.
    ///
    /// The failure this exists for is a link added or renamed past the width a
    /// fixed window was drawn to, which clips its title: the column still lays
    /// out, and nothing else in the app has an opinion about it.
    func testTheWindowShouldBeWideEnoughForTheLinksItDraws() throws {
        let controller = AboutWindowController(info: Self.info)
        let contentView = try laidOutContent(of: controller)
        let window = try XCTUnwrap(controller.window)
        let column = try XCTUnwrap(columnOfLinks(in: contentView))

        // `intrinsicContentSize` rather than `fittingSize`: each button carries
        // a required width constraint, which fittingSize reports back, so the
        // comparison would be the column against itself.
        for button in column.arrangedSubviews {
            XCTAssertGreaterThanOrEqual(button.frame.width, button.intrinsicContentSize.width,
                                        "\((button as? NSButton)?.title ?? "?") is drawn narrower than its title")
        }
        let available = window.contentRect(forFrameRect: window.frame).width
        XCTAssertGreaterThanOrEqual(
            available,
            column.fittingSize.width + AboutWindowController.Metrics.horizontalPadding * 2,
            "the links are wider than the window drawing them")
        XCTAssertGreaterThanOrEqual(available, contentView.fittingSize.width)
    }

    /// The links are one stack of same-width buttons rather than a ragged set
    /// of three, which is what makes them read as a group.
    ///
    /// Bordered, which is the part worth pinning: the same class draws link
    /// text beside a settings field, and this window turns that off. A row of
    /// link text is the one shape the About windows this follows never use.
    func testTheLinksShouldBeButtonsOfOneWidth() throws {
        let column = try XCTUnwrap(columnOfLinks(in: laidOutContent(of: AboutWindowController(info: Self.info))))
        let widths = Set(column.arrangedSubviews.map(\.frame.width))

        XCTAssertEqual(column.arrangedSubviews.count, AboutLink.allCases.count)
        XCTAssertEqual(widths.count, 1, "the links are drawn at \(widths.count) different widths")
        XCTAssertGreaterThanOrEqual(widths.first ?? 0, AboutWindowController.Metrics.minColumnWidth)
        for button in column.arrangedSubviews {
            XCTAssertTrue((button as? NSButton)?.isBordered == true)
        }
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

    private func columnOfLinks(in view: NSView) -> NSStackView? {
        if let stack = view as? NSStackView, !stack.arrangedSubviews.isEmpty,
           stack.arrangedSubviews.allSatisfy({ $0 is LinkButton }) {
            return stack
        }
        for subview in view.subviews {
            if let found = columnOfLinks(in: subview) { return found }
        }
        return nil
    }
}
