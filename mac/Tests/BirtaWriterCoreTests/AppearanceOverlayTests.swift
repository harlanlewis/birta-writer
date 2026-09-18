import XCTest
@testable import BirtaWriterCore

/// The colour mod as declarations, and the palette seeds it restates.
final class AppearanceOverlayTests: XCTestCase {
    private func decls(kind: VSCodeTheme.Kind = .light, base: VSCodeTheme? = nil, accent: String? = nil,
                       tint: String? = nil, sidebar: Bool = false, toc: Bool = true) -> [String: String] {
        Dictionary(uniqueKeysWithValues: AppearanceOverlay.declarations(
            kind: kind, base: base, accent: accent, tint: tint, transparentSidebar: sidebar, transparentToc: toc
        ).map { ($0.name, $0.value) })
    }

    func testNothingSetShouldDeclareNothing() {
        XCTAssertTrue(AppearanceOverlay.declarations(kind: .light, base: nil, accent: nil, tint: nil,
                                                     transparentSidebar: false, transparentToc: true).isEmpty)
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

    /// By reference rather than by colour, so each ground follows whatever is
    /// under it: a theme's paper, a tinted paper, the palette's own.
    func testEachDrawersGroundShouldBeNamedByReferenceSoItFollowsAnyTheme() {
        XCTAssertEqual(decls(sidebar: true)[AppearanceOverlay.filesGround], "var(--vscode-editor-background)")
        XCTAssertEqual(decls(toc: false)[AppearanceOverlay.tocGround], "var(--vscode-sideBar-background)")
    }

    /// The two switches ask about two surfaces, so one must not answer for
    /// the other. A shared palette variable cannot hold both answers: with
    /// the file list's transparency written as `sideBar.background`, an
    /// outline asking for that shade would be handed the paper instead.
    func testTheTwoDrawerGroundsShouldBeIndependentOfEachOther() {
        let both = decls(sidebar: true, toc: false)
        XCTAssertEqual(both[AppearanceOverlay.filesGround], "var(--vscode-editor-background)",
                       "the file list reads as page")
        XCTAssertEqual(both[AppearanceOverlay.tocGround], "var(--vscode-sideBar-background)",
                       "and the outline still gets the shade")
        XCTAssertNil(both["--vscode-sideBar-background"],
                     "neither switch redefines the palette's own shade, which other chrome draws on")
        XCTAssertNotEqual(AppearanceOverlay.filesGround, AppearanceOverlay.tocGround)
        // And the defaults: the file list shaded, the outline as page, each
        // by declaring nothing at all.
        XCTAssertNil(decls()[AppearanceOverlay.filesGround])
        XCTAssertNil(decls()[AppearanceOverlay.tocGround])
    }

    func testAnUnreadableColourShouldBeIgnoredRatherThanWrittenIntoAStylesheet() {
        XCTAssertTrue(AppearanceOverlay.declarations(kind: .light, base: nil, accent: "red", tint: "#12",
                                                     transparentSidebar: false, transparentToc: true).isEmpty)
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

    /// Each ground property is declared here and READ in the page, so the two
    /// spellings have to match and nothing else would say if they stopped:
    /// a property nobody reads is a switch that moves nothing, silently, and
    /// the switch itself goes on working.
    ///
    /// The default is checked with the name, because the default is half of
    /// what makes a host that declares nothing the page as written, and the
    /// two defaults are deliberately opposite.
    ///
    /// The PAINT is checked too, and separately, because naming a property
    /// is not spending it: the outline's ground reaches its panel through an
    /// alias, so a file that declares the alias and then paints nothing with
    /// it would satisfy a check that only looked for the name. What neither
    /// arm can see is whether the cascade honours any of it; `e2e/toc` and
    /// `e2e/fileExplorer` read that off a real browser.
    func testEachGroundPropertyShouldBeReadByThePageWithItsOwnDefault() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        // The property, the file that reads it, its default, and the text
        // that spends it on a surface. The explorer spends the property
        // itself, so its two strings are one; the outline spends an alias,
        // and what this asks of that line is that the alias reaches a
        // `background` at all, not the shape of the rest of the line.
        let readers = [
            (AppearanceOverlay.filesGround, "webview/components/fileExplorer/styles.ts",
             "--vscode-sideBar-background", "background: var(--files-panel-ground, var(--vscode-sideBar-background))"),
            (AppearanceOverlay.tocGround, "webview/components/toc/toc.css",
             "--vscode-editor-background", "background: var(--toc-surface"),
        ]
        for (property, file, fallback, paints) in readers {
            let text = try String(contentsOf: root.appendingPathComponent(file), encoding: .utf8)
            XCTAssertTrue(text.contains("var(\(property), var(\(fallback)))"),
                          "\(file) must read \(property) and fall back to \(fallback); the Mac app declares "
                            + "that property and nothing else reads it")
            XCTAssertTrue(text.contains(paints),
                          "\(file) names the property but paints nothing with it: expected \(paints)")
        }
    }

    func testTheSwatchesShouldBeReadableColours() {
        for (_, hex) in AppearanceOverlay.accents + AppearanceOverlay.tints {
            XCTAssertNotNil(AppearanceOverlay.RGB(hex), hex)
        }
        XCTAssertEqual(AppearanceOverlay.RGB("#ffffff")?.luminance, 1)
        XCTAssertEqual(AppearanceOverlay.RGB("#000")?.hex, "#000000")
    }
}
