import AppKit
import BirtaWriterCore

/// The Appearance pane's own controls: pictures and swatches where the
/// other panes have switches, because what they set is a colour or a look
/// and a word for it would be worse than the thing.
///
/// Every view here draws with `draw(_:)` and dynamic colours rather than a
/// layer, for the reason `BackgroundView` gives: a layer colour is resolved
/// once and goes stale across an appearance flip, and this pane is the one
/// that flips appearances on purpose.

// MARK: - A mini window

/// A window in miniature: a titlebar band, a sidebar strip, and three lines
/// of text on paper, in the colours it is given. What the mode picker and
/// the theme cards both draw, so a theme's card and the system's card are
/// the same picture in different ink.
struct MiniWindowPalette: Equatable {
    var paper: NSColor
    var ink: NSColor
    var accent: NSColor
    var sidebar: NSColor

    init(preview: ThemePreview) {
        paper = NSColor(themeHex: preview.paper) ?? .white
        ink = NSColor(themeHex: preview.ink) ?? .black
        accent = NSColor(themeHex: preview.accent) ?? .systemBlue
        sidebar = NSColor(themeHex: preview.sidebar) ?? paper
    }

    /// The system's palette for `kind`, with the mod applied to it the way
    /// the page applies it, so the card shows what picking it would show.
    static func system(_ kind: VSCodeTheme.Kind, settings: AppearanceSettings) -> MiniWindowPalette {
        var preview = ThemePreview.system(kind)
        let overlay = Dictionary(uniqueKeysWithValues: AppearanceOverlay.declarations(
            kind: kind, base: nil, accent: settings.accent, tint: settings.tint,
            transparentSidebar: settings.transparentSidebar
        ).map { ($0.name, $0.value) })
        let paper = overlay[VSCodeTheme.cssVariable(for: "editor.background")] ?? preview.paper
        let sidebar = settings.transparentSidebar ? paper
            : overlay[VSCodeTheme.cssVariable(for: "editorWidget.background")] ?? preview.sidebar
        preview = ThemePreview(paper: paper, ink: preview.ink,
                               accent: overlay[VSCodeTheme.cssVariable(for: "focusBorder")] ?? preview.accent,
                               sidebar: sidebar)
        return MiniWindowPalette(preview: preview)
    }

    /// A theme's card with the mod over it, the way the page draws the
    /// theme: the accent in place of the theme's, the tint into its paper
    /// and its sidebar, and the sidebar as the paper when transparent.
    static func themed(_ preview: ThemePreview, kind: VSCodeTheme.Kind, settings: AppearanceSettings) -> MiniWindowPalette {
        var paper = preview.paper
        var sidebar = preview.sidebar
        if let tint = settings.tint, let tintRGB = AppearanceOverlay.RGB(tint) {
            let amount = AppearanceOverlay.tintAmount(kind)
            paper = AppearanceOverlay.RGB(paper).map { $0.mixed(with: tintRGB, amount).hex } ?? paper
            sidebar = AppearanceOverlay.RGB(sidebar).map { $0.mixed(with: tintRGB, amount).hex } ?? sidebar
        }
        if settings.transparentSidebar { sidebar = paper }
        return MiniWindowPalette(preview: ThemePreview(paper: paper, ink: preview.ink,
                                                       accent: settings.accent ?? preview.accent, sidebar: sidebar))
    }

    static func draw(_ palette: MiniWindowPalette, in rect: NSRect, radius: CGFloat = 6) {
        let clip = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        clip.addClip()
        palette.paper.setFill()
        rect.fill()
        // The sidebar, a third of the width, off the paper by its own shade.
        let sidebar = NSRect(x: rect.minX, y: rect.minY, width: rect.width * 0.3, height: rect.height)
        palette.sidebar.setFill()
        sidebar.fill()
        // The titlebar's three lights, the ink at a quarter, so they read
        // as furniture rather than as a fourth colour.
        for (index, dot) in [palette.ink.withAlphaComponent(0.25), palette.ink.withAlphaComponent(0.25),
                             palette.ink.withAlphaComponent(0.25)].enumerated() {
            dot.setFill()
            NSBezierPath(ovalIn: NSRect(x: rect.minX + 5 + CGFloat(index) * 6, y: rect.maxY - 9, width: 3.5, height: 3.5)).fill()
        }
        // Three lines of text, the first a heading in the ink, the second the
        // accent (a link), the third ink again.
        let x = sidebar.maxX + 7
        let width = rect.maxX - x - 7
        let lines: [(NSColor, CGFloat, CGFloat)] = [
            (palette.ink, 0.62, 3), (palette.accent, 0.45, 2), (palette.ink.withAlphaComponent(0.55), 0.75, 2),
        ]
        var y = rect.maxY - 20
        for (color, fraction, height) in lines {
            color.setFill()
            NSBezierPath(roundedRect: NSRect(x: x, y: y, width: width * fraction, height: height),
                         xRadius: 1, yRadius: 1).fill()
            y -= height + 5
        }
    }
}

