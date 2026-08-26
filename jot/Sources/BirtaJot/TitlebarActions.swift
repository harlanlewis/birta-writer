import AppKit
import BirtaJotCore

/// The file actions the titlebar draws, after the window's title.
///
///     ◉ ◉ ◉   Jot 2026-08-25.md ⌄   ✎  📁  🕐
///                                   └ this view ┘
///
/// New Note, Open and Open Recent are what a person does to the DOCUMENT as a
/// whole rather than to its text, and they are the ones this app's menu bar is
/// worst at offering: it appears only once the app is frontmost, which a
/// summoned panel does not always make it. There is a Dock icon to drop a file
/// on only if `Prefs.showInDock` has been turned on, which it is not by
/// default. So the panel that is already on screen carries them, beside the
/// name of the file they act on.
///
/// ## Why these symbols
///
/// `square.and.pencil` is the compose mark, which is what Mail and Notes put
/// on the button that makes a new one; `doc.badge.plus` says the same thing
/// more literally and says it in a badge too small to read at this size, and a
/// bare `plus` says "add" without saying what to.
///
/// `folder` is Open. macOS has no dedicated Open glyph, because Open is a menu
/// verb everywhere else, and a folder is what every toolbar that has needed
/// one has settled on. The near alternatives are each wrong in a specific way:
/// `tray.and.arrow.down` and `square.and.arrow.down` are import and download,
/// which is not what this does to a file already on the disk; `arrow.up.doc`
/// is export, pointing the wrong way entirely; `doc.text.magnifyingglass` is
/// searching inside a document rather than choosing one.
///
/// `clock` is Open Recent, which is the mark the Finder's own Recents puts in
/// its sidebar, so it is the one a reader has already been taught here.
/// `clock.arrow.circlepath` says "history" more precisely and is three marks
/// deep at this point size, which at eighteen points across is a smudge;
/// `arrow.uturn.backward` is Undo everywhere else in this app's menus and
/// would be a second meaning for a gesture that already has one.
///
/// It carries no disclosure chevron, though it opens a menu. There is no room
/// for one that would not come out of the file's name, and every button in
/// this strip is drawn as a bare symbol, so a chevron on one of the three
/// would read as a difference in kind rather than as a promise of a menu.
///
/// The one collision worth naming: a folder is also what this titlebar's path
/// popup is a picture of (Cmd-click the title). They are different gestures in
/// different places, and the tooltip names this one, but if the pair is ever
/// confused in use, that is where it will have come from.
///
/// ## Geometry, which is not negotiable here
///
/// The room is reserved WHETHER OR NOT the buttons are drawn, and hover
/// changes what is painted and never a frame. `TitleBarView` states the rule
/// and the reason; one level out it is worse rather than better, because this view
/// sits at the accessory's trailing edge and the drag strip starts where the
/// accessory ends (`Coordinator.layoutTitlebarDrag`). Buttons that took their
/// width on hover would move the strip's origin without a layout pass to
/// follow it, so the strip would be left lying over the buttons it just made
/// room for, and the clicks would land on the window drag.
///
/// The cost is real and is paid by the title: the name has this much less room
/// before it truncates, at every window width. That is the trade, and the
/// alternative is not a cheaper version of it.
@MainActor
final class TitlebarActionsView: NSView {
    /// Air between the title's chevron and the first button, which is what
    /// makes the pair read as its own group rather than as more title.
    private static let leadingGap: CGFloat = 6
    /// The box one button holds, and the air between two of them.
    ///
    /// All three are the PAGE'S, and that is the whole of why they are these
    /// numbers rather than any others: the other half of this band is HTML a
    /// few inches away (`.tb-btn` and `.tb-zone` in webview/), and the two have
    /// to read as one strip of controls rather than as two toolbars that met
    /// in the middle. The page is the half that cannot move, because those
    /// rules are shared with the VS Code extension, where there is no titlebar
    /// to match; this side follows, exactly as `symbolPointSize` below already
    /// follows the page's icon size.
    ///
    /// `jot/scripts/measure.sh` reads both halves out of the live window and
    /// fails when they disagree, which is the only place the pair is checkable
    /// at all: each half is defensible on its own, in a toolkit that knows
    /// nothing about the other.
    ///
    /// The height in particular has to be the box rather than the whole band,
    /// even though the strip above and below the symbol belongs to nothing
    /// else and a taller target would be free. It stops being free the moment
    /// the box is drawn: a hover fill the height of the band is half again the
    /// height of the one beside it.
    fileprivate static let buttonWidth: CGFloat = 26
    fileprivate static let buttonGap: CGFloat = 2
    fileprivate static let buttonHeight: CGFloat = 24
    /// The size the symbols are drawn at, chosen to MATCH the page's own icons
    /// rather than picked for this strip alone: `webview/ui/icons.ts` draws a
    /// 16-point glyph, and thirteen points is where the tallest of these three
    /// measures sixteen. The two halves of this band are one strip to the eye
    /// and were visibly not one strip to the ruler, the native side reading
    /// smaller and lighter than the page's controls a few inches away.
    ///
    /// `.medium` for the same reason and at no cost: the page's icons are a
    /// two-point stroke, which is heavier than SF Symbols' regular, and the
    /// weight changes no measurement at this size. The other way round is
    /// defensible too, since regular is what macOS titlebar chrome usually
    /// wears, but the page's icons are shared with the extension and this side
    /// is the half that can move.
    fileprivate static let symbolPointSize: CGFloat = 13
    /// What this view takes from the accessory, drawn or not.
    ///
    /// Derived from the buttons it was given rather than from a count written
    /// down beside them, so adding one widens the reservation, the title's
    /// ceiling and the drag strip's origin together. A constant here is the
    /// version of this that goes wrong silently: the extra button draws fine
    /// and the strip lies over it.
    var room: CGFloat {
        Self.leadingGap
            + Self.buttonWidth * CGFloat(buttons.count)
            + Self.buttonGap * CGFloat(max(0, buttons.count - 1))
    }

