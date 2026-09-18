import XCTest
@testable import BirtaWriterCore

/// The list of VS Code's installed themes as the picker offers it.
final class InstalledThemesPickTests: XCTestCase {
    private func source(_ label: String, _ ui: String?, _ path: String) -> ThemeSource {
        ThemeSource(label: label, uiTheme: ui, url: URL(fileURLWithPath: path))
    }

    private let sources = [
        ThemeSource(label: "Solarized Dark", uiTheme: "vs-dark",
                    url: URL(fileURLWithPath: "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-solarized-dark/themes/solarized-dark-color-theme.json")),
        ThemeSource(label: "Paper", uiTheme: "vs",
                    url: URL(fileURLWithPath: "/Users/me/.vscode/extensions/someone.paper-1.2.0/themes/paper.json")),
        ThemeSource(label: nil, uiTheme: nil, url: URL(fileURLWithPath: "/somewhere/loose-theme.json")),
    ]

    func testEveryRowShouldNameItsThemeItsExtensionAndItsKind() {
        let pick = InstalledThemesPick(sources: sources, held: [])
        XCTAssertEqual(pick.rows.map(\.name), ["Solarized Dark", "Paper", "loose-theme"])
        XCTAssertEqual(pick.rows.map(\.detail), ["theme-solarized-dark, Dark", "someone.paper-1.2.0, Light", ""])
        XCTAssertEqual(pick.rows.map(\.kind), [.dark, .light, nil])
        XCTAssertEqual(pick.rows.count, sources.count, "the enumeration reached every source")
    }

    func testAThemeTheLibraryHoldsShouldBeShownAndNotPickable() {
        var pick = InstalledThemesPick(sources: sources, held: ["paper"])
        XCTAssertEqual(pick.rows.map(\.alreadyAdded), [false, true, false])
        pick.toggle(pick.rows[1])
        XCTAssertTrue(pick.chosen.isEmpty, "a held theme cannot be picked again")
        pick.toggle(pick.rows[0])
        XCTAssertEqual(pick.chosen.map(\.label), ["Solarized Dark"])
    }

    func testTheAddButtonShouldCountThePicks() {
        var pick = InstalledThemesPick(sources: sources, held: [])
        XCTAssertEqual(pick.addTitle, "Add")
        pick.toggle(pick.rows[0])
        pick.toggle(pick.rows[2])
        XCTAssertEqual(pick.addTitle, "Add 2")
        XCTAssertEqual(pick.chosen.map(\.url.lastPathComponent), ["solarized-dark-color-theme.json", "loose-theme.json"],
                       "in the list's order, not the order of the picks")
        pick.toggle(pick.rows[0])
        XCTAssertEqual(pick.addTitle, "Add 1")
    }
}
