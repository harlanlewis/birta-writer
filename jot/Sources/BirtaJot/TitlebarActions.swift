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
/// changes opacity and never width. `TitleBarView` states the rule and the
/// reason; one level out it is worse rather than better, because this view
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
    /// The box one button holds. Small, because every point here is a point
    /// the file's name does not get; the HEIGHT is the whole band, so the
    /// target is easier to hit than this number suggests.
    ///
    /// Two points of air around the widest of the three at `symbolPointSize`,
    /// which is `square.and.pencil` at eighteen points across. It was the same
    /// eighteen as the glyph, so that one button was flush to its box on both
    /// sides and sat against its neighbour with nothing between them.
    fileprivate static let buttonWidth: CGFloat = 22
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
    var room: CGFloat { Self.leadingGap + Self.buttonWidth * CGFloat(buttons.count) }

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

    override func layout() {
        super.layout()
        for (index, button) in buttons.enumerated() {
            button.frame = NSRect(x: Self.leadingGap + CGFloat(index) * Self.buttonWidth,
                                  y: 0,
                                  width: Self.buttonWidth,
                                  height: bounds.height)
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
}

/// One borderless titlebar button: a template symbol, and nothing else until
/// the pointer is on it.
///
/// No bezel, because the band it sits in has no ground of its own: the page is
/// drawn under a transparent titlebar, so a button with a fill would be a card
/// floating over whatever text happens to be beneath it. What says the control
/// is live is the ink going from secondary to full, which is the same channel
/// the title and the chevron already use for the same claim.
@MainActor
final class TitlebarActionButton: NSButton {
    private var isHovered = false
    private var isKey = true

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
        contentTintColor = .secondaryLabelColor
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

    private func syncInk() {
        contentTintColor = isKey
            ? (isHovered ? .labelColor : .secondaryLabelColor)
            : .tertiaryLabelColor
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