    /// The buttons, in the order they are drawn. Published so a check can walk
    /// them rather than reach for them by index.
    private(set) var buttons: [TitlebarActionButton] = []

    /// Whether the buttons are currently offered. The WANTED value, not the
    /// presentation: `hitTest` reads it, and reading the alpha instead would
    /// make a button unclickable for the length of its own fade in and
    /// clickable for the length of its fade out.
    private(set) var shown = false

    /// One entry per button: the menu row it repeats, and the symbol it draws.
    ///
    /// The selector is not a lookup key, it is what the button SENDS. Nil
    /// target, so it travels the responder chain to the same object the menu
    /// row reaches, which is what makes the button and the row one action
    /// rather than two that happen to agree today. A closure here instead
    /// would be a second implementation of the same verb, able to drift from
    /// the row while still borrowing its label and its chord, which is the
    /// most convincing way to be wrong.
    ///
    /// Everything printed comes from the row too: nothing about this button is
    /// spelled twice.
    struct Action {
        let selector: Selector
        let symbol: String
    }

    init(actions: [Action]) {
        super.init(frame: .zero)
        for action in actions {
            let button = TitlebarActionButton(action: action)
            button.alphaValue = 0
            button.isHidden = true
            addSubview(button)
            buttons.append(button)
        }
        setFrameSize(NSSize(width: room, height: 0))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The buttons, in a row, centred on the band.
    ///
    /// Centred rather than filling it, for the same reason the title beside
    /// them is centred rather than stretched: macOS puts a window title's
    /// vertical centre on the close button's, this view is given the whole
    /// band, and the page's own controls are centred on that same axis by
    /// taking the band's height as their row's. Three surfaces, one axis.
    override func layout() {
        super.layout()
        let y = ((bounds.height - Self.buttonHeight) / 2).rounded()
        for (index, button) in buttons.enumerated() {
            button.frame = NSRect(x: Self.leadingGap
                                     + CGFloat(index) * (Self.buttonWidth + Self.buttonGap),
                                  y: y,
                                  width: Self.buttonWidth,
                                  height: Self.buttonHeight)
        }
    }

    /// Offer the buttons, or take them away.
    ///
    /// `animated` is false only for the measurement path, for the reason
    /// `TitleBarView.chevronForMeasurement` gives: a probe that wrote the alpha
    /// itself would be answering its own question.
    func setShown(_ wanted: Bool, animated: Bool = true) {
        guard wanted != shown else { return }
        shown = wanted
        let alpha: CGFloat = wanted ? 1 : 0
        // `isHidden`, not opacity alone, and the difference is not visual.
        // A view at zero alpha is still a control: it keeps its place in the
        // key view loop under Full Keyboard Access, and it is still an
        // accessibility element. So an invisible button would take a focus
        // ring and answer a press, and there would be nothing on screen to
        // explain either. Hiding takes it out of all three.
        //
        // It is applied at the ENDS of the fade: on the way in before the
        // animation, because a hidden view animates nothing, and on the way
        // out after it, guarded on the decision not having changed again
        // while the fade ran.
        if wanted { buttons.forEach { $0.isHidden = false } }
        guard animated else {
            buttons.forEach { $0.alphaValue = alpha; $0.isHidden = !wanted }
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.12
            buttons.forEach { $0.animator().alphaValue = alpha }
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.shown else { return }
                self.buttons.forEach { $0.isHidden = true }
            }
        })
    }

    /// The button under `point`, in this view's coordinates, or nil.
    ///
    /// Only while the buttons are offered. Reserved room that is not currently
    /// showing anything must fall through to the band behind it, or a strip of
    /// empty titlebar beside the name would swallow a window drag and answer
    /// with nothing.
    func button(at point: NSPoint) -> NSView? {
        guard shown else { return nil }
        return buttons.first { $0.frame.contains(point) }
    }

    /// Follow the window's key state, as the title and its chevron do: a
    /// background window draws its chrome quietly.
    func setWindowKey(_ key: Bool) {
        buttons.forEach { $0.setWindowKey(key) }
    }

    /// What the page's buttons wear on hover, so these can wear the same.
    ///
    /// Handed over rather than written down here, and the difference is what
    /// makes it stay true: the wash and the radius are the page's palette
    /// (`--vscode-toolbar-hoverBackground`, `--ui-radius-m`), which flips with
    /// the theme and is tuned in one file for two products. A copy in Swift
    /// would be a second declaration nothing compares to the first, and the
    /// day it drifted the only symptom would be one half of a band looking
    /// slightly wrong beside the other, which is a thing nobody reports and
    /// no check here could see.
    func setBandChrome(hoverFill: NSColor?, cornerRadius: CGFloat) {
        buttons.forEach { $0.setBandChrome(hoverFill: hoverFill, cornerRadius: cornerRadius) }
    }
}

