import Foundation

/// How the app decides what the page looks like, with no window.
///
/// Three answers stack. The MODE says which of light and dark is in force:
/// the system's choice (`auto`, the default, following macOS as it flips
/// through the day) or one held regardless. Each of light and dark has a
/// SLOT holding what to draw in that mode: the page's own palette for that
/// mode (nil, the default, which is the macOS appearance) or a VS Code
/// theme by id, of either kind, so daytime can be a theme and night the
/// system's dark, or two themes can trade places with the sun. And a
/// COLOUR MOD sits over whichever of those is drawn: an accent, a paper
/// tint and a transparent sidebar, which are written as the same kind of
/// override a theme is (`AppearanceOverlay`) and never shown as one.
///
/// `resolve` is the one place the three are combined, so the menu, the
/// palette, the Settings pane and every window ask it rather than each
/// reading the parts.
public enum AppearanceMode: String, CaseIterable, Sendable {
    case auto, light, dark

    public var title: String {
        switch self {
        case .auto: return "Auto"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }
}

public struct AppearanceSettings: Equatable, Sendable {
    public var mode: AppearanceMode
    /// The theme drawn in light mode, by id, or nil for the system's light.
    public var lightTheme: String?
    /// The theme drawn in dark mode, by id, or nil for the system's dark.
    public var darkTheme: String?
    /// The accent, as a hex colour, or nil for the palette's own.
    public var accent: String?
    /// The paper tint, as a hex colour mixed into every surface, or nil.
    public var tint: String?
    public var transparentSidebar: Bool

    public init(mode: AppearanceMode = .auto, lightTheme: String? = nil, darkTheme: String? = nil,
                accent: String? = nil, tint: String? = nil, transparentSidebar: Bool = false) {
        self.mode = mode
        self.lightTheme = lightTheme
        self.darkTheme = darkTheme
        self.accent = accent
        self.tint = tint
        self.transparentSidebar = transparentSidebar
    }

    /// Which mode is in force, given what the system says.
    public func effectiveKind(systemIsDark: Bool) -> VSCodeTheme.Kind {
        switch mode {
        case .auto: return systemIsDark ? .dark : .light
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// The slot for a mode.
    public func themeId(for kind: VSCodeTheme.Kind) -> String? {
        kind == .dark ? darkTheme : lightTheme
    }

    /// The same settings with `id` in the slot for `kind`.
    public func setting(_ id: String?, for kind: VSCodeTheme.Kind) -> AppearanceSettings {
        var next = self
        if kind == .dark { next.darkTheme = id } else { next.lightTheme = id }
        return next
    }

    /// Whether anything is customized past the system appearance.
    public var isSystemDefault: Bool {
        mode == .auto && lightTheme == nil && darkTheme == nil && accent == nil && tint == nil && !transparentSidebar
    }
}

/// What a window draws, resolved from the settings, the system and the
/// store.
public struct ResolvedAppearance: Equatable, Sendable {
    /// The mode in force.
    public let kind: VSCodeTheme.Kind
    /// The theme in that mode's slot, if the slot names one the store holds.
    public let theme: VSCodeTheme?
    /// The id that theme was found under, so a menu can tick it.
    public let themeId: String?
    /// The colour mod over it.
    public let overlay: [(name: String, value: String)]

    public init(kind: VSCodeTheme.Kind, theme: VSCodeTheme?, themeId: String?, overlay: [(name: String, value: String)]) {
        self.kind = kind
        self.theme = theme
        self.themeId = themeId
        self.overlay = overlay
    }

    public static func == (a: ResolvedAppearance, b: ResolvedAppearance) -> Bool {
        a.kind == b.kind && a.theme == b.theme && a.themeId == b.themeId
            && a.overlay.map { "\($0.name)=\($0.value)" } == b.overlay.map { "\($0.name)=\($0.value)" }
    }

    /// The class the page's body wears: the theme's own kind, since a theme
    /// is drawn over the palette of its kind whichever slot it sits in.
    public var bodyClass: String { (theme?.kind ?? kind).bodyClass }

    /// Whether the window's own appearance has to be held to a kind rather
    /// than left to the system: a theme in force, or a mode that is not
    /// the system's.
    public func windowKind(mode: AppearanceMode) -> VSCodeTheme.Kind? {
        if let theme { return theme.kind }
        return mode == .auto ? nil : kind
    }

    /// The paper the chrome around the page paints in: the theme's, or
    /// the palette's for the kind, tinted the way the page's is.
    public var paper: String? {
        overlay.first { $0.name == VSCodeTheme.cssVariable(for: "editor.background") }?.value ?? theme?.paper
    }

    /// The stylesheet the page is served: the theme's colours, then the
    /// mod's, in one block, so the mod's declarations win on order.
    public func stylesheet() -> String {
        let declarations = ((theme?.colorDeclarations ?? []) + (theme?.tokenDeclarations ?? []) + overlay)
        guard !declarations.isEmpty else { return "" }
        return ":root:has(body.vscode-light), :root:has(body.vscode-dark) {\n"
            + declarations.map { "  \($0.name): \($0.value);" }.joined(separator: "\n") + "\n}\n"
    }
}

public enum Appearance {
    /// Resolve `settings` for a window, against the system's answer and
    /// the store's contents.
    public static func resolve(_ settings: AppearanceSettings, systemIsDark: Bool,
                               theme lookup: (String) -> VSCodeTheme?) -> ResolvedAppearance {
        let kind = settings.effectiveKind(systemIsDark: systemIsDark)
        let id = settings.themeId(for: kind)
        let theme = id.flatMap(lookup)
        let overlay = AppearanceOverlay.declarations(
            kind: theme?.kind ?? kind, base: theme,
            accent: settings.accent, tint: settings.tint, transparentSidebar: settings.transparentSidebar)
        return ResolvedAppearance(kind: kind, theme: theme, themeId: theme == nil ? nil : id, overlay: overlay)
    }
}