// MARK: - The mode picker

/// Auto, Light and Dark as three pictures, the way System Settings asks the
/// same question: a light window, a dark one, and one split down the middle.
@MainActor
final class AppearanceModePicker: NSView {
    var onChange: ((AppearanceMode) -> Void)?
    private(set) var selected: AppearanceMode = .auto
    private var settings = AppearanceSettings()
    private let cards: [ModeCard]

    init() {
        cards = AppearanceMode.allCases.map { ModeCard(mode: $0) }
        super.init(frame: .zero)
        let stack = NSStackView(views: cards)
        stack.orientation = .horizontal
        stack.spacing = 14
        stack.alignment = .top
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor),
        ])
        for card in cards {
            card.onPick = { [weak self] mode in
                self?.select(mode)
                self?.onChange?(mode)
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Show `settings`: which mode is picked, and the mod in the pictures.
    func show(_ settings: AppearanceSettings) {
        self.settings = settings
        select(settings.mode)
        for card in cards { card.show(settings) }
    }

    func select(_ mode: AppearanceMode) {
        selected = mode
        for card in cards { card.isSelected = card.mode == mode }
    }

    var titlesForTesting: [String] { cards.map(\.label.stringValue) }

    /// One picture and its label.
    final class ModeCard: NSControl {
        let mode: AppearanceMode
        let label: NSTextField
        var onPick: ((AppearanceMode) -> Void)?
        private var settings = AppearanceSettings()
        var isSelected = false {
            didSet {
                needsDisplay = true
                label.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: isSelected ? .semibold : .regular)
            }
        }

        static let pictureSize = NSSize(width: 66, height: 44)

        init(mode: AppearanceMode) {
            self.mode = mode
            label = NSTextField(labelWithString: mode.title)
            super.init(frame: .zero)
            label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            label.alignment = .center
            label.translatesAutoresizingMaskIntoConstraints = false
            addSubview(label)
            translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                widthAnchor.constraint(equalToConstant: Self.pictureSize.width + 6),
                heightAnchor.constraint(equalToConstant: Self.pictureSize.height + 6 + 18),
                label.centerXAnchor.constraint(equalTo: centerXAnchor),
                label.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
            setAccessibilityRole(.radioButton)
            setAccessibilityLabel(mode.title)
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        func show(_ settings: AppearanceSettings) {
            self.settings = settings
            needsDisplay = true
        }

        override func mouseDown(with event: NSEvent) { onPick?(mode) }

        override func draw(_ dirtyRect: NSRect) {
            let picture = NSRect(x: 3, y: bounds.height - Self.pictureSize.height - 3,
                                 width: Self.pictureSize.width, height: Self.pictureSize.height)
            NSGraphicsContext.saveGraphicsState()
            let light = MiniWindowPalette.system(.light, settings: settings)
            let dark = MiniWindowPalette.system(.dark, settings: settings)
            switch mode {
            case .light: MiniWindowPalette.draw(light, in: picture)
            case .dark: MiniWindowPalette.draw(dark, in: picture)
            case .auto:
                // Split down the middle, as the system's own picture is.
                MiniWindowPalette.draw(light, in: picture)
                NSGraphicsContext.saveGraphicsState()
                NSRect(x: picture.midX, y: picture.minY, width: picture.width / 2, height: picture.height).clip()
                MiniWindowPalette.draw(dark, in: picture)
                NSGraphicsContext.restoreGraphicsState()
            }
            NSGraphicsContext.restoreGraphicsState()
            let ring = NSBezierPath(roundedRect: picture.insetBy(dx: -2.5, dy: -2.5), xRadius: 8, yRadius: 8)
            ring.lineWidth = isSelected ? 2.5 : 1
            (isSelected ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
            ring.stroke()
        }
    }
}

// MARK: - The theme strip

/// One mode's slot as a row of cards: the system's palette first, then each
/// theme the store holds, the one in the slot ringed. A theme card's
/// context menu removes it from the store.
@MainActor
final class ThemeStrip: NSView {
    let kind: VSCodeTheme.Kind
    var onSelect: ((String?) -> Void)?
    var onRemove: ((String) -> Void)?
    private let scroll = NSScrollView()
    private let stack = NSStackView()
    private(set) var cards: [ThemeCard] = []
    private(set) var selectedId: String?
    private var settings = AppearanceSettings()

    static let height: CGFloat = 108

    init(kind: VSCodeTheme.Kind) {
        self.kind = kind
        super.init(frame: .zero)
        stack.orientation = .horizontal
        stack.spacing = 12
        stack.alignment = .top
        stack.edgeInsets = NSEdgeInsets(top: 3, left: 3, bottom: 3, right: 3)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let document = FlippedView()
        // Sized by its constraints: a document view left to its autoresizing
        // mask keeps the zero frame it was created with, and a stack pinned
        // inside it lays out into nothing.
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: document.topAnchor),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
        ])
        scroll.documentView = document
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.horizontalScrollElasticity = .allowed
        scroll.verticalScrollElasticity = .none
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            heightAnchor.constraint(equalToConstant: Self.height),
            document.heightAnchor.constraint(equalTo: scroll.heightAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Draw `themes` with `selected` ringed, the system card first.
    func show(themes: [ThemeSummary], selected: String?, settings: AppearanceSettings) {
        self.settings = settings
        selectedId = selected
        for card in cards { card.removeFromSuperview() }
        let system = ThemeCard(id: nil, title: ThemeCard.systemTitle,
                               palette: MiniWindowPalette.system(kind, settings: settings))
        let rest = themes.map { theme in
            ThemeCard(id: theme.id, title: theme.name,
                      palette: MiniWindowPalette.themed(theme.preview, kind: theme.kind, settings: settings))
        }
        cards = [system] + rest
        for card in cards {
            card.isSelected = card.id == selected
            card.onPick = { [weak self] id in
                self?.select(id)
                self?.onSelect?(id)
            }
            card.onRemove = { [weak self] id in self?.onRemove?(id) }
            stack.addArrangedSubview(card)
        }
    }

    func select(_ id: String?) {
        selectedId = id
        for card in cards { card.isSelected = card.id == id }
    }

    var titlesForTesting: [String] { cards.map(\.title) }

    /// Flipped so the strip's top is the scroll view's top.
    final class FlippedView: NSView {
        override var isFlipped: Bool { true }
    }

    /// One theme as a card: the picture and the name under it.
    final class ThemeCard: NSControl {
        static let systemTitle = "System"
        static let pictureSize = NSSize(width: 84, height: 54)
        let id: String?
        let title: String
        let palette: MiniWindowPalette
        var onPick: ((String?) -> Void)?
        var onRemove: ((String) -> Void)?
        private let label: NSTextField
        var isSelected = false {
            didSet {
                needsDisplay = true
                label.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: isSelected ? .semibold : .regular)
            }
        }

        init(id: String?, title: String, palette: MiniWindowPalette) {
            self.id = id
            self.title = title
            self.palette = palette
            label = NSTextField(labelWithString: title)
            super.init(frame: .zero)
            label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            label.alignment = .center
            label.lineBreakMode = .byWordWrapping
            label.maximumNumberOfLines = 2
            label.preferredMaxLayoutWidth = Self.pictureSize.width + 6
            label.translatesAutoresizingMaskIntoConstraints = false
            addSubview(label)
            translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                widthAnchor.constraint(equalToConstant: Self.pictureSize.width + 6),
                heightAnchor.constraint(equalToConstant: Self.pictureSize.height + 6 + 32),
                label.topAnchor.constraint(equalTo: topAnchor, constant: Self.pictureSize.height + 8),
                label.leadingAnchor.constraint(equalTo: leadingAnchor),
                label.trailingAnchor.constraint(equalTo: trailingAnchor),
            ])
            toolTip = title
            setAccessibilityRole(.radioButton)
            setAccessibilityLabel(title)
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        override func mouseDown(with event: NSEvent) { onPick?(id) }

        override func menu(for event: NSEvent) -> NSMenu? {
            guard let id else { return nil }
            let menu = NSMenu()
            let remove = NSMenuItem(title: "Remove", action: #selector(removeTheme), keyEquivalent: "")
            remove.target = self
            remove.representedObject = id
            menu.addItem(remove)
            return menu
        }

        @objc private func removeTheme() {
            if let id { onRemove?(id) }
        }

        override func draw(_ dirtyRect: NSRect) {
            let picture = NSRect(x: 3, y: bounds.height - Self.pictureSize.height - 3,
                                 width: Self.pictureSize.width, height: Self.pictureSize.height)
            NSGraphicsContext.saveGraphicsState()
            MiniWindowPalette.draw(palette, in: picture)
            NSGraphicsContext.restoreGraphicsState()
            let ring = NSBezierPath(roundedRect: picture.insetBy(dx: -2.5, dy: -2.5), xRadius: 8, yRadius: 8)
            ring.lineWidth = isSelected ? 2.5 : 1
            (isSelected ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
            ring.stroke()
        }
    }
}

// MARK: - Swatches

/// A row of colour dots with one ringed, and a first dot that means none:
/// the accent row and the tint row are both this.
@MainActor
final class SwatchRow: NSView {
    var onSelect: ((String?) -> Void)?
    private(set) var selected: String?
    private let swatches: [Swatch]

    /// `noneTitle` names the first dot, which stands for the palette's own
    /// colour (an accent) or no tint at all.
    init(colors: [(name: String, hex: String)], noneTitle: String) {
        swatches = [Swatch(hex: nil, title: noneTitle)] + colors.map { Swatch(hex: $0.hex, title: $0.name) }
        super.init(frame: .zero)
        let stack = NSStackView(views: swatches)
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
        ])
        for swatch in swatches {
            swatch.onPick = { [weak self] hex in
                self?.select(hex)
                self?.onSelect?(hex)
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func select(_ hex: String?) {
        selected = hex
        for swatch in swatches { swatch.isSelected = swatch.hex == hex }
    }

    var titlesForTesting: [String] { swatches.map(\.title) }

    final class Swatch: NSControl {
        let hex: String?
        let title: String
        var onPick: ((String?) -> Void)?
        var isSelected = false { didSet { needsDisplay = true } }
        static let size: CGFloat = 22

        init(hex: String?, title: String) {
            self.hex = hex
            self.title = title
            super.init(frame: .zero)
            translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                widthAnchor.constraint(equalToConstant: Self.size),
                heightAnchor.constraint(equalToConstant: Self.size),
            ])
            toolTip = title
            setAccessibilityRole(.radioButton)
            setAccessibilityLabel(title)
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        override func mouseDown(with event: NSEvent) { onPick?(hex) }

        override func draw(_ dirtyRect: NSRect) {
            let dot = bounds.insetBy(dx: 3, dy: 3)
            if let hex, let color = NSColor(themeHex: hex) {
                color.setFill()
                NSBezierPath(ovalIn: dot).fill()
            } else {
                // None: an empty ring with a diagonal, the sign every colour
                // picker uses for "no colour".
                NSColor.tertiaryLabelColor.setStroke()
                let ring = NSBezierPath(ovalIn: dot.insetBy(dx: 0.5, dy: 0.5))
                ring.lineWidth = 1
                ring.stroke()
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: dot.minX + 3, y: dot.minY + 3))
                slash.line(to: NSPoint(x: dot.maxX - 3, y: dot.maxY - 3))
                slash.lineWidth = 1
                slash.stroke()
            }
            if isSelected {
                let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1))
                ring.lineWidth = 2
                NSColor.controlAccentColor.setStroke()
                ring.stroke()
            }
        }
    }
}