/// One borderless titlebar button: a template symbol over a hover fill.
///
/// The band has a ground, and knowing whose it is settles what a fill here
/// means. The page's toolbar is `position: fixed` at the top of a window with
/// `fullSizeContentView` and paints `--vscode-editor-background` from edge to
/// edge, so the paper under these buttons is the page's own paper rather than
/// whatever text happens to be beneath a transparent titlebar. A fill here
/// sits on the same ground the page's buttons' fills sit on, a few inches to
/// the right.
///
/// So hover is said the way the page says it: a rounded wash behind the glyph,
/// in the page's own colour and at the page's own radius (`setBandChrome`).
/// The ink stays put, because the page's does.
///
/// With no wash to draw, which is the page not having answered yet or its
/// palette no longer parsing, the ink carries hover instead and goes from
/// secondary to full. That is a floor rather than an alternative: a control
/// that says nothing at all under the pointer is the one outcome worth a
/// branch to avoid.
@MainActor
final class TitlebarActionButton: NSButton {
    private var isHovered = false
    private var isKey = true
    private var hoverFill: NSColor?

    /// The menu row this button repeats. Nil only if the row has been deleted,
    /// which is a state to be visible rather than papered over: the button
    /// then carries no label and no tooltip instead of an invented one.
    private let row: JotMenu.Row?

