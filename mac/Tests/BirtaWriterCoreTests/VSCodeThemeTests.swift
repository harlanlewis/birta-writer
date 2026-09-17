import XCTest
@testable import BirtaWriterCore

/// A VS Code colour theme as the page wears it: what a theme file becomes,
/// and what the stylesheet handed to the page says.
final class VSCodeThemeTests: XCTestCase {
    private func theme(_ json: String, label: String? = nil, uiTheme: String? = nil) throws -> VSCodeTheme {
        try VSCodeTheme.parse(try JSONC.object(from: Data(json.utf8)), label: label, uiTheme: uiTheme)
    }

    // MARK: reading

    func testColorsShouldBeKeptByIdWithEveryHexFormAndTheRestRefused() throws {
        let t = try theme("""
        { "name": "T", "type": "dark", "colors": {
            "editor.background": "#1E2529", "focusBorder": "#a78bfa80", "widget.border": "#abc",
            "editor.foreground": "#ABCD",
            "bad.words": "red", "bad.length": "#12345", "bad id!": "#000000", "nothing": null
        } }
        """)
        XCTAssertEqual(t.colors, ["editor.background": "#1e2529", "focusBorder": "#a78bfa80",
                                  "widget.border": "#abc", "editor.foreground": "#abcd"])
        XCTAssertEqual(t.kind, .dark)
        XCTAssertEqual(t.name, "T")
    }

