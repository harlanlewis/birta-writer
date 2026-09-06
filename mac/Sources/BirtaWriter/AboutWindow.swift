import AppKit
import BirtaWriterCore

/// The About window: the app's mark, its name, its version, where it comes
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
    /// it draws Xcode's version and Apple's copyright rather than the app's.
    ///
    /// Read once, here. The window says what the build was when it opened, and
    /// nothing about a build changes while it is running.
    /// `onCheckForUpdates` is what the button under the version does. A
    /// closure rather than a selector up the responder chain, so the window
    /// can be built and pressed in a test with no delegate behind it, and so
    /// the one thing this window can DO is legible at the call that opens it.
    init(info: AboutInfo = .current, onCheckForUpdates: @escaping () -> Void = {}) {
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
        let stack = Self.stack(info, onCheckForUpdates: onCheckForUpdates)
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
    private static func stack(_ info: AboutInfo, onCheckForUpdates: @escaping () -> Void) -> NSStackView {
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

        // Under the version, because that is the number it is about: the
        // question the button asks is whether the line above it is still the
        // newest. Its own button rather than a row of the link column, since
        // the links leave the app and this does not, and one width with them
        // because the eye reads the column as one stack whatever the buttons
        // do. `ActionButton` is what makes it reachable from a test.
        let check = ActionButton(title: "Check for Updates…", action: onCheckForUpdates)
        check.bezelStyle = .rounded
        check.controlSize = .regular
        check.font = .systemFont(ofSize: NSFont.systemFontSize)

        let links = linkColumn()
        // The widest TITLE among every button in the stack, so nothing here
        // can be clipped by a number chosen in advance, taken before any
        // width constraint exists: once one does, a button reports it back
        // as its fitting size and this would be the column measuring itself.
        let buttons = [check] + links.arrangedSubviews.compactMap { $0 as? NSButton }
        let width = max(Metrics.minColumnWidth, buttons.map(\.intrinsicContentSize.width).max() ?? 0)
        for button in buttons {
            // As with the icon: the stack sets this for an arranged subview,
            // and a view carrying both an autoresizing mask and a width has
            // conflicting constraints until it does.
            button.translatesAutoresizingMaskIntoConstraints = false
            button.widthAnchor.constraint(equalToConstant: width).isActive = true
        }

        let stack = NSStackView(views: [iconView, name, version, check, links])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 6
        stack.setCustomSpacing(16, after: iconView)
        stack.setCustomSpacing(18, after: version)
        stack.setCustomSpacing(18, after: check)

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

    /// The links, as buttons stacked under each other. Their one width is
    /// set by the caller, with the button above them, because they are a
    /// group and a ragged stack of three would read as three unrelated
    /// controls.
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

/// A bordered button that owns what it does, the way `LinkButton` owns its
/// URL: a closure rather than a target and selector, so a test can press it
/// and see the call without a responder chain to stand one up in.
final class ActionButton: NSButton {
    private let perform: () -> Void

    init(title: String, action: @escaping () -> Void) {
        perform = action
        super.init(frame: .zero)
        self.title = title
        isBordered = true
        target = self
        self.action = #selector(fire)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func fire() { perform() }
}
