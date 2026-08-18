import AppKit

/// The floating scratchpad window. An NSPanel that joins every Space and sits
/// over fullscreen apps, remembers its frame, and hides rather than closes.
///
/// Not `.nonactivatingPanel`: key equivalents (Cmd+S, Cmd+C/V/Z inside the
/// WKWebView) route through the app's main menu, which needs the app active,
/// and losing focus must not hide the panel anyway, so there is nothing to
/// gain from staying inactive.
@MainActor
final class JotPanel: NSPanel {
    var onHideRequest: (() -> Void)?

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
                   styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "Birta Jot"
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        animationBehavior = .utilityWindow
        minSize = NSSize(width: 360, height: 240)
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        setFrameAutosaveName("JotPanel")
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    /// The close button hides; the buffer is never "closed".
    override func close() {
        onHideRequest?()
    }

    /// First show with no remembered frame: centre on the screen under the mouse.
    func placeIfUnplaced() {
        if setFrameUsingName("JotPanel") { return }
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let size = frame.size
        let origin = NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2 + visible.height * 0.1)
        setFrameOrigin(origin)
    }
}

/// The panel's content view: hosts the web view and forwards appearance
/// changes so the page's theme class follows the system.
@MainActor
final class AppearanceObservingView: NSView {
    var onAppearanceChange: (() -> Void)?

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearanceChange?()
    }
}