    func testTheKindShouldComeFromTypeThenTheManifestThenThePaper() throws {
        XCTAssertEqual(try theme(##"{"type": "hcLight", "colors": {"a.b": "#000"}}"##).kind, .light)
        XCTAssertEqual(try theme(##"{"type": "hc", "colors": {"a.b": "#000"}}"##).kind, .dark)
        XCTAssertEqual(try theme(##"{"colors": {"a.b": "#000"}}"##, uiTheme: "vs-dark").kind, .dark)
        XCTAssertEqual(try theme(##"{"colors": {"a.b": "#000"}}"##, uiTheme: "hc-light").kind, .light)
        XCTAssertEqual(try theme(##"{"colors": {"editor.background": "#101010"}}"##).kind, .dark)
        XCTAssertEqual(try theme(##"{"colors": {"editor.background": "#fdfdfd"}}"##).kind, .light)
        XCTAssertEqual(try theme(##"{"colors": {"a.b": "#000"}}"##).kind, .light, "nothing to go on is light")
    }

    func testTheManifestLabelShouldWinOverTheFilesOwnName() throws {
        XCTAssertEqual(try theme(##"{"name": "file", "colors": {"a.b": "#000"}}"##, label: "Label").name, "Label")
        XCTAssertEqual(try theme(##"{"name": "file", "colors": {"a.b": "#000"}}"##).name, "file")
        XCTAssertEqual(try theme(##"{"colors": {"a.b": "#000"}}"##).name, "Theme")
    }

    func testAFileWithNoColorsShouldBeRefusedAsAThemeAndSoShouldANonObject() {
        XCTAssertThrowsError(try theme(##"{"name": "x", "tokenColors": []}"##)) {
            XCTAssertEqual($0 as? VSCodeTheme.ParseError, .noColors)
        }
        XCTAssertThrowsError(try theme(##"[1, 2]"##)) {
            XCTAssertEqual($0 as? VSCodeTheme.ParseError, .notAnObject)
        }
    }

    func testTokenRulesShouldTakeAStringOrAListOfScopesAndDropTheScopeless() throws {
        let t = try theme("""
        { "colors": {"a.b": "#000"}, "tokenColors": [
            { "settings": { "foreground": "#111111" } },
            { "scope": "comment, punctuation.definition.comment", "settings": { "foreground": "#222222", "fontStyle": "italic" } },
            { "scope": ["keyword", "storage"], "settings": { "fontStyle": "" } },
            { "scope": "string", "settings": { "foreground": "not a colour" } }
        ] }
        """)
        XCTAssertEqual(t.tokenColors, [
            .init(scopes: ["comment", "punctuation.definition.comment"], foreground: "#222222", fontStyle: "italic"),
            .init(scopes: ["keyword", "storage"], foreground: nil, fontStyle: ""),
        ])
    }

    func testAnIncludeShouldBeReadUnderTheThemeAndTheThemesOwnColorsWin() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("vscodetheme-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try """
        { "type": "dark", "colors": { "editor.background": "#000000", "foreground": "#aaaaaa" },
          "tokenColors": [ { "scope": "comment", "settings": { "foreground": "#333333" } } ] }
        """.write(to: dir.appendingPathComponent("base.json"), atomically: true, encoding: .utf8)
        try """
        // the derived theme
        { "name": "Derived", "include": "./base.json",
          "colors": { "editor.background": "#111111", },
          "tokenColors": [ { "scope": "string", "settings": { "foreground": "#444444" } } ] }
        """.write(to: dir.appendingPathComponent("derived-color-theme.json"), atomically: true, encoding: .utf8)
        let t = try VSCodeTheme.load(from: dir.appendingPathComponent("derived-color-theme.json"))
        XCTAssertEqual(t.name, "Derived")
        XCTAssertEqual(t.kind, .dark, "the base's type, which the derived file does not restate")
        XCTAssertEqual(t.colors, ["editor.background": "#111111", "foreground": "#aaaaaa"])
        XCTAssertEqual(t.tokenColors.map(\.scopes), [["comment"], ["string"]], "the base's rules first, so the theme's own win ties")

        try ##"{ "include": "./missing.json", "colors": {"a.b": "#000"} }"##
            .write(to: dir.appendingPathComponent("broken.json"), atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try VSCodeTheme.load(from: dir.appendingPathComponent("broken.json"))) {
            XCTAssertEqual($0 as? VSCodeTheme.ParseError, .includeMissing("./missing.json"))
        }

        try ##"{ "include": "./loop.json", "colors": {"a.b": "#000"} }"##
            .write(to: dir.appendingPathComponent("loop.json"), atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try VSCodeTheme.load(from: dir.appendingPathComponent("loop.json"))) {
            XCTAssertEqual($0 as? VSCodeTheme.ParseError, .includeTooDeep("loop.json"))
        }
    }

    func testAnIncludedBaseWithOnlyTokenColorsShouldStillContributeThem() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("vscodetheme-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try ##"{ "tokenColors": [ { "scope": "comment", "settings": { "fontStyle": "italic" } } ] }"##
            .write(to: dir.appendingPathComponent("tokens.json"), atomically: true, encoding: .utf8)
        try ##"{ "include": "./tokens.json", "colors": {"editor.background": "#fff"} }"##
            .write(to: dir.appendingPathComponent("t.json"), atomically: true, encoding: .utf8)
        let t = try VSCodeTheme.load(from: dir.appendingPathComponent("t.json"))
        XCTAssertEqual(t.tokenColors.count, 1)
        XCTAssertEqual(t.kind, .light)
    }

    // MARK: what the page is handed

    func testACustomPropertyShouldBeTheIdWithDotsAsDashesAndTheCaseKept() {
        XCTAssertEqual(VSCodeTheme.cssVariable(for: "editor.background"), "--vscode-editor-background")
        XCTAssertEqual(VSCodeTheme.cssVariable(for: "editorLineNumber.activeForeground"),
                       "--vscode-editorLineNumber-activeForeground")
        XCTAssertEqual(VSCodeTheme.cssVariable(for: "focusBorder"), "--vscode-focusBorder")
    }

    func testTheStylesheetShouldOverrideBothPalettesWithEveryColourSorted() throws {
        let t = try theme(##"{"type": "dark", "colors": {"focusBorder": "#a78bfa80", "editor.background": "#182529"}}"##)
        let css = t.stylesheet()
        XCTAssertTrue(css.hasPrefix(":root:has(body.vscode-light), :root:has(body.vscode-dark) {\n"),
                      "the palette's own dark selector, so order alone decides, and both so the override wins under either")
        XCTAssertEqual(css, """
        :root:has(body.vscode-light), :root:has(body.vscode-dark) {
          --vscode-editor-background: #182529;
          --vscode-focusBorder: #a78bfa80;
        }

        """)
        XCTAssertEqual(t.paper, "#182529")
    }

    func testTokenDeclarationsShouldFollowTheDeepestMatchingScopeAndTheLaterRuleOnATie() throws {
        let t = try theme("""
        { "colors": {"a.b": "#000"}, "tokenColors": [
            { "scope": "keyword", "settings": { "foreground": "#111111" } },
            { "scope": "keyword.control", "settings": { "foreground": "#222222", "fontStyle": "italic bold" } },
            { "scope": "keyword", "settings": { "foreground": "#333333" } },
            { "scope": "comment", "settings": { "fontStyle": "" } },
            { "scope": "meta.function entity.name.function", "settings": { "foreground": "#444444" } },
            { "scope": "constant.numeric", "settings": { "foreground": "#555555" } }
        ] }
        """)
        let decls = Dictionary(uniqueKeysWithValues: t.tokenDeclarations.map { ($0.name, $0.value) })
        // `keyword` (the class) asks for scope `keyword` first: two rules
        // name it exactly, the later wins; `keyword.control` covers `keyword`
        // no more than `keyword` does, since it is deeper than the scope
        // asked about rather than a prefix of it.
        XCTAssertEqual(decls["--host-token-keyword"], "#333333")
        // `atrule` asks for `keyword.control.at-rule` first, which
        // `keyword.control` is a prefix of and the deeper match.
        XCTAssertEqual(decls["--host-token-atrule"], "#222222")
        XCTAssertEqual(decls["--host-token-atrule-style"], "italic")
        XCTAssertEqual(decls["--host-token-atrule-weight"], "bold")
        // An empty fontStyle is a reset, written as normal in both.
        XCTAssertEqual(decls["--host-token-comment-style"], "normal")
        XCTAssertEqual(decls["--host-token-comment-weight"], "normal")
        XCTAssertNil(decls["--host-token-comment"], "no foreground was given, so none is declared")
        XCTAssertNil(decls["--host-token-function"], "a selector with an ancestor is not matched on its last word")
        XCTAssertEqual(decls["--host-token-number"], "#555555")
        XCTAssertNil(decls["--host-token-string"], "nothing said about strings, so the page's fallback stands")
    }

    /// The token table and the CSS that reads it are two files in two
    /// languages, so this is the only thing holding them together: every
    /// Prism class the CSS colours from a `--host-token-*` variable is one
    /// the table can emit, and every class the table emits is one the CSS
    /// reads.
    func testTheTokenTableShouldNameExactlyTheClassesTheCodeBlockCSSReads() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // BirtaWriterCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .deletingLastPathComponent()  // repo root
        let css = try String(contentsOf: root.appendingPathComponent("webview/components/codeBlock/codeBlock.css"),
                             encoding: .utf8)
        let pattern = try NSRegularExpression(pattern: ##"var\(--host-token-([a-z-]+?)(-style|-weight)?[,)]"##)
        var read = Set<String>()
        var reads = 0
        for m in pattern.matches(in: css, range: NSRange(css.startIndex..., in: css)) {
            read.insert(String(css[Range(m.range(at: 1), in: css)!]))
            reads += 1
        }
        XCTAssertGreaterThan(reads, 60, "the sweep reached the token rules")
        let table = Set(VSCodeTheme.Tokens.scopes.map(\.cls))
        XCTAssertEqual(read, table, "classes read by the CSS against classes the table emits")
        XCTAssertEqual(VSCodeTheme.Tokens.scopes.count, table.count, "no class is listed twice")
    }

    func testStoredShouldRoundTripThroughPlainJSON() throws {
        let t = try theme("""
        { "name": "RT", "type": "dark", "colors": {"editor.background": "#101010"},
          "tokenColors": [ { "scope": ["comment"], "settings": { "foreground": "#222222", "fontStyle": "italic" } } ] }
        """)
        let back = try VSCodeTheme.parse(try JSONSerialization.jsonObject(with: try t.stored()))
        XCTAssertEqual(back, t)
    }
}
