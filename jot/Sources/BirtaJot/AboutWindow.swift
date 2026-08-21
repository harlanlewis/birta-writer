import AppKit
import BirtaJotCore

/// Jot's About window: the app's mark, its name, its version, where it comes
/// from and how to report something about it.
///
/// Built rather than left to `orderFrontStandardAboutPanel`, and the reason is
/// the links. The standard panel takes text through its credits attribute,
/// where a URL is an attributed-string link inside a text view: not in the key
/// view loop, so it is reachable by mouse alone. `LinkButton` is a real button,
/// which is the same argument the Settings window's documentation links are
/// built on. Everything else here follows the panel's own shape, because that
/// shape is what people recognise: mark, name, version, then the small print.
///
/// Modeless and closable, like every About window on the system. It is left
/// out of the Window menu, since a window nobody navigates between does not
/// belong in a list for navigating between windows.
@MainActor
final class AboutWindowController: NSWindowController {
    enum Metrics {
        /// The mark, at the size the standard panel draws one.
        static let icon: CGFloat = 128
        /// A floor rather than the width: the window is as wide as its widest
        /// row needs, and the row of links is that row. A fixed width would
        /// clip a link the day one is added or renamed.
        static let minWidth: CGFloat = 320
        static let horizontalPadding: CGFloat = 24
        static let topPadding: CGFloat = 16
        static let bottomPadding: CGFloat = 22
    }

    /// `info` is injectable so the window can be built and read back without a
    /// bundle: a test host has no version and no copyright of its own, and a
    /// window that draws neither cannot be checked for drawing both.
    ///
    /// Read once, here. The window says what the build was when it opened, and
    /// nothing about a build changes while it is running.
    init(info: AboutInfo = .current) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: Metrics.minWidth, height: Metrics.icon),
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
            content.widthAnchor.constraint(greaterThanOrEqualToConstant: Metrics.minWidth),
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
        name.font = .systemFont(ofSize: 18, weight: .semibold)
        name.alignment = .center

        // Selectable, so the version can be copied into a bug report rather
        // than transcribed from the screen.
        let version = NSTextField(labelWithString: info.versionLine)
        version.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        version.textColor = .secondaryLabelColor
        version.alignment = .center
        version.isSelectable = true

        let buttons: [NSView] = AboutLink.allCases.map { LinkButton(title: $0.title, url: $0.url) }
        let links = NSStackView(views: buttons)
        links.orientation = .horizontal
        links.spacing = 14

        let stack = NSStackView(views: [iconView, name, version, links])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 6
        stack.setCustomSpacing(14, after: iconView)
        stack.setCustomSpacing(16, after: version)

        // Drawn only when there is one. An empty label would reserve its line
        // and leave the window looking as though something failed to load.
        if let copyright = info.copyright {
            let line = NSTextField(labelWithString: copyright)
            line.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            line.textColor = .tertiaryLabelColor
            line.alignment = .center
            stack.addArrangedSubview(line)
            stack.setCustomSpacing(14, after: links)
        }
        return stack
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
