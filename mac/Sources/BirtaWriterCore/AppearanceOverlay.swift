import Foundation

/// The colour mod, written as the same kind of override a theme is.
///
/// An accent, a paper tint and a transparent sidebar are each a handful of
/// `--vscode-*` declarations placed after whatever is under them (the
/// palette, or a theme), which is exactly what a VS Code theme is to the
/// page. So the mod is a theme in everything but name, generated here from
/// a colour or two, and never shown to anybody as one: the pane shows
/// swatches, and the page sees declarations.
///
/// ## What the accent reaches
///
/// The palette seeds four roles from `focusBorder` with `var()` (buttons,
/// links, the selected list row, the sash), so under the palette setting
/// the seed would move them; they are restated all the same, because a
/// theme names each of them as a literal of its own and the accent has to
/// win over a theme too. Everything else accent-coloured in the palette is
/// a literal restated from the accent: the info ink, the link's active ink
/// and the button's hover (the accent, darker), the washes (the accent at
/// the palette's own alphas), and the text selection (the accent mixed
/// into the paper, the way the palette's own blue is).
///
/// ## What the tint reaches
///
/// The two surfaces the palette paints as literals, the paper and the
/// widget ground (which the sidebar, the hover widget and the dropdown
/// take by `var()`), plus the two the dark block paints on its own (input
/// and checkbox). Each is the tint mixed into the surface a small amount,
/// stronger on dark paper because a dark surface swallows more of it. Under
/// a theme the theme's own surfaces are what gets tinted.
///
/// ## The palette's seeds, restated
///
/// A tint needs the colour it is mixing INTO, and under the system
/// appearance that is a literal in `hostPalette.css`, which this target
/// cannot read at run time. `systemPalette` restates the three it needs
/// and `AppearanceOverlayTests` holds them to the file, the way
/// `StatusOverlayInkTests` holds the paper: a second declarer, held to the
/// first.
public enum AppearanceOverlay {
    /// The palette's light and dark seeds this overlay mixes into.
    public static func systemPalette(_ kind: VSCodeTheme.Kind) -> [String: String] {
        switch kind {
        case .light:
            return ["editor.background": "#ffffff", "editor.foreground": "#1d1d1f",
                    "editorWidget.background": "#f6f6f7", "focusBorder": "#007aff"]
        case .dark:
            return ["editor.background": "#1e1e1e", "editor.foreground": "#e6e6e6",
                    "editorWidget.background": "#2a2a2c", "focusBorder": "#0a84ff"]
        }
    }

    /// How much of the tint goes into a surface, per kind.
    public static func tintAmount(_ kind: VSCodeTheme.Kind) -> Double { kind == .dark ? 0.16 : 0.09 }

    /// The declarations for `accent`, `tint` and `transparentSidebar` over
    /// `base` (a theme, or nil for the palette) of `kind`, in a fixed
    /// order. Empty when nothing is set.
    public static func declarations(kind: VSCodeTheme.Kind, base: VSCodeTheme?,
                                    accent: String?, tint: String?,
                                    transparentSidebar: Bool) -> [(name: String, value: String)] {
        var out: [(String, String)] = []
        func put(_ id: String, _ value: String) { out.append((VSCodeTheme.cssVariable(for: id), value)) }
        let palette = systemPalette(kind)
        func surface(_ id: String) -> String { base?.colors[id] ?? palette[id] ?? palette["editor.background"]! }

        var paper = surface("editor.background")
        if let tint, let tintRGB = RGB(tint) {
            let amount = tintAmount(kind)
            func tinted(_ id: String) -> String {
                RGB(surface(id)).map { $0.mixed(with: tintRGB, amount).hex } ?? surface(id)
            }
            paper = tinted("editor.background")
            put("editor.background", paper)
            put("editorWidget.background", tinted("editorWidget.background"))
            put("input.background", paper)
            put("checkbox.background", paper)
        }

        if let accent, let accentRGB = RGB(accent) {
            let paperRGB = RGB(paper) ?? RGB(palette["editor.background"]!)!
            let pressed = accentRGB.mixed(with: kind == .dark ? RGB.white : RGB.black, 0.15)
            put("focusBorder", accentRGB.hex)
            put("textLink.foreground", accentRGB.hex)
            put("button.background", accentRGB.hex)
            put("list.activeSelectionBackground", accentRGB.hex)
            put("sash.hoverBorder", accentRGB.hex)
            put("editorInfo.foreground", accentRGB.hex)
            put("charts.blue", accentRGB.hex)
            put("textLink.activeForeground", pressed.hex)
            put("button.hoverBackground", pressed.hex)
            put("editor.hoverHighlightBackground", accentRGB.css(alpha: kind == .dark ? 0.18 : 0.1))
            put("editor.foldBackground", accentRGB.css(alpha: kind == .dark ? 0.18 : 0.1))
            put("inputOption.activeBackground", accentRGB.css(alpha: kind == .dark ? 0.35 : 0.2))
            put("list.dropBackground", accentRGB.css(alpha: kind == .dark ? 0.25 : 0.15))
            put("editor.selectionBackground", paperRGB.mixed(with: accentRGB, kind == .dark ? 0.45 : 0.3).hex)
        }

        if transparentSidebar {
            out.append((VSCodeTheme.cssVariable(for: "sideBar.background"),
                        "var(\(VSCodeTheme.cssVariable(for: "editor.background")))"))
        }
        return out.map { (name: $0.0, value: $0.1) }
    }

    /// A colour as three channels in 0...1, for the mixing above.
    public struct RGB: Equatable {
        public var r: Double, g: Double, b: Double

        public static let white = RGB(r: 1, g: 1, b: 1)
        public static let black = RGB(r: 0, g: 0, b: 0)

        public init(r: Double, g: Double, b: Double) {
            self.r = r; self.g = g; self.b = b
        }

        public init?(_ hex: String) {
            guard let rgb = VSCodeTheme.rgb(hex) else { return nil }
            self.init(r: rgb.r, g: rgb.g, b: rgb.b)
        }

        public func mixed(with other: RGB, _ amount: Double) -> RGB {
            RGB(r: r + (other.r - r) * amount, g: g + (other.g - g) * amount, b: b + (other.b - b) * amount)
        }

        public var hex: String {
            String(format: "#%02x%02x%02x", Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
        }

        public func css(alpha: Double) -> String {
            "rgba(\(Int((r * 255).rounded())), \(Int((g * 255).rounded())), \(Int((b * 255).rounded())), \(alpha))"
        }

        /// Relative luminance, for the ink over a swatch.
        public var luminance: Double { 0.2126 * r + 0.7152 * g + 0.0722 * b }
    }

    /// The accents the pane offers, macOS's own set, so the swatch row
    /// reads as the one in System Settings.
    public static let accents: [(name: String, hex: String)] = [
        ("Blue", "#007aff"), ("Purple", "#953d96"), ("Pink", "#f74f9e"), ("Red", "#ff5257"),
        ("Orange", "#f7821b"), ("Yellow", "#ffc600"), ("Green", "#62ba46"), ("Graphite", "#8c8c8c"),
    ]

    /// The tints the pane offers: full hues, mixed in lightly by
    /// `tintAmount`, so a swatch reads as the colour and the paper takes a
    /// breath of it.
    public static let tints: [(name: String, hex: String)] = [
        ("Lavender", "#8b5cf6"), ("Rose", "#f43f5e"), ("Peach", "#fb923c"), ("Sand", "#eab308"),
        ("Sage", "#22c55e"), ("Mint", "#14b8a6"), ("Sky", "#38bdf8"), ("Slate", "#64748b"),
    ]
}
