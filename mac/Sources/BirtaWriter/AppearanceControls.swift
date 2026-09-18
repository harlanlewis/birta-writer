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
/// of text on paper, in the colours it is given. What every theme card
/// draws, so a theme's card and the system's card are the same picture in
/// different ink.
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

// MARK: - The theme strip

/// A row of theme cards with one ringed.
///
/// With a KIND, it is that mode's slot: the system's palette for the mode
/// first, then each theme the store holds. With none, it is the strip drawn
/// while a mode is held: both system cards first, then the themes, and a
/// pick says which kind it holds as well as which theme. A theme card's
/// hover button, and its context menu, remove it from the store.
@MainActor
final class ThemeStrip: NSView {
    let kind: VSCodeTheme.Kind?
    /// A pick: the theme's id (nil for a system card) and the kind the card
    /// is of.
    var onSelect: ((String?, VSCodeTheme.Kind) -> Void)?
    var onRemove: ((String) -> Void)?
    private let scroll = NSScrollView()
    private let stack = NSStackView()
    private(set) var cards: [ThemeCard] = []
    private(set) var selectedId: String?
    private var settings = AppearanceSettings()

    static let height: CGFloat = 108

    init(kind: VSCodeTheme.Kind?) {
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

    /// Draw `themes` with `selected` ringed, the mode's system card first.
    /// For a slot strip; the held strip is shown with a held kind.
    func show(themes: [ThemeSummary], selected: String?, settings: AppearanceSettings) {
        guard let kind else { return }
        show(themes: themes, selected: selected, systemKinds: [kind], selectedSystem: kind, settings: settings)
    }

    /// Draw `themes` after both system cards, ringing `selected`, or the
    /// system card for `heldKind` when the held kind's slot is empty.
    func show(themes: [ThemeSummary], selected: String?, heldKind: VSCodeTheme.Kind, settings: AppearanceSettings) {
        show(themes: themes, selected: selected, systemKinds: [.light, .dark], selectedSystem: heldKind, settings: settings)
    }

    private func show(themes: [ThemeSummary], selected: String?, systemKinds: [VSCodeTheme.Kind],
                      selectedSystem: VSCodeTheme.Kind, settings: AppearanceSettings) {
        self.settings = settings
        selectedId = selected
        for card in cards { card.removeFromSuperview() }
        let system = systemKinds.map { kind in
            ThemeCard(id: nil, kind: kind, title: ThemeCard.systemTitle(kind),
                      palette: MiniWindowPalette.system(kind, settings: settings))
        }
        let rest = themes.map { theme in
            ThemeCard(id: theme.id, kind: theme.kind, title: theme.name,
                      palette: MiniWindowPalette.themed(theme.preview, kind: theme.kind, settings: settings))
        }
        cards = system + rest
        for card in cards {
            card.isSelected = card.id == selected && (card.id != nil || card.kind == selectedSystem)
            card.onPick = { [weak self] id, kind in
                self?.select(id, systemKind: kind)
                self?.onSelect?(id, kind)
            }
            card.onRemove = { [weak self] id in self?.onRemove?(id) }
            stack.addArrangedSubview(card)
        }
    }

    func select(_ id: String?, systemKind: VSCodeTheme.Kind) {
        selectedId = id
        for card in cards { card.isSelected = card.id == id && (card.id != nil || card.kind == systemKind) }
    }

    var titlesForTesting: [String] { cards.map(\.title) }
    var selectedTitleForTesting: String? { cards.first { $0.isSelected }?.title }

    /// Flipped so the strip's top is the scroll view's top.
    final class FlippedView: NSView {
        override var isFlipped: Bool { true }
    }

    /// One theme as a card: the picture and the name under it, and, for a
    /// theme the store holds, a remove button in the picture's corner while
    /// the pointer is on the card.
    ///
    /// No confirmation on the remove: the file is one Add Theme… away, and
    /// a sheet to answer for a card that takes one click to put back would
    /// be a cost paid on every removal to save one mistaken one. A system
    /// card has no button, since there is nothing to remove.
    final class ThemeCard: NSControl {
        static func systemTitle(_ kind: VSCodeTheme.Kind) -> String {
            kind == .dark ? "macOS Dark" : "macOS Light"
        }
        static let pictureSize = NSSize(width: 84, height: 54)
        /// The remove button's diameter, and its inset from the picture's
        /// top-right corner.
        static let removeSize: CGFloat = 18
        static let removeInset: CGFloat = 4
        let id: String?
        /// The kind the card is of: the theme's, or the system palette it is
        /// a picture of.
        let kind: VSCodeTheme.Kind
        let title: String
        let palette: MiniWindowPalette
        var onPick: ((String?, VSCodeTheme.Kind) -> Void)?
        var onRemove: ((String) -> Void)?
        private let label: NSTextField
        private var hoverArea: NSTrackingArea?
        private(set) var isHovered = false { didSet { needsDisplay = true } }
        var isSelected = false {
            didSet {
                needsDisplay = true
                label.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: isSelected ? .semibold : .regular)
            }
        }

        init(id: String?, kind: VSCodeTheme.Kind, title: String, palette: MiniWindowPalette) {
            self.id = id
            self.kind = kind
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

        private var picture: NSRect {
            NSRect(x: 3, y: bounds.height - Self.pictureSize.height - 3,
                   width: Self.pictureSize.width, height: Self.pictureSize.height)
        }

        /// Where the remove button is drawn, or nil for a card with none.
        var removeButtonRect: NSRect? {
            guard id != nil else { return nil }
            let picture = self.picture
            return NSRect(x: picture.maxX - Self.removeInset - Self.removeSize,
                          y: picture.maxY - Self.removeInset - Self.removeSize,
                          width: Self.removeSize, height: Self.removeSize)
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let hoverArea { removeTrackingArea(hoverArea) }
            let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                      owner: self)
            addTrackingArea(area)
            hoverArea = area
        }

        override func mouseEntered(with event: NSEvent) { isHovered = true }
        override func mouseExited(with event: NSEvent) { isHovered = false }

        override func mouseDown(with event: NSEvent) {
            press(at: convert(event.locationInWindow, from: nil))
        }

        /// A click at `point` in this card's coordinates: the remove button
        /// removes, anywhere else picks. The whole of the decision, so a
        /// check can press without an event.
        func press(at point: NSPoint) {
            if let id, let button = removeButtonRect, button.contains(point) {
                onRemove?(id)
            } else {
                onPick?(id, kind)
            }
        }

        /// What a click at `point` does, for a check with no pointer.
        func actionForMeasurement(at point: NSPoint) -> String {
            if id != nil, let button = removeButtonRect, button.contains(point) { return "remove" }
            return "pick"
        }

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
            let picture = self.picture
            NSGraphicsContext.saveGraphicsState()
            MiniWindowPalette.draw(palette, in: picture)
            NSGraphicsContext.restoreGraphicsState()
            let ring = NSBezierPath(roundedRect: picture.insetBy(dx: -2.5, dy: -2.5), xRadius: 8, yRadius: 8)
            ring.lineWidth = isSelected ? 2.5 : 1
            (isSelected ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
            ring.stroke()
            // The remove button: a dark disc with a white minus, in the
            // picture's corner, only under the pointer. Fixed colours rather
            // than the appearance's, because it sits on the picture's own
            // paper, which is whatever the theme says and not the window's.
            if isHovered, let button = removeButtonRect {
                NSColor.black.withAlphaComponent(0.6).setFill()
                NSBezierPath(ovalIn: button).fill()
                NSColor.white.setStroke()
                let minus = NSBezierPath()
                minus.move(to: NSPoint(x: button.minX + 5, y: button.midY))
                minus.line(to: NSPoint(x: button.maxX - 5, y: button.midY))
                minus.lineWidth = 1.5
                minus.lineCapStyle = .round
                minus.stroke()
            }
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
