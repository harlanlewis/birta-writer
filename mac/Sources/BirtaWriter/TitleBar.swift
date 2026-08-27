import AppKit
import BirtaWriterCore

/// The window's title, where macOS puts a window's title: beside the traffic
/// lights, in the titlebar.
///
///     ◉ ◉ ◉   Scratchpad.md — Edited
///
/// A leading `NSTitlebarAccessoryViewController` rather than the window's own
/// `title`, and the reason is geometry. A standard title is CENTRED; the
/// leading placement TextEdit and every document app now uses comes from an
/// `NSToolbar` with `toolbarStyle = .unified`, and giving this panel a toolbar
/// would put a second bar in a window whose titlebar band is already the page's
/// own toolbar, drawn under a transparent full-height titlebar. An accessory
/// sits in that band without claiming height, which is the only thing the panel
/// can afford.
///
/// What it draws is what macOS draws, deliberately and not approximately: the
/// document's name in the title face, and ` — Edited` after it in secondary ink
/// exactly while there are unwritten bytes. No proxy icon: the panel edits one
/// file and never a package or a bundle, so the icon would be the same generic
/// document mark on every note, and a mark that never varies is not
/// information.
///
/// The two gestures are the platform's, minus the ones a proxy icon owns:
///
///   click             reveal the file in Finder
///   Cmd or Ctrl click the path popup, ancestors up to the volume, each
///                     revealing itself in Finder
///
/// A plain click on a real title control does nothing at all, because the icon
/// beside it is what you drag and Cmd-click. With no icon there is nothing to
/// drag, so the plain click takes the gesture people reach for it with.
@MainActor
final class TitleBarView: NSView {
    /// Reveal `url` in Finder. Injected so the popup and the click share one
    /// path out, and so a test can watch it without opening a window.
    var onReveal: ((URL) -> Void)?
    /// Move the bound file to this URL, keeping the editor on it. Handles both
    /// the popover's rows: a rename is a move within the same folder.
    var onRelocate: ((URL) -> Void)?
    /// A file button was pointed at, or stopped being: its label and its box
    /// in WINDOW coordinates, or nil to take the label away. Forwarded from
    /// the actions view so the coordinator has one thing to set.
    var onTooltip: ((String?, NSRect) -> Void)? {
        get { actions.onTooltip }
        set { actions.onTooltip = newValue }
    }

    /// Built once and refilled on every open, never per click: a popover whose
    /// controller is rebuilt loses the field being edited if the same one is
    /// reopened, and `show(url:)` re-reads the file anyway.
    private lazy var popoverController: TitlePopoverController = {
        let controller = TitlePopoverController()
        controller.onRename = { [weak self] name in
            guard let url = self?.url else { return }
            self?.popover?.performClose(nil)
            self?.onRelocate?(url.deletingLastPathComponent().appendingPathComponent(name))
        }
        controller.onMove = { [weak self] directory in
            guard let url = self?.url else { return }
            self?.popover?.performClose(nil)
            self?.onRelocate?(directory.appendingPathComponent(url.lastPathComponent))
        }
        controller.onTags = { [weak self] tags in
            guard let url = self?.url else { return }
            try? FinderTags.write(tags, to: url)
        }
        controller.onDismissRequest = { [weak self] in self?.popover?.performClose(nil) }
        return controller
    }()
    private var popover: NSPopover?

    private let label = TitleBarView.makeTitleField()
    /// The affordance that says the title opens something, drawn the way macOS
    /// draws it on a document window: a small chevron after the name, on
    /// hover.
    ///
    /// Ours to draw, because the platform's belongs to `NSDocument`. A window
    /// gets the system's title menu and its Name/Tags/Where popover by being a
    /// document window, and the class behind it is not API; AppKit's headers
    /// carry no `titleMenu` anything, and `representedURL` buys only the
    /// cmd-click path popup, which this view already implements itself. The app
    /// edits one file from a panel and is not an `NSDocument` app, so the
    /// choice is to draw the affordance or to have none.
    private let chevron = NSImageView()
    /// New Note and Open, drawn after the chevron on hover.
    ///
    /// Built empty and filled by `setActions`, because what the buttons DO is
    /// the coordinator's and this view is the only thing that knows the
    /// geometry they have to fit into. A view with no actions draws nothing and
    /// still reserves the room, which is what keeps every measurement in this
    /// file the same whether or not the app got round to wiring them.
    private var actions = TitlebarActionsView(actions: [])
    /// Hover over the title itself, and hover over the drag strip beside it.
    ///
    /// Two sources rather than one because the affordance is meant to be found:
    /// the band reads as one strip, so pointing anywhere along it should offer
    /// what the strip holds. Kept apart rather than collapsed into a single
    /// flag, because each source has to be able to withdraw its own claim
    /// without guessing at the other's.
    private var isHovered = false
    private var isBandHovered = false
    /// A ceiling on the name, so a long one cannot push the title across the
    /// window and under the page's own toolbar. The label truncates instead.
    ///
    /// It is the WINDOW'S measurement, not this view's, which is why it
    /// arrives from outside. How much room the title may take depends on how
    /// wide the window is and on how much of the far edge the page's controls
    /// have claimed, and this view can see neither. A constant here is wrong
    /// in both directions at once, too small in a wide window and too large in
    /// a narrow one, and it fails quietly both ways: a name cut short reads as
    /// a shorter name, and a name run under the gear reads as a page that drew
    /// on top of it.
    ///
    /// Unbounded until told. `Coordinator.layoutTitlebarDrag` is the one thing
    /// that knows the answer, and it sets this before the panel is ever on
    /// screen and again on every layout pass, so the initial value is reached
    /// only by `build()`.
    private var textCeiling: CGFloat = .greatestFiniteMagnitude
    private var url: URL?
    private var edited = false
    private var isKey = true

