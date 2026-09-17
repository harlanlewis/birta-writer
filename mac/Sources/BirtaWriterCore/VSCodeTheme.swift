import Foundation

/// A VS Code colour theme, as the page can wear it.
///
/// The page is themed by `--vscode-*` custom properties, the same names the
/// VS Code workbench injects, and `webview/ui/hostPalette.css` gives every one
/// of them a light and a dark default. A VS Code theme is a map from the
/// workbench's colour ids to colours, and the workbench's own rule for naming
/// the variable after the id (`editor.background` becomes
/// `--vscode-editor-background`) is what makes a theme file applicable to the
/// page with no table of its own: every id becomes the variable the page
/// already reads, and an id the page never reads costs a declaration nothing
/// consults. What a theme leaves unsaid falls through to the palette's default
/// for the theme's kind, which is what VS Code does with the same gap.
///
/// The code blocks are the one place the page's colours do not come from the
/// workbench map. Prism marks a token with a class (`keyword`, `string`) and
/// `codeBlock.css` colours each from a terminal palette entry; a theme colours
/// tokens by TextMate scope in `tokenColors`. `tokenDeclarations` is that
/// translation, one `--host-token-<class>` per Prism class, and the stylesheet
/// carries them beside the workbench colours. `Tokens.scopes` is the table,
/// and `VSCodeThemeTests` holds it against the classes the CSS reads.
public struct VSCodeTheme: Equatable, Sendable {
    /// Which of the palette's two defaults the theme is an override of.
    ///
    /// Two rather than VS Code's four: the page has no high-contrast palette,
    /// so a high-contrast theme is an override of the dark or light default
    /// its base kind names, which is how it is drawn in VS Code too, over the
    /// matching base.
    public enum Kind: String, Sendable, Codable {
        case light, dark

        /// The class the page selects its palette by.
        public var bodyClass: String { "vscode-\(rawValue)" }

        /// From a theme file's `type`, which VS Code spells four ways.
        public init?(type: String?) {
            switch type?.lowercased() {
            case "light", "hclight", "hc-light": self = .light
            case "dark", "hc", "hcdark", "hc-black": self = .dark
            default: return nil
            }
        }

        /// From an extension manifest's `uiTheme`, the workbench base a
        /// contributed theme declares.
        public init?(uiTheme: String?) {
            switch uiTheme {
            case "vs", "hc-light": self = .light
            case "vs-dark", "hc-black": self = .dark
            default: return nil
            }
        }
    }

    /// One `tokenColors` entry, kept as VS Code keeps it: which scopes, and
    /// what the theme says about a token in them.
    public struct TokenRule: Equatable, Sendable, Codable {
        public let scopes: [String]
        public let foreground: String?
        /// VS Code's `fontStyle`: any of `italic`, `bold`, `underline` and
        /// `strikethrough` separated by spaces, or "" to reset every one.
        public let fontStyle: String?

        public init(scopes: [String], foreground: String?, fontStyle: String?) {
            self.scopes = scopes
            self.foreground = foreground
            self.fontStyle = fontStyle
        }
    }

    public let name: String
    public let kind: Kind
    /// Workbench colour by VS Code colour id, every value a `#` hex colour
    /// of three, four, six or eight digits, which is every form VS Code
    /// accepts and every one CSS draws.
    public let colors: [String: String]
    public let tokenColors: [TokenRule]

    public init(name: String, kind: Kind, colors: [String: String], tokenColors: [TokenRule] = []) {
        self.name = name
        self.kind = kind
        self.colors = colors
        self.tokenColors = tokenColors
    }

    // MARK: reading a theme file

    public enum ParseError: Error, LocalizedError, Equatable {
        case notAnObject
        case noColors
        case includeTooDeep(String)
        case includeMissing(String)

        public var errorDescription: String? {
            switch self {
            case .notAnObject: return "The file is not a VS Code colour theme."
            case .noColors: return "The theme has no colors."
            case let .includeTooDeep(path): return "The theme includes itself through \(path)."
            case let .includeMissing(path): return "The theme includes \(path), which is missing."
            }
        }
    }

