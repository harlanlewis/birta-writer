import XCTest
@testable import BirtaWriterCore

/// The colour mod as declarations, and the palette seeds it restates.
final class AppearanceOverlayTests: XCTestCase {
    private func decls(kind: VSCodeTheme.Kind = .light, base: VSCodeTheme? = nil, accent: String? = nil,
                       tint: String? = nil, sidebar: Bool = false) -> [String: String] {
        Dictionary(uniqueKeysWithValues: AppearanceOverlay.declarations(
            kind: kind, base: base, accent: accent, tint: tint, transparentSidebar: sidebar
        ).map { ($0.name, $0.value) })
    }

    func testNothingSetShouldDeclareNothing() {
        XCTAssertTrue(AppearanceOverlay.declarations(kind: .light, base: nil, accent: nil, tint: nil,
                                                     transparentSidebar: false).isEmpty)
    }

    func testTheAccentShouldSeedFocusBorderAndRestateEveryLiteralTheSeedDoesNotReach() {
        let d = decls(accent: "#ff0080")
        XCTAssertEqual(d["--vscode-focusBorder"], "#ff0080")
        XCTAssertEqual(d["--vscode-editorInfo-foreground"], "#ff0080")
        XCTAssertEqual(d["--vscode-charts-blue"], "#ff0080")
        XCTAssertEqual(d["--vscode-textLink-activeForeground"], "#d9006d", "the accent, darker, as the palette's own active link is")
        XCTAssertEqual(d["--vscode-button-hoverBackground"], "#d9006d")
        XCTAssertEqual(d["--vscode-editor-hoverHighlightBackground"], "rgba(255, 0, 128, 0.1)")
        XCTAssertEqual(d["--vscode-editor-selectionBackground"], "#ffb3d9", "the accent mixed into white paper")
        XCTAssertEqual(d["--vscode-textLink-foreground"], "#ff0080", "restated, so a theme's own link colour loses to it")
        XCTAssertEqual(d["--vscode-button-background"], "#ff0080")
        XCTAssertNil(d["--vscode-editor-background"], "an accent leaves the paper alone")
        // Dark paper: the pressed shade goes lighter, and the washes are
        // stronger, as the dark palette's own are.
        let dark = decls(kind: .dark, accent: "#ff0080")
        XCTAssertEqual(dark["--vscode-textLink-activeForeground"], "#ff2693")
        XCTAssertEqual(dark["--vscode-editor-hoverHighlightBackground"], "rgba(255, 0, 128, 0.18)")
    }

    func testTheTintShouldMixIntoTheSurfacesAndTheAccentShouldMixIntoTheTintedPaper() {
        let d = decls(kind: .light, accent: "#0000ff", tint: "#ff0000")
        XCTAssertEqual(d["--vscode-editor-background"], "#ffe8e8", "white paper, a breath of red")
        XCTAssertEqual(d["--vscode-editorWidget-background"], "#f7e0e1")
        XCTAssertEqual(d["--vscode-input-background"], "#ffe8e8")
        XCTAssertEqual(d["--vscode-checkbox-background"], "#ffe8e8")
        // The selection is the accent into the TINTED paper, not the white.
        XCTAssertEqual(d["--vscode-editor-selectionBackground"], "#b3a2ef")
        let dark = decls(kind: .dark, tint: "#ff0000")
        XCTAssertEqual(dark["--vscode-editor-background"], "#421919", "more of it on dark paper")
    }

    func testUnderAThemeTheTintShouldMixIntoTheThemesOwnSurfaces() {
        let slate = VSCodeTheme(name: "Slate", kind: .dark,
                                colors: ["editor.background": "#182529", "editorWidget.background": "#1f2e33"])
        let d = decls(kind: .dark, base: slate, tint: "#ffffff")
        XCTAssertEqual(d["--vscode-editor-background"], "#3d484b")
        XCTAssertEqual(d["--vscode-editorWidget-background"], "#434f54")
    }

    func testATransparentSidebarShouldTakeThePaperByReferenceSoItFollowsAnyTheme() {
        XCTAssertEqual(decls(sidebar: true)["--vscode-sideBar-background"], "var(--vscode-editor-background)")
    }

    func testAnUnreadableColourShouldBeIgnoredRatherThanWrittenIntoAStylesheet() {
        XCTAssertTrue(AppearanceOverlay.declarations(kind: .light, base: nil, accent: "red", tint: "#12",
                                                     transparentSidebar: false).isEmpty)
    }

    /// The seeds restated here are the palette's, and this is the only
    /// thing that says so.
    func testTheRestatedSeedsShouldBeThePalettesOwn() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let css = try String(contentsOf: root.appendingPathComponent("webview/ui/hostPalette.css"), encoding: .utf8)
        guard let split = css.range(of: ":root:has(body.vscode-dark)") else {
            return XCTFail("hostPalette.css no longer has its dark block; this guard needs rewriting")
        }
        let blocks: [(VSCodeTheme.Kind, Substring)] = [(.light, css[..<split.lowerBound]), (.dark, css[split.upperBound...])]
        var compared = 0
        for (kind, block) in blocks {
            for (id, hex) in AppearanceOverlay.systemPalette(kind) {
                let name = VSCodeTheme.cssVariable(for: id) + ":"
                guard let at = block.range(of: name) else {
                    return XCTFail("\(kind): \(name) is not in the palette's block")
                }
                let rest = block[at.upperBound...]
                let value = rest[..<(rest.firstIndex(of: ";") ?? rest.endIndex)].trimmingCharacters(in: .whitespaces)
                XCTAssertEqual(value.lowercased(), hex, "\(kind) \(id): the palette says \(value)")
                compared += 1
            }
        }
        XCTAssertEqual(compared, 8, "four seeds in each of two blocks")
    }

    func testTheSwatchesShouldBeReadableColours() {
        for (_, hex) in AppearanceOverlay.accents + AppearanceOverlay.tints {
            XCTAssertNotNil(AppearanceOverlay.RGB(hex), hex)
        }
        XCTAssertEqual(AppearanceOverlay.RGB("#ffffff")?.luminance, 1)
        XCTAssertEqual(AppearanceOverlay.RGB("#000")?.hex, "#000000")
    }
}