    /// What the label was last painted with, so an identical repaint is not
    /// one. Both fields, because both change what is on screen.
    private struct Rendered: Equatable {
        let text: String
        let key: Bool
        /// Whether the title named the application rather than a file. In the
        /// key because the same characters mean different things either side
        /// of it: one opens a popover and one is inert.
        let plain: Bool
    }
    private var lastRendered: Rendered?

    /// The characters actually on screen, for `mac/scripts/measure.sh`.
    ///
    /// Separate from the accessibility label, which carries the whole name.
    /// The script is asking what was DRAWN, and a check that read the a11y
    /// label would report a name in full while the titlebar showed half of it.
    private(set) var drawnTitle = ""

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 0, height: TitleBarView.height))
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Air between the traffic lights and the title. NOT an inset past the
    /// buttons: AppKit places a `.leading` accessory after them already.
    private static let leadingGap: CGFloat = 8
    /// Air between the name and the chevron, and the box the chevron sits in.
    ///
    /// Reserved WHETHER OR NOT the chevron is drawn, which is the whole of why
    /// the title does not move under the pointer. A chevron that takes its
    /// width on hover shifts everything after it at the moment you arrive,
    /// including the drag strip whose start is this view's `maxX`, so hover
    /// changes opacity here and never geometry. The formatting row's own
    /// chevron was built the other way once and pushed its whole row sideways.
    private static let chevronGap: CGFloat = 4
    private static let chevronWidth: CGFloat = 11
    /// The room the chevron holds, drawn or not. One expression, because
    /// `resize` adds it and `layout` subtracts it, and the two disagreeing is
    /// how the title ends up a few points wider or narrower than its own box.
    private static let chevronRoom: CGFloat = chevronGap + chevronWidth
    /// Everything inside this view that is NOT the text, which is what a
    /// ceiling on the text has to be computed net of. Published because the
    /// arithmetic lives in `TitlebarBand`, so the caller has to hand it over.
    ///
    /// The buttons' room is in here for the same reason the chevron's is: it is
    /// held whether or not they are drawn, so the ceiling must be net of it at
    /// every window width and not only while the pointer is on the band.
    ///
    /// An instance property rather than a static one, because the buttons'
    /// room is theirs to report: the actions arrive after this view is built
    /// (`setActions`), so how many there are is not something a type can know.
    var chromeWidth: CGFloat { Self.leadingGap + Self.chevronRoom + actions.room }
    /// The height this view is BUILT at, and nothing else.
    ///
    /// AppKit stretches a titlebar accessory to the titlebar's own height, so
    /// this number is stale from the moment the accessory is attached.
    /// Centering the label against it therefore puts the title low by half
    /// the difference between the two, which is what `layout()` below exists
    /// to stop. Anything that needs the height the view actually HAS reads
    /// `bounds`.
    static let height: CGFloat = 28
    /// The face macOS titles itself with, asked for by name rather than
    /// reproduced as a size and a weight, so it follows the system rather than
    /// a guess about it.
    ///
    /// A constant because `paint` has to put it ON the attributed string, not
    /// only on the field. A field draws an attributed run in its own font when
    /// the run names none, but `NSAttributedString.size()` has no field to ask
    /// and measures an unattributed run in the DEFAULT system font instead. So
    /// a string built without it measures a size nothing ever draws at, and
    /// every width taken from it is short.
    private static let titleFont = NSFont.titleBarFont(ofSize: NSFont.systemFontSize)

    /// A title label, configured. Used for the one this view draws AND for the
    /// ruler below, because the two have to be the same KIND of thing: the
    /// measurer decides how much name fits and the label draws it, so a
    /// difference between their configurations is a difference between what
    /// was promised to fit and what does.
    private static func makeTitleField() -> NSTextField {
        let field = NSTextField(labelWithString: "")
        field.font = titleFont
        // A title is ONE line, and this is the only thing enforcing it.
        //
        // The field's own `lineBreakMode` is NOT set, and its absence is the
        // point. A cell lays an attributed value out under the paragraph style
        // that value carries, never under the field's setting, and this label
        // is filled through `attributedStringValue` and never through
        // `stringValue`. So a `lineBreakMode` here would be inert while
        // looking load-bearing. WHERE the name is shortened is
        // `WindowTitle.runs(fitting:)`, before the string exists.
        //
        // What remains for the cell is refusing to WRAP, which is this line:
        // `NSTextField(labelWithString:)` leaves it off, so the default
        // paragraph style's `.byWordWrapping` applies and a name with a space
        // in it lays out on two lines inside a box one line tall, the first
        // drawn and the rest clipped away. `usesSingleLineMode` reinterprets a
        // wrapping mode as `.byClipping`, which is AppKit's documented rule
        // for it, and one line is all this needs to be.
        //
        // Deliberately not a truncating paragraph style on top. A cell in one
        // needs its box wider than the string measures before it will draw the
        // string in full, so it truncates a name that fits and draws an
        // ellipsis that means the window is too narrow when it is not; the
        // `title ink` arm of `mac/scripts/measure.sh` is what says so.
        field.usesSingleLineMode = true
        return field
    }

    /// An off-screen label, kept only to be measured.
    ///
    /// The measurer `WindowTitle.runs(fitting:measure:)` bisects with, and it
    /// asks a CELL rather than an attributed string on purpose. A cell needs
    /// more room to draw a string than the string reports needing, so a
    /// truncation decided on the string's number promises that a name fits
    /// into a box the cell then clips the tail of it out of.
    ///
    /// Same factory as the drawn label, so the two cannot drift apart. Reused
    /// rather than built per candidate because the bisection asks about a
    /// handful of strings per repaint and a repaint happens on every point of
    /// a window drag.
    private static let ruler = makeTitleField()

    /// What a candidate title needs, in the font and the cell it will be drawn
    /// in. Falls back to the string's own width only if the field has no
    /// cell, which it always has.
    private static func width(of text: String) -> Double {
        ruler.attributedStringValue = NSAttributedString(string: text, attributes: [.font: titleFont])
        guard let cell = ruler.cell else {
            return Double(ruler.attributedStringValue.size().width)
        }
        let unbounded = NSRect(x: 0, y: 0, width: CGFloat.greatestFiniteMagnitude, height: height)
        return Double(cell.cellSize(forBounds: unbounded).width)
    }
    /// Laid out by hand, and that is the whole reason this file was worth
    /// getting wrong once.
    ///
    /// A titlebar accessory's view is a view controller's root view, so its
    /// `translatesAutoresizingMaskIntoConstraints` is on and AppKit turns its
    /// frame into required constraints. A view built by constraints alone
    /// therefore starts at a zero frame and STAYS there: the accessory
    /// attaches, reports a plausible height, and draws nothing, which on
    /// screen is indistinguishable from never having arrived and in the view
    /// hierarchy is indistinguishable from having worked. Sizing this view's
    /// own frame from its content is what makes the width real.
    private func build() {
        label.setAccessibilityRole(.staticText)
        addSubview(label)
        // Template so it inks itself from the control tint and follows the
        // appearance, rather than carrying a colour this file would have to
        // keep in step with the two the title already uses.
        chevron.image = NSImage(systemSymbolName: "chevron.down",
                                accessibilityDescription: nil)
        chevron.image?.isTemplate = true
        chevron.symbolConfiguration = .init(pointSize: 9, weight: .semibold)
        chevron.contentTintColor = isKey ? .secondaryLabelColor : .tertiaryLabelColor
        chevron.alphaValue = 0
        // It is a picture of what a click does, and the click is this view's.
        // Announcing it separately would put a second, unlabelled element in
        // front of the title for anyone reading the window by keyboard.
        chevron.setAccessibilityElement(false)
        addSubview(chevron)
        addSubview(actions)
        resize()
    }

    /// Show the chevron and the buttons while the pointer is over the title or
    /// the band, and keep them while the popover the chevron opened is still
    /// up, which is what macOS does: the affordance stays as long as the thing
    /// it points at is open, even after the pointer has left to use it.
    ///
    /// One decision for both, rather than two syncs that would have to agree:
    /// they are one piece of hover chrome, and a chevron that appeared without
    /// the buttons, or after them, would read as two unrelated things reacting
    /// to the same gesture.
    ///
    /// `animated` is false only for the measurements below, and it exists so
    /// those probes can read this decision rather than restate it. The fade is
    /// the only reason a caller would ever want the value late.
    private func syncHoverChrome(animated: Bool = true) {
        // Nothing to point at while the title names the application: the
        // chevron is a picture of a click this view is not taking, and the
        // buttons beside it are two actions the app is refusing. That last is
        // not a second rule: the title names the application exactly while the
        // first-run screen is up (`Coordinator.presentWelcome` is the only
        // caller of `showAppName`), and `AppDelegate.documentCommands` already
        // withdraws New Note and Open there. Offering them here would be the
        // one surface that had not been told.
        if plainTitle != nil {
            chevron.alphaValue = 0
            actions.setShown(false, animated: animated)
            return
        }
        // No file, no affordance: an empty title has nothing to open.
        //
        // AWAKE, not hovered. The window being key is enough on its own, and
        // that is the whole answer to a complaint these buttons earned while
        // they were hover-only: a control nobody can see is a control nobody
        // learns, and its tooltip never gets read because resting on a blank
        // stretch of titlebar is not a thing anyone does. Hover still counts,
        // so the buttons come back for a pointer on a background window, and
        // the popover being up holds them while the window gives up key to it.
        //
        // What this does NOT do is change any geometry: the room is reserved
        // either way (`TitlebarActionsView.room`), so the title's ceiling and
        // the drag strip's origin are the same numbers they were.
        let offered = url != nil && (isKey || isHovered || isBandHovered || popover?.isShown == true)
        actions.setShown(offered, animated: animated)
        let wanted: CGFloat = offered ? 1 : 0
        guard chevron.alphaValue != wanted else { return }
        guard animated else {
            chevron.alphaValue = wanted
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            chevron.animator().alphaValue = wanted
        }
    }

    /// Give the buttons their actions. Called once, when the coordinator has
    /// something for them to run.
    func setActions(_ list: [TitlebarActionsView.Action]) {
        actions.removeFromSuperview()
        actions = TitlebarActionsView(actions: list)
        actions.setWindowKey(isKey)
        addSubview(actions)
        needsLayout = true
    }

    /// Hover anywhere on the draggable stretch of the band, forwarded by the
    /// coordinator. See `isBandHovered`.
    func setBandHovered(_ hovered: Bool) {
        guard hovered != isBandHovered else { return }
        isBandHovered = hovered
        syncHoverChrome()
    }

    /// The hover area, remembered so this view takes back ITS OWN and nothing
    /// else. `trackingAreas` is not a list of what this file added: AppKit
    /// puts its own in there, and a tooltip is delivered by one of them, so a
    /// sweep over that array is how a control ends up with a `toolTip` that
    /// reads back correctly and never appears. That is what it did to the
    /// buttons in `TitlebarActions.swift`. Nothing sets a tooltip on THIS view
    /// today (the name's path tooltip belongs to the label, a subview with its
    /// own areas), so this is the hazard removed rather than a bug fixed.
    private var hoverArea: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self)
        addTrackingArea(area)
        hoverArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
        syncHoverChrome()
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
        syncHoverChrome()
    }

    /// Take a new ceiling from the window.
    ///
    /// Does nothing when it has not moved. This runs on every layout pass, so
    /// a resize that does not change the answer must not cost a relayout, and
    /// the early return is also what keeps `resize()` from re-entering the
    /// pass that called it.
    func setTextCeiling(_ ceiling: CGFloat) {
        guard ceiling != textCeiling else { return }
        textCeiling = ceiling
        // Repaint, because WHAT the title says is a function of the ceiling
        // now and not only how much of it is shown: a window dragged narrower
        // has to give up characters, and one dragged wider has to take them
        // back. `paint` returns early when the string it would draw is the one
        // already drawn, so a resize that changes no characters costs a
        // measurement and nothing else.
        paint()
        resize()
        layoutSubtreeIfNeeded()
    }

    /// Fit the view to its text, within the ceiling. The label's own placement
    /// inside it is `layout()`'s, which runs again after AppKit has resized us.
    private func resize() {
        let text = min(drawnTextWidth(), textCeiling)
        // Nothing to open, nothing to point at: an empty title reserves no
        // room, which is also what keeps `hitTest` from claiming a strip of
        // window beside the traffic lights that answers a click with nothing.
        let trailing = text > 0 ? Self.chevronRoom + actions.room : 0
        setFrameSize(NSSize(width: Self.leadingGap + text + trailing, height: bounds.height))
        invalidateIntrinsicContentSize()
        needsLayout = true
    }

    /// Centre the label on the height this view HAS, not the one it was built
    /// with. The whole of the alignment fix, and it has to be here rather than
    /// in `resize()` because AppKit stretches the accessory after we size it,
    /// so the only moment the real height is known is a layout pass.
    ///
    /// What "aligned" means, as a property rather than as a number: macOS puts
    /// a window title's vertical centre on the close button's, and holds that
    /// across the titlebar heights and title fonts its own toolbar styles use.
    /// Centering on `bounds` reproduces it, because AppKit gives the accessory
    /// the whole band. `mac/scripts/measure.sh` asserts that delta against the
    /// live window, which is the only place the claim is checked; nothing here
    /// is a figure to quote.
    override func layout() {
        super.layout()
        let size = label.intrinsicContentSize
        // Never wider than the room this view actually has. The ceiling above
        // is about a long name crowding the page's controls; this is about the
        // view being narrower than its own text for any reason at all, and the
        // difference matters because of HOW each one fails. A label sized past
        // its container is clipped by the container, which cuts the name at
        // whatever pixel the edge falls on and leaves no ellipsis to say so, so
        // a truncated title is indistinguishable from a file that is really
        // called that. Bounded here, the label truncates itself and says it
        // did.
        let room = max(0, bounds.width - chromeWidth)
        let textWidth = min(drawnTextWidth(), textCeiling, room)
        label.frame = NSRect(x: Self.leadingGap,
                             y: ((bounds.height - size.height) / 2).rounded(),
                             width: textWidth,
                             height: size.height)
        chevron.frame = NSRect(x: label.frame.maxX + Self.chevronGap,
                               y: ((bounds.height - Self.chevronWidth) / 2).rounded(),
                               width: Self.chevronWidth,
                               height: Self.chevronWidth)
        // The full band height, not the chevron's box: a taller target is free
        // here, because the strip above and below the symbol belongs to nothing
        // else.
        actions.frame = NSRect(x: chevron.frame.maxX,
                               y: 0,
                               width: actions.room,
                               height: bounds.height)
        actions.layoutSubtreeIfNeeded()
    }

    // MARK: state

    /// What the title reads right now, for `mac/scripts/measure.sh`.
    var currentText: String { label.stringValue }

    /// Open the popover as a click would, and describe what it drew, for
    /// `mac/scripts/measure.sh`. The click itself is unreachable from a script
    /// (the title is native chrome, and the debug key path reaches the web
    /// view), so this is the only way the form is ever built against a real
    /// window and a real file rather than reasoned about.
    func openPopoverForMeasurement() -> String {
        guard let url else { return "no url" }
        showDocumentPopover(for: url)
        return popoverController.describeForMeasurement(shown: popover?.isShown == true)
    }

    /// Commit `name` in the popover's Name field, as typing it and pressing
    /// Return would. Goes through the field so the rules that field applies
    /// (`DocumentName`) are the ones under test, rather than around them.
    func commitNameForMeasurement(_ name: String) {
        guard let url else { return }
        showDocumentPopover(for: url)
        popoverController.commitNameForMeasurement(name)
    }

    /// Where the TEXT sits, in window coordinates, for the same script. The
    /// accessory's own frame is the whole titlebar band, so it answers whether
    /// the accessory arrived and nothing about where the title is drawn in it.
    func labelFrameInWindow() -> NSRect { label.convert(label.bounds, to: nil) }


    /// The width the label needs to DRAW its title, rounded up.
    ///
    /// Asked of the CELL, not of the string, and the difference is the last
    /// glyph. `NSAttributedString.size()` reports a typesetting width; the
    /// cell lays the same string out inside its own insets and needs more
    /// than that, so a box sized to the string's number is a box the cell
    /// draws the tail of the name outside of, and the titlebar clips it. It is
    /// silent in the way the wrap was: every model-side number agrees the name
    /// is drawn in full, because every one of them describes the string.
    /// `measure.sh`'s `title ink` arm is what compares the box to the cell.
    ///
    /// `cellSize(forBounds:)` is the cell's own answer to "how much room does
    /// this take", so it tracks the font and the insets rather than restating
    /// them, and there is no constant here to go stale. The unbounded width is
    /// what asks for the untruncated requirement; the ceiling is applied by
    /// the callers, which is where it belongs.
    ///
    /// Still measured off a string that carries `.font`, which is the other
    /// half of the specification and the other way this has been got wrong: a
    /// run naming no font measures in the default system face, which is
    /// narrower than the titlebar one.
    private func drawnTextWidth() -> CGFloat {
        guard let cell = label.cell else { return label.attributedStringValue.size().width.rounded(.up) }
        let unbounded = NSRect(x: 0, y: 0, width: CGFloat.greatestFiniteMagnitude, height: bounds.height)
        return cell.cellSize(forBounds: unbounded).width.rounded(.up)
    }


    /// How far the title's INK actually reaches, in points.
    ///
    /// The label is rendered into a bitmap and the rightmost column carrying
    /// any alpha is found. This is the only measurement in this file taken from
    /// pixels, and it is here because it is the only one that ever caught the
    /// defect it exists for: a name with a space drew as the word before the
    /// space, while `stringValue`, `accessibilityLabel`, the frame, the
    /// `visibleRect` and the laid-out height all reported a correct title. The
    /// numbers agreed with each other because they all describe the model. Only
    /// the drawing disagreed, so only the drawing can be asked.
    ///
    /// Measure-mode only in practice: it costs a bitmap and a scan of a box
    /// about 130 pixels wide, which is nothing once, and pointless on a path
    /// nobody is checking.
    func drawnInkWidth() -> CGFloat { inkWidth(of: label) }

    /// The shared pixel probe: the rightmost column of `view` carrying alpha.
    private func inkWidth(of view: NSView) -> CGFloat {
        let box = view.bounds
        guard box.width > 0, box.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: box) else { return -1 }
        view.cacheDisplay(in: box, to: rep)
        let wide = rep.pixelsWide, high = rep.pixelsHigh
        guard wide > 0, high > 0 else { return -1 }
        for x in stride(from: wide - 1, through: 0, by: -1) {
            for y in 0..<high where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 {
                return CGFloat(x + 1) / CGFloat(wide) * box.width
            }
        }
        return 0
    }

    /// What the title's glyphs need, against the width the label was given.
    ///
    /// Guards the milder failure, which is real and separate: a label narrower
    /// than its string makes the cell truncate, and the title ends in an
    /// ellipsis it did not need. It does NOT guard the one this file exists to
    /// stop; `drawnInkWidth` does. A wrapped-height measurement was tried here
    /// and removed, because it reported one line in the broken build and the
    /// fixed one alike, and a number that agrees with a broken build is worse
    /// than no number.
    func titleFit() -> (needed: CGFloat, given: CGFloat) {
        (label.attributedStringValue.size().width, label.bounds.width)
    }

    /// The same width, asked of the FIELD instead of the string.
    ///
    /// Its whole job is to disagree. `titleFit().needed` measures the
    /// attributed string, which answers in whatever font that string carries;
    /// this measures the field, which knows its own. So the two agree only
    /// while `paint` puts the font ON the string, and part company by about a
    /// fifth the moment it stops.
    ///
    /// Without this pair the font is unguarded, and unguarded is not
    /// theoretical here: sized off a font-blind string the label comes out
    /// short, the cell truncates into it, and the INK check then compares that
    /// ink against the same short number and passes. Two measurements from one
    /// source agree whatever is wrong with them; these come from two.
    func titleFieldWidth() -> CGFloat { label.intrinsicContentSize.width }

    /// What the CELL says it needs to draw the title, for `measure.sh`.
    ///
    /// The number `resize` and `layout` size the label from, published so a
    /// check can compare the box against it. Neither `titleFit().needed` nor
    /// `titleFieldWidth()` can stand in: both report the STRING's width, the
    /// cell needs its own insets on top of that to draw the same string. A
    /// box between the two numbers looks correct by every model-side measure
    /// and clips the tail of the name away.
    func titleCellWidth() -> CGFloat { drawnTextWidth() }

    /// The chevron, for `mac/scripts/measure.sh`: whether its image resolved,
    /// where it sits, and how much ink it puts down when shown.
    ///
    /// `NSImage(systemSymbolName:)` returns nil for a name the system does not
    /// have, and an image view holding nil draws nothing and says nothing, so
    /// `hasImage` is the arm that stops the rest of this reporting healthily
    /// about an affordance that is not there. `ink` is measured the way the
    /// title's is, because the same lesson applies: a frame is where a thing
    /// would be drawn if it were drawn.
    ///
    /// Hover cannot be reached from a script (no pointer without an
    /// Accessibility grant), so the state is set here rather than performed.
    /// What that does NOT cover is the tracking area actually firing, which
    /// only a real pointer can show.
    ///
    /// It sets `isHovered` and then READS what `syncHoverChrome` decided. Writing
    /// the alpha here instead, to skip the fade, is a probe that reports its
    /// own argument: a chevron wired to ignore hover entirely passed this
    /// check, because the check was answering itself.
    func chevronForMeasurement(hovered: Bool) -> (hasImage: Bool, frame: NSRect, alpha: CGFloat, ink: CGFloat) {
        setHoverForMeasurement(hovered)
        layoutSubtreeIfNeeded()
        return (chevron.image != nil, chevron.frame, chevron.alphaValue, inkWidth(of: chevron))
    }

    /// Put EVERY source of "awake" where the caller asked and settle the chrome.
    ///
    /// All of them, because any one left alone is free to decide the answer: a
    /// probe asking what happens at rest, with the band still reporting a
    /// pointer on it, would be told the chrome is offered and would have
    /// measured something it did not set. Key state joined the list when the
    /// buttons stopped being hover-only, and a probe that had gone on setting
    /// only the two hover flags would have reported the chrome offered at rest
    /// forever after, which is a green check over the exact state it exists to
    /// look at.
    private func setHoverForMeasurement(_ awake: Bool) {
        isHovered = awake
        isBandHovered = awake
        // Through the real setter, so the ink the key state owns cannot drift
        // from the state a probe put it in. It early-returns when the value has
        // not moved, which is why the settle below is unconditional.
        setWindowKey(awake, animated: false)
        syncHoverChrome(animated: false)
    }

    /// The buttons, for `mac/scripts/measure.sh` and for the app tests. The
    /// view rather than a summary of it, because what a check wants to ask
    /// varies (are the symbols there, where are they, are they offered) and a
    /// tuple per question is how a probe ends up describing itself.
    var actionsView: TitlebarActionsView { actions }

    /// Set the hover state and read back what it decided, the way
    /// `chevronForMeasurement` does and for the same reason: a probe that wrote
    /// the answer would be answering itself.
    func actionsForMeasurement(hovered: Bool) -> (shown: Bool, frames: [NSRect], symbols: Int) {
        setHoverForMeasurement(hovered)
        layoutSubtreeIfNeeded()
        return (actions.shown,
                actions.buttons.map { $0.convert($0.bounds, to: self) },
                actions.buttons.filter { $0.image != nil }.count)
    }

    /// How much of the LABEL survives its ancestors' clipping.
    ///
    /// `visibleRect` is the part of a view not cut away by the boxes it sits
    /// in, so this is the only number here that an ancestor can move. The
    /// others are frames this file sets, and a container that clips them says
    /// nothing to any of them.
    func visibleLabelWidth() -> CGFloat { label.visibleRect.width }

    /// Name `url`, and say whether the buffer has bytes the file does not.
    func show(url: URL, edited: Bool) {
        self.plainTitle = nil
        self.url = url
        self.edited = edited
        paint()
    }

    /// Name the APPLICATION rather than a file, for a panel that is not
    /// showing one.
    ///
    /// The welcome screen has no document behind it, so the titlebar has
    /// nothing to name and nothing to open: no chevron, no popover, no path
    /// popup, and no `Edited`. A title that offered those would offer them
    /// against the file the panel is ABOUT to open, which is a file the person
    /// has not chosen yet and is exactly what that screen is asking about.
    func showAppName(_ name: String) {
        self.plainTitle = name
        self.edited = false
        paint()
    }

    /// Set while the title names something that is not a file. Read by
    /// `paint`, by the gestures, and by `hitTest`, which is what makes the
    /// title inert rather than merely undecorated.
    private var plainTitle: String?

    /// Title ink follows the window's key state, the way every macOS title
    /// does: a background window names itself quietly.
    /// `animated` is false only for the measurement path, and not for looks: an
    /// animated settle defers `isHidden` to a completion handler, and a probe
    /// that never spins the run loop would read the state the fade started from
    /// rather than the one it is asking about.
    func setWindowKey(_ key: Bool, animated: Bool = true) {
        guard key != isKey else { return }
        isKey = key
        // The chevron is part of the title, so it takes the title's rule: a
        // background window names itself quietly, and points at itself
        // quietly too.
        chevron.contentTintColor = key ? .secondaryLabelColor : .tertiaryLabelColor
        actions.setWindowKey(key)
        // Key state is one of the two things that offer the buttons at all, so
        // it settles the chrome as well as inking it. Without this the ink
        // followed the window and the buttons did not, which is the shape of a
        // background window quietly drawing controls it had decided to withdraw.
        syncHoverChrome(animated: animated)
        paint()
    }

    private func paint() {
        if let plainTitle {
            // Through the same shortening a file name gets. A narrow panel
            // cannot fit this either, and skipping it here would clip the app
            // name mid-glyph: the exact defect this file was rewritten for,
            // reintroduced by the one title that took a different route.
            paintRuns(WindowTitle.runs(name: plainTitle, edited: false,
                                       fitting: Double(textCeiling),
                                       measure: Self.width(of:)),
                      toolTip: nil, fullName: plainTitle)
            return
        }
        guard let url else {
            label.attributedStringValue = NSAttributedString(string: "")
            // Forget what was drawn, or re-binding the same file afterwards
            // would match the cache and leave the label blank.
            lastRendered = nil
            return
        }
        // WHAT it says is BirtaWriterCore.WindowTitle's, which is testable
        // without a window.
        //
        // Shortened HERE, against the ceiling, rather than left to the cell. A
        // cell truncating a whole line eats its tail first, so `— Edited`
        // would go before any of the name did; macOS shortens the name and
        // keeps the state, which is why the two are separate runs.
        paintRuns(WindowTitle.runs(name: url.lastPathComponent, edited: edited,
                                   fitting: Double(textCeiling),
                                   measure: Self.width(of:)),
                  toolTip: url.path, fullName: url.lastPathComponent)
    }

    /// Draw `runs`, and nothing if they say what is already on screen.
    ///
    /// The two inks are this layer's, because a colour is only meaningful
    /// against a live appearance. The font goes ON the runs, not only on the
    /// field, and that is what makes `drawnTextWidth` describe the drawing: the
    /// field draws a run in its own font when the run names none, so leaving it
    /// off looks right on screen and reports a width in the default face, which
    /// is narrower. Nothing goes red when it is missing, because the sizing and
    /// the check that guards it both read the same short number and agree.
    private func paintRuns(_ runs: [WindowTitle.Run], toolTip: String?, fullName: String) {
        let ink: [Bool: NSColor] = [
            false: isKey ? .labelColor : .tertiaryLabelColor,
            true: isKey ? .tertiaryLabelColor : .quaternaryLabelColor,
        ]
        let text = NSMutableAttributedString()
        for run in runs {
            text.append(NSAttributedString(
                string: run.text,
                attributes: [.foregroundColor: ink[run.secondary] as Any,
                             .font: Self.titleFont]))
        }
        // Nothing to do when the title already says this, which under autosave
        // is almost every call: `isEdited`'s `didSet` fires on every admitted
        // update and again on every write. Keyed on the RENDERED STRING, the
        // ink, and whether this is a file at all, never on `edited`:
        // `refreshTitle` also runs from `boundURL`'s didSet, so New Note and a
        // document switch change the title without changing that flag.
        let rendered = Rendered(text: text.string, key: isKey, plain: plainTitle != nil)
        guard rendered != lastRendered else { return }
        lastRendered = rendered
        label.attributedStringValue = text
        label.toolTip = toolTip
        syncHoverChrome()
        // The WHOLE name, not the shortened one. Shortening is a fact about
        // how much room the window has, and a screen reader has all the room
        // there is; a sighted reader recovers the rest from the tooltip and
        // the popover, and a reader who is listening would be handed the
        // ellipsis and nothing else. `drawnTitle` is what the checks read, so
        // the two do not have to be the same string.
        setAccessibilityLabel(fullName)
        drawnTitle = text.string
        resize()
    }

    override var intrinsicContentSize: NSSize { frame.size }

    /// The whole control takes the click, never the label inside it.
    ///
    /// An `NSTextField` answers `hitTest` with itself even as a label, so the
    /// mouse events below would go to a field that ignores them and the title
    /// would be inert everywhere the text actually is, which is everywhere
    /// worth clicking. Points outside the text still fall through, so the
    /// titlebar keeps its own drag and double-click behaviour beside us.
    override func hitTest(_ point: NSPoint) -> NSView? {
        // A title naming the application takes no clicks at all, so the band
        // it sits in stays draggable across its whole width. An empty title
        // claims nothing either.
        guard plainTitle == nil, label.frame.width > 0 else { return nil }
        let local = convert(point, from: superview)
        guard bounds.contains(local) else { return nil }
        if let button = actions.button(at: convert(local, to: actions)) { return button }
        // The title's own click area is the NAME and the chevron that points at
        // it, and stops there. The buttons' room is deliberately outside it:
        // while they are not drawn it is a strip of empty titlebar, and a strip
        // of empty titlebar that opened the document popover would be a click
        // target nothing on screen accounts for. Falling through leaves it to
        // the titlebar, which drags the window, which is what that strip looks
        // like it should do.
        return local.x <= chevron.frame.maxX ? self : nil
    }

    // MARK: gestures

    override func mouseDown(with event: NSEvent) {
        guard let url else { return }
        let wantsPath = event.modifierFlags.contains(.command)
            || event.modifierFlags.contains(.control)
        if wantsPath {
            showPathMenu(for: url)
        } else {
            showDocumentPopover(for: url)
        }
    }

    /// Right-click is the other way to the same popup, because a control whose
    /// only menu is on a modifier is a menu most people never find.
    override func rightMouseDown(with event: NSEvent) {
        guard let url else { return }
        showPathMenu(for: url)
    }

    /// The document popover: the file's name, its tags and the folder it is
    /// in, which is what clicking a document window's title opens on macOS.
    ///
    /// Anchored on the LABEL rather than on this view, so the popover's arrow
    /// points at the words rather than at the middle of a box whose width is
    /// whatever the name happens to need.
    private func showDocumentPopover(for url: URL) {
        let controller = popoverController
        controller.show(url: url)
        let popover = NSPopover()
        popover.contentViewController = controller
        popover.behavior = .transient
        popover.delegate = self
        popover.show(relativeTo: label.frame, of: self, preferredEdge: .maxY)
        self.popover = popover
        syncHoverChrome()
    }

    /// The file, then each folder above it up to the volume, top to bottom,
    /// which is the order macOS lists them in. Every row reveals itself in
    /// Finder, including the file's own.
    private func showPathMenu(for url: URL) {
        let menu = NSMenu()
        for target in WindowTitle.ancestry(of: url) {
            let item = menu.addItem(withTitle: WindowTitle.displayName(of: target),
                                    action: #selector(revealMenuItem(_:)),
                                    keyEquivalent: "")
            item.target = self
            item.representedObject = target
            // Icons here and nowhere else in the app's menus: this popup is a
            // picture of the filesystem, and the icons are how the volume and
            // the folders are told apart at a glance.
            let icon = NSWorkspace.shared.icon(forFile: target.path)
            icon.size = NSSize(width: 16, height: 16)
            item.image = icon
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.minY), in: self)
    }

    @objc private func revealMenuItem(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? URL else { return }
        onReveal?(target)
    }
}

/// Hosts `TitleBarView` in the panel's titlebar, after the traffic lights.
///
/// The view is the title itself rather than a container around it. A container
/// would be a second root view with its own autoresized zero frame, which is
/// the trap `TitleBarView.build` documents, one level up and harder to see.
@MainActor
final class TitleBarAccessory: NSTitlebarAccessoryViewController {
    let titleView = TitleBarView()

    init() {
        super.init(nibName: nil, bundle: nil)
        layoutAttribute = .leading
        view = titleView
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// The chevron follows the popover down as well as up. `transient` means the
/// popover closes on a click anywhere else, which is a path this view never
/// hears about otherwise, so the affordance would stay lit over a popover that
/// had gone.
extension TitleBarView: NSPopoverDelegate {
    func popoverDidClose(_ notification: Notification) {
        syncHoverChrome()
    }
}