    /// The theme in `object`, a decoded theme file, with `included` (the
    /// theme its `include` names, already read) underneath it.
    ///
    /// `label` is the name the extension manifest gives it, which VS Code
    /// shows in its picker and which wins over the file's own `name`; the
    /// file's name is the fallback, and the file's stem is the fallback's
    /// fallback. `uiTheme` is the manifest's base kind, consulted only when
    /// the file does not say.
    public static func parse(_ object: Any, label: String? = nil, uiTheme: String? = nil,
                             fallbackName: String = "Theme",
                             included: VSCodeTheme? = nil,
                             requiresColors: Bool = true) throws -> VSCodeTheme {
        guard let dict = object as? [String: Any] else { throw ParseError.notAnObject }
        var colors = included?.colors ?? [:]
        if let own = dict["colors"] as? [String: Any] {
            for (id, value) in own {
                guard Self.isColorId(id), let hex = value as? String, let color = Self.color(hex) else { continue }
                colors[id] = color
            }
        }
        guard !colors.isEmpty || !requiresColors else { throw ParseError.noColors }
        var rules = included?.tokenColors ?? []
        if let own = dict["tokenColors"] as? [[String: Any]] {
            rules += own.compactMap(Self.rule)
        }
        let name = label ?? (dict["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
        let kind = Kind(type: dict["type"] as? String)
            ?? included?.kind
            ?? Kind(uiTheme: uiTheme)
            ?? Self.inferKind(from: colors)
        return VSCodeTheme(name: name, kind: kind, colors: colors, tokenColors: rules)
    }

    /// The theme at `url`, with any `include` chain read and folded under
    /// it. `depth` bounds the chain, because a file that includes itself is
    /// the kind of mistake a theme author does not notice.
    public static func load(from url: URL, label: String? = nil, uiTheme: String? = nil,
                            depth: Int = 0, requiresColors: Bool = true) throws -> VSCodeTheme {
        guard depth < 8 else { throw ParseError.includeTooDeep(url.lastPathComponent) }
        let object = try JSONC.object(from: try Data(contentsOf: url))
        var included: VSCodeTheme?
        if let dict = object as? [String: Any], let path = dict["include"] as? String, !path.isEmpty {
            let target = URL(fileURLWithPath: path, relativeTo: url.deletingLastPathComponent()).standardizedFileURL
            guard FileManager.default.fileExists(atPath: target.path) else {
                throw ParseError.includeMissing(path)
            }
            // An included file may itself have no colors (a base carrying
            // only tokenColors), which is not the error it is at the top.
            included = try load(from: target, uiTheme: uiTheme, depth: depth + 1, requiresColors: false)
        }
        return try parse(object, label: label, uiTheme: uiTheme,
                         fallbackName: url.deletingPathExtension().lastPathComponent
                             .replacingOccurrences(of: "-color-theme", with: ""),
                         included: included, requiresColors: requiresColors)
    }

    private static func rule(_ entry: [String: Any]) -> TokenRule? {
        let scopes: [String]
        if let one = entry["scope"] as? String {
            scopes = one.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        } else if let many = entry["scope"] as? [String] {
            scopes = many
        } else {
            // A rule with no scope is the theme's default token style, and
            // the page's default is `editor.foreground` already.
            return nil
        }
        let settings = entry["settings"] as? [String: Any] ?? [:]
        let foreground = (settings["foreground"] as? String).flatMap(Self.color)
        let fontStyle = settings["fontStyle"] as? String
        guard foreground != nil || fontStyle != nil, !scopes.isEmpty else { return nil }
        return TokenRule(scopes: scopes, foreground: foreground, fontStyle: fontStyle)
    }

    /// A workbench colour id: dotted, camel-cased words. What is refused is
    /// anything that could not be spelled as a custom property, since the id
    /// is written into a stylesheet verbatim.
    static func isColorId(_ id: String) -> Bool {
        !id.isEmpty && id.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "_"
        }
    }

    /// `hex` as CSS draws it, or nil for anything that is not a `#` colour.
    /// Lower-cased so two spellings of one colour compare equal.
    static func color(_ hex: String) -> String? {
        let trimmed = hex.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("#") else { return nil }
        let digits = trimmed.dropFirst()
        guard [3, 4, 6, 8].contains(digits.count),
              digits.allSatisfy({ $0.isHexDigit }) else { return nil }
        return trimmed.lowercased()
    }

    /// Dark when the paper is dark, for a theme file that names no type and
    /// arrived with no manifest.
    static func inferKind(from colors: [String: String]) -> Kind {
        guard let paper = colors["editor.background"], let rgb = Self.rgb(paper) else { return .light }
        let luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b
        return luminance < 0.5 ? .dark : .light
    }

    /// The colour's channels in 0...1, with the alpha dropped.
    public static func rgb(_ hex: String) -> (r: Double, g: Double, b: Double)? {
        guard let color = color(hex) else { return nil }
        var digits = Array(color.dropFirst())
        if digits.count == 3 || digits.count == 4 {
            digits = digits.flatMap { [$0, $0] }
        }
        func channel(_ at: Int) -> Double? {
            guard let value = UInt8(String(digits[at..<at + 2]), radix: 16) else { return nil }
            return Double(value) / 255
        }
        guard let r = channel(0), let g = channel(2), let b = channel(4) else { return nil }
        return (r, g, b)
    }

    // MARK: what the page is handed

    /// The paper the theme paints the document on, for the chrome the app
    /// draws in that same colour around the page.
    public var paper: String? { colors["editor.background"] }

    /// The custom property a workbench colour id becomes, by the workbench's
    /// own rule: the dots become dashes and the case is kept.
    public static func cssVariable(for colorId: String) -> String {
        "--vscode-" + colorId.replacingOccurrences(of: ".", with: "-")
    }

    /// Every colour as a declaration, sorted by name so the stylesheet is the
    /// same text for the same theme.
    public var colorDeclarations: [(name: String, value: String)] {
        colors.map { (Self.cssVariable(for: $0.key), $0.value) }.sorted { $0.name < $1.name }
    }

    /// The Prism classes, as `--host-token-<class>` declarations, that the
    /// theme's `tokenColors` say something about.
    public var tokenDeclarations: [(name: String, value: String)] {
        var out: [(String, String)] = []
        for (cls, scopes) in Tokens.scopes {
            guard let style = Tokens.resolve(scopes, in: tokenColors) else { continue }
            if let foreground = style.foreground { out.append(("--host-token-\(cls)", foreground)) }
            if let fontStyle = style.fontStyle {
                let words = Set(fontStyle.split(separator: " ").map(String.init))
                out.append(("--host-token-\(cls)-style", words.contains("italic") ? "italic" : "normal"))
                out.append(("--host-token-\(cls)-weight", words.contains("bold") ? "bold" : "normal"))
            }
        }
        return out.sorted { $0.0 < $1.0 }
    }

    /// The stylesheet the page is served with the theme in force.
    ///
    /// The selectors are the palette's own for its dark block, so a
    /// declaration here outranks the palette's on order alone: this text is
    /// placed after the palette's link. Both classes are named because the
    /// override has to win whichever palette is under it, and the body
    /// carries exactly one of the two.
    public func stylesheet() -> String {
        let declarations = (colorDeclarations + tokenDeclarations)
            .map { "  \($0.name): \($0.value);" }
        return ":root:has(body.vscode-light), :root:has(body.vscode-dark) {\n"
            + declarations.joined(separator: "\n") + "\n}\n"
    }

    // MARK: the token table

    public enum Tokens {
        /// The TextMate scopes each Prism class stands for, most specific
        /// first: the first scope a theme has a rule for wins.
        ///
        /// Prism's classes are the vocabulary `codeBlock.css` colours, and
        /// each is roughly one TextMate scope family. Where Prism is coarser
        /// than TextMate (`keyword` covers `storage` too), the list names the
        /// families in the order a theme most often distinguishes them.
        public static let scopes: [(cls: String, scopes: [String])] = [
            ("comment", ["comment", "punctuation.definition.comment"]),
            ("prolog", ["comment"]),
            ("doctype", ["meta.tag.sgml.doctype", "entity.name.tag.doctype", "comment"]),
            ("cdata", ["string.unquoted.cdata", "comment"]),
            ("punctuation", ["punctuation"]),
            ("property", ["support.type.property-name", "variable.other.property", "meta.object-literal.key"]),
            ("tag", ["entity.name.tag"]),
            ("constant", ["constant.language", "constant.other", "constant"]),
            ("symbol", ["constant.other.symbol", "constant"]),
            ("deleted", ["markup.deleted"]),
            ("boolean", ["constant.language.boolean", "constant.language"]),
            ("number", ["constant.numeric"]),
            ("selector", ["entity.name.tag.css", "entity.name.tag"]),
            ("attr-name", ["entity.other.attribute-name"]),
            ("string", ["string"]),
            ("char", ["string.quoted.single", "string"]),
            ("builtin", ["support.type", "support.class", "support.function", "support"]),
            ("inserted", ["markup.inserted"]),
            ("operator", ["keyword.operator"]),
            ("entity", ["constant.character.entity", "entity"]),
            ("url", ["markup.underline.link", "string.other.link"]),
            ("atrule", ["keyword.control.at-rule", "keyword.control", "keyword"]),
            ("attr-value", ["string.quoted", "string"]),
            ("keyword", ["keyword", "storage.type", "storage"]),
            ("function", ["entity.name.function", "support.function"]),
            ("class-name", ["entity.name.type.class", "entity.name.type", "entity.name.class", "support.class"]),
            ("regex", ["string.regexp"]),
            ("important", ["keyword.other.important", "keyword"]),
            ("variable", ["variable", "variable.other"]),
        ]

        public struct Style: Equatable {
            public var foreground: String?
            public var fontStyle: String?
        }

        /// What the rules say about the first of `candidates` any of them
        /// covers, or nil when none does.
        ///
        /// A rule covers a scope when its selector names the scope or a
        /// dotted prefix of it, which is TextMate's own rule; among covering
        /// rules the deepest selector wins and, at equal depth, the later
        /// rule, which is VS Code's. Selectors with a space in them ask about
        /// the token's ancestors, which Prism does not report, so they are
        /// left out rather than matched on their last word.
        public static func resolve(_ candidates: [String], in rules: [TokenRule]) -> Style? {
            for scope in candidates {
                var covered = false
                var foreground: (depth: Int, index: Int, value: String)?
                var fontStyle: (depth: Int, index: Int, value: String)?
                for (index, rule) in rules.enumerated() {
                    for selector in rule.scopes {
                        guard !selector.contains(" "),
                              selector == scope || scope.hasPrefix(selector + ".") else { continue }
                        let depth = selector.split(separator: ".").count
                        if let fg = rule.foreground, foreground.map({ (depth, index) >= ($0.depth, $0.index) }) ?? true {
                            foreground = (depth, index, fg)
                        }
                        if let fs = rule.fontStyle, fontStyle.map({ (depth, index) >= ($0.depth, $0.index) }) ?? true {
                            fontStyle = (depth, index, fs)
                        }
                        covered = true
                    }
                }
                if covered {
                    return Style(foreground: foreground?.value, fontStyle: fontStyle?.value)
                }
            }
            return nil
        }
    }

    // MARK: the stored form

    /// The theme as the app keeps it: one plain JSON file, includes folded in
    /// and comments gone, so reading it back needs none of the tolerance
    /// reading a theme extension's file did.
    public func stored() throws -> Data {
        let object: [String: Any] = [
            "name": name,
            "type": kind.rawValue,
            "colors": colors,
            "tokenColors": tokenColors.map { rule -> [String: Any] in
                var settings: [String: Any] = [:]
                if let fg = rule.foreground { settings["foreground"] = fg }
                if let fs = rule.fontStyle { settings["fontStyle"] = fs }
                return ["scope": rule.scopes, "settings": settings]
            },
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    }
}
