import AppKit
import BirtaJotCore

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
        return controller
    }()
    private var popover: NSPopover?

    private let label = NSTextField(labelWithString: "")
    private var url: URL?
    private var edited = false
    private var isKey = true

    /// What the label was last painted with, so an identical repaint is not
    /// one. Both fields, because both change what is on screen.
    private struct Rendered: Equatable {
        let text: String
        let key: Bool
    }
    private var lastRendered: Rendered?

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 0, height: TitleBarView.height))
        build()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Air between the traffic lights and the title. NOT an inset past the
    /// buttons: AppKit places a `.leading` accessory after them already.
    private static let leadingGap: CGFloat = 8
    /// A ceiling on the name, so a long one cannot push the title across the
    /// window into the page's own toolbar. The label truncates instead.
    private static let maxTextWidth: CGFloat = 320
    /// The height this view is BUILT at, and nothing else.
    ///
    /// AppKit stretches a titlebar accessory to the titlebar's own height, so
    /// this number is stale from the moment the accessory is attached: the
    /// view is made 28 tall and handed 32. Centering the label against it put
    /// the title (32 - 28) / 2 = 2pt below where macOS draws its own, which is
    /// what `layout()` below exists to stop. Anything that needs the height
    /// the view actually HAS reads `bounds`.
    static let height: CGFloat = 28

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
        // `titleBarFont` is the face macOS titles itself with, asked for by
        // name rather than reproduced as a size and a weight, so it follows the
        // system rather than a guess about it.
        label.font = NSFont.titleBarFont(ofSize: NSFont.systemFontSize)
        label.lineBreakMode = .byTruncatingTail
        label.setAccessibilityRole(.staticText)
        addSubview(label)
        resize()
    }

    /// Fit the view to its text, within the ceiling. The label's own placement
    /// inside it is `layout()`'s, which runs again after AppKit has resized us.
    private func resize() {
        let text = min(label.intrinsicContentSize.width, Self.maxTextWidth)
        setFrameSize(NSSize(width: Self.leadingGap + text, height: bounds.height))
        invalidateIntrinsicContentSize()
        needsLayout = true
    }

    /// Centre the label on the height this view HAS, not the one it was built
    /// with. The whole of the alignment fix, and it has to be here rather than
    /// in `resize()` because AppKit stretches the accessory after we size it,
    /// so the only moment the real height is known is a layout pass.
    ///
    /// What "aligned" means, measured rather than eyeballed: macOS puts a
    /// window title's vertical centre exactly on the close button's, and it
    /// does so at every titlebar height and title font the system uses
    /// (unified, unifiedCompact and expanded all agree to 0.0pt). Centering on
    /// `bounds` reproduces that, because AppKit gives the accessory the whole
    /// band. `jot/scripts/measure.sh` asserts the delta against the live
    /// window rather than trusting this comment.
    override func layout() {
        super.layout()
        let size = label.intrinsicContentSize
        label.frame = NSRect(x: Self.leadingGap,
                             y: ((bounds.height - size.height) / 2).rounded(),
                             width: min(size.width, Self.maxTextWidth),
                             height: size.height)
    }

    // MARK: state

    /// What the title reads right now, for `jot/scripts/measure.sh`.
    var currentText: String { label.stringValue }

    /// Where the TEXT sits, in window coordinates, for the same script. The
    /// accessory's own frame is the whole titlebar band, so it answers whether
    /// the accessory arrived and nothing about where the title is drawn in it.
    func labelFrameInWindow() -> NSRect { label.convert(label.bounds, to: nil) }

    /// Name `url`, and say whether the buffer has bytes the file does not.
    func show(url: URL, edited: Bool) {
        self.url = url
        self.edited = edited
        paint()
    }

    /// Title ink follows the window's key state, the way every macOS title
    /// does: a background window names itself quietly.
    func setWindowKey(_ key: Bool) {
        guard key != isKey else { return }
        isKey = key
        paint()
    }

    private func paint() {
        guard let url else {
            label.attributedStringValue = NSAttributedString(string: "")
            // Forget what was drawn, or re-binding the same file afterwards
            // would match the cache and leave the label blank.
            lastRendered = nil
            return
        }
        // WHAT it says is BirtaJotCore.WindowTitle's, which is testable
        // without a window; the two inks are this layer's, because a colour is
        // only meaningful against a live appearance.
        let ink: [Bool: NSColor] = [
            false: isKey ? .labelColor : .tertiaryLabelColor,
            true: isKey ? .tertiaryLabelColor : .quaternaryLabelColor,
        ]
        let text = NSMutableAttributedString()
        for run in WindowTitle.runs(name: url.lastPathComponent, edited: edited) {
            text.append(NSAttributedString(
                string: run.text,
                attributes: [.foregroundColor: ink[run.secondary] as Any]))
        }
        // Nothing to do when the title already says this, which under autosave
        // is almost every call: `isEdited`'s `didSet` fires on every admitted
        // update and again on every write. Keyed on the RENDERED STRING and
        // the ink, never on `edited`: `refreshTitle` also runs from
        // `boundURL`'s didSet, so New Note and a document switch change the
        // title without changing that flag.
        let rendered = Rendered(text: text.string, key: isKey)
        guard rendered != lastRendered else { return }
        lastRendered = rendered
        label.attributedStringValue = text
        label.toolTip = url.path
        setAccessibilityLabel(text.string)
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
        let local = convert(point, from: superview)
        return bounds.contains(local) && label.frame.width > 0 ? self : nil
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
        popover.show(relativeTo: label.frame, of: self, preferredEdge: .maxY)
        self.popover = popover
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
            // Icons here and nowhere else in Jot's menus: this popup is a
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