    init(action: TitlebarActionsView.Action) {
        row = JotMenu.row(for: action.selector)
        super.init(frame: .zero)
        // Template, so the symbol inks itself from `contentTintColor` and
        // follows the appearance rather than carrying a colour this file would
        // have to keep in step with the title's.
        image = NSImage(systemSymbolName: action.symbol, accessibilityDescription: row?.title)
        image?.isTemplate = true
        symbolConfiguration = .init(pointSize: TitlebarActionsView.symbolPointSize, weight: .medium)
        imagePosition = .imageOnly
        isBordered = false
        bezelStyle = .shadowlessSquare
        title = ""
        // Nil target on purpose: the click travels the responder chain and
        // ends at the application's delegate, which is where the menu row's
        // own selector is implemented. See `Action`.
        target = nil
        self.action = action.selector
        // A layer, because the hover fill is drawn as one. Deliberately NOT
        // `masksToBounds`: a rounded background colour is clipped to the
        // corner radius on its own, and the flag would additionally clip
        // anything drawn OUTSIDE the box, which under Full Keyboard Access is
        // the focus ring.
        wantsLayer = true
        syncInk()
        if let row {
            // Label AND chord from the row. The button is an element in its own
            // right, unlike the chevron beside it, because it DOES something
            // rather than pointing at something the title already does.
            setAccessibilityLabel(row.title)
            toolTip = row.symbols.isEmpty ? row.title : "\(row.title)  \(row.symbols)"
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero,
                                       options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self))
    }

    override func mouseEntered(with event: NSEvent) { isHovered = true; syncInk() }
    override func mouseExited(with event: NSEvent) { isHovered = false; syncInk() }

    func setWindowKey(_ key: Bool) {
        guard key != isKey else { return }
        isKey = key
        syncInk()
    }

    func setBandChrome(hoverFill: NSColor?, cornerRadius: CGFloat) {
        self.hoverFill = hoverFill
        layer?.cornerRadius = cornerRadius
        syncInk()
    }

    private func syncInk() {
        guard isKey else {
            contentTintColor = .tertiaryLabelColor
            layer?.backgroundColor = nil
            return
        }
        // With a wash to draw, the ink is the page's: full strength, hovered
        // or not, because that is what `.tb-btn` does. Without one it is the
        // only channel left, so it carries hover on its own.
        contentTintColor = (hoverFill != nil || isHovered) ? .labelColor : .secondaryLabelColor
        // A plain `cgColor`, with no appearance context taken around it, and
        // that is correct here rather than an omission: the fill is a fixed
        // sRGB value the page resolved against the theme in force, not a
        // dynamic system colour with a branch left in it. What keeps it right
        // across a flip to dark is the page being asked again
        // (`Coordinator.applyTheme`), which is also the only thing that could
        // keep it right, since a layer would not re-resolve a dynamic colour
        // either.
        layer?.backgroundColor = isHovered ? hoverFill?.cgColor : nil
    }

    /// Whether this button has a wash to draw at all, for a check with no
    /// pointer. Asked without setting the hover state, so reading it disturbs
    /// nothing: a probe that had to hover the button first would be a probe
    /// that leaves it hovered, or one that has to guess where the pointer
    /// really was to put it back.
    var hasHoverFill: Bool { hoverFill != nil }

    /// What is actually drawn behind the glyph under a pointer that is not
    /// there. The colour rather than a flag, so a fill that resolved to
    /// nothing is not reported as a fill.
    func hoverFillForMeasurement(_ hovered: Bool) -> CGColor? {
        isHovered = hovered
        syncInk()
        return layer?.backgroundColor
    }

    /// Set the hover state and read back what it decided, for a check that has
    /// no pointer. Same shape and same reason as
    /// `TitleBarView.chevronForMeasurement`.
    func hoverForMeasurement(_ hovered: Bool) -> NSColor? {
        isHovered = hovered
        syncInk()
        return contentTintColor
    }
}
