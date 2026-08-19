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

    private let label = NSTextField(labelWithString: "")
    private var url: URL?
    private var edited = false
    private var isKey = true

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

    /// Fit the view to its text, within the ceiling, and place the label in it.
    private func resize() {
        let text = min(label.intrinsicContentSize.width, Self.maxTextWidth)
        label.frame = NSRect(x: Self.leadingGap,
                             y: (Self.height - label.intrinsicContentSize.height) / 2,
                             width: text,
                             height: label.intrinsicContentSize.height)
        setFrameSize(NSSize(width: Self.leadingGap + text, height: Self.height))
        invalidateIntrinsicContentSize()
    }

    // MARK: state

    /// What the title reads right now, for `jot/scripts/measure.sh`.
    var currentText: String { label.stringValue }

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
            onReveal?(url)
        }
    }

    /// Right-click is the other way to the same popup, because a control whose
    /// only menu is on a modifier is a menu most people never find.
    override func rightMouseDown(with event: NSEvent) {
        guard let url else { return }
        showPathMenu(for: url)
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