// MARK: - The font size stepper

/// Smaller, the size, larger: the toolbar's own stepper, as a control.
@MainActor
final class FontSizeStepper: NSView {
    var onStep: ((Int) -> Void)?
    var onReset: (() -> Void)?
    private let smaller = NSButton(title: "A", target: nil, action: nil)
    private let larger = NSButton(title: "A", target: nil, action: nil)
    private let value = NSButton(title: "100%", target: nil, action: nil)

    init() {
        super.init(frame: .zero)
        smaller.font = .systemFont(ofSize: 10)
        larger.font = .systemFont(ofSize: 15)
        for button in [smaller, larger, value] {
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.target = self
        }
        value.font = .monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        value.toolTip = "Reset font size"
        smaller.toolTip = "Decrease font size"
        larger.toolTip = "Increase font size"
        smaller.action = #selector(stepDown)
        larger.action = #selector(stepUp)
        value.action = #selector(reset)
        let stack = NSStackView(views: [smaller, value, larger])
        stack.orientation = .horizontal
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(percent: Int) {
        value.title = "\(percent)%"
        smaller.isEnabled = percent > FontSizeStepper.minimum
        larger.isEnabled = percent < FontSizeStepper.maximum
    }

    var percentForTesting: String { value.title }

    /// The page's own bounds (`shared/fontPresets.ts`), restated: a stepper
    /// that let the setting past them would write a size the page clamps
    /// back, and the two would disagree.
    static let minimum = 50
    static let maximum = 200
    static let step = 10

    @objc private func stepDown() { onStep?(-Self.step) }
    @objc private func stepUp() { onStep?(Self.step) }
    @objc private func reset() { onReset?() }
}
