import AppKit
import BirtaJotCore

/// Jot's About window: the app's mark, its name, its version, where it comes
/// from and how to report something about it.
///
/// The shape is the one these windows share, in this order and centred: the
/// icon, the name, the version, then the small print. Where an app has
/// somewhere to send you, that sits between the version and the copyright, as
/// buttons of one width stacked under each other. A row of link text is the one
/// shape none of them uses, and it reads as a web page rather than as a Mac
/// window.
///
/// Built rather than left to `orderFrontStandardAboutPanel`, and the links are
/// the reason. That panel takes them through its credits attribute, where a URL
/// is an attributed-string link inside a text view: not in the key view loop,
/// so it is reachable by mouse alone. `LinkButton` is a real button, which is
/// the same argument the Settings window's documentation links are built on.
///
/// Modeless and closable, like every About window on the system. It is left
/// out of the Window menu, since a window nobody navigates between does not
/// belong in a list for navigating between windows.
@MainActor
final class AboutWindowController: NSWindowController {
    enum Metrics {
        /// The mark, at the size the standard panel draws one.
        static let icon: CGFloat = 128
        /// A floor rather than the width. The column is as wide as the widest
        /// button needs, so a link added or renamed past this widens the window
        /// instead of being clipped by it.
        static let minColumnWidth: CGFloat = 264
        static let horizontalPadding: CGFloat = 24
        static let topPadding: CGFloat = 24
        static let bottomPadding: CGFloat = 24
    }

    /// `info` is injectable so the window can be built and read back against
    /// known content. `AboutInfo.current` reads `Bundle.main`, and under
    /// `swift test` that bundle is the `xctest` tool's, so a window built from
    /// it draws Xcode's version and Apple's copyright rather than Jot's.
    ///
    /// Read once, here. The window says what the build was when it opened, and
    /// nothing about a build changes while it is running.
    init(info: AboutInfo = .current) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Metrics.minColumnWidth, height: Metrics.icon),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        // Set for VoiceOver and never drawn: the titlebar of an About window is
        // an empty band with a close button in it, which is what the standard
        // panel shows and what makes the mark below the first thing read.
        window.title = "About \(info.name)"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        // A window nobody switches between. It is one of the two places a
        // window is kept out of that menu, the other being a panel.
        window.isExcludedFromWindowsMenu = true
        super.init(window: window)

        let content = NSView()
        let stack = Self.stack(info)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: Metrics.topPadding),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -Metrics.bottomPadding),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: Metrics.horizontalPadding),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -Metrics.horizontalPadding),
        ])
        window.contentView = content
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The column, top to bottom.
    private static func stack(_ info: AboutInfo) -> NSStackView {
        let iconView = NSImageView(image: appIcon())
        iconView.imageScaling = .scaleProportionallyUpOrDown
        // Before the size constraints: the stack sets this for an arranged
        // subview, and a view carrying both an autoresizing mask and a width
        // has conflicting constraints until it does.
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: Metrics.icon),
            iconView.heightAnchor.constraint(equalToConstant: Metrics.icon),
        ])

        let name = NSTextField(labelWithString: info.name)
        name.font = .systemFont(ofSize: 16, weight: .semibold)
        name.alignment = .center

        // At the reading size the version lines in these windows are drawn at,
        // and selectable, so it can be copied into a bug report rather than
        // transcribed from the screen.
        let version = NSTextField(labelWithString: info.versionLine)
        version.font = .systemFont(ofSize: NSFont.systemFontSize)
        version.textColor = .secondaryLabelColor
        version.alignment = .center
        version.isSelectable = true

        let links = linkColumn()

        let stack = NSStackView(views: [iconView, name, version, links])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 6
        stack.setCustomSpacing(16, after: iconView)
        stack.setCustomSpacing(22, after: version)

        // Drawn only when there is one. An empty label would reserve its line
        // and leave the window looking as though something failed to load.
        if let copyright = info.copyright {
            let line = NSTextField(labelWithString: copyright)
            line.font = .systemFont(ofSize: 12)
            line.textColor = .secondaryLabelColor
            line.alignment = .center
            stack.addArrangedSubview(line)
            stack.setCustomSpacing(20, after: links)
        }
        return stack
    }

    /// The links, as buttons of one width stacked under each other.
    ///
    /// One width because they are a group and a ragged stack of three would
    /// read as three unrelated controls; that width is the widest title's, so
    /// nothing here can be clipped by a number chosen in advance.
    private static func linkColumn() -> NSStackView {
        let buttons = AboutLink.allCases.map { link -> LinkButton in
            let button = LinkButton(title: link.title, url: link.url)
            // The same button, bezelled. What is worth reusing from
            // `LinkButton` is the half that matters here: a button that OWNS
            // its destination rather than looking one up by its own address.
            // Every line below undoes something it sets to be a caption beside
            // a settings field, the link tint and the small size among them.
            button.isBordered = true
            button.bezelStyle = .rounded
            button.controlSize = .regular
            button.contentTintColor = nil
            button.font = .systemFont(ofSize: NSFont.systemFontSize)
            return button
        }
        // The widest TITLE, taken before any width constraint exists: once one
        // does, a button reports it back as its fitting size and this would be
        // the column measuring itself.
        let width = max(Metrics.minColumnWidth, buttons.map(\.intrinsicContentSize.width).max() ?? 0)
        for button in buttons {
            // As with the icon: the stack sets this for an arranged subview,
            // and a view carrying both an autoresizing mask and a width has
            // conflicting constraints until it does.
            button.translatesAutoresizingMaskIntoConstraints = false
            button.widthAnchor.constraint(equalToConstant: width).isActive = true
        }

        let column = NSStackView(views: buttons.map { $0 as NSView })
        column.orientation = .vertical
        column.alignment = .centerX
        column.spacing = 10
        return column
    }

    /// The app's own icon, with the treatment macOS composites onto it.
    ///
    /// `NSApp.applicationIconImage` rather than the artwork beside it, which is
    /// the opposite of the choice the first-run screen makes, and for the
    /// opposite reason: that screen sits the mark on its own paper, where a
    /// border and a drop shadow are chrome around a join that should be
    /// invisible. Here the mark sits on the window's ground exactly as it sits
    /// in the Dock and in the standard About panel, which is where its shadow
    /// belongs.
    ///
    /// The named fallback is for a process with no bundle, every test host
    /// among them, and is the generic application icon rather than nothing.
    private static func appIcon() -> NSImage {
        NSApp.applicationIconImage
            ?? NSImage(named: NSImage.applicationIconName)
            ?? NSImage(size: NSSize(width: Metrics.icon, height: Metrics.icon))
    }
}
