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
        // All three window buttons, and the style mask each one needs: a panel
        // showing a lone close button reads as a window with something missing.
        super.init(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
                   styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "Birta Jot"
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isFloatingPanel = true
        applyFloatLevel()
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // The system's own show and hide, not a chosen one.
        animationBehavior = .default
        minSize = NSSize(width: 360, height: 240)
        setFrameAutosaveName("JotPanel")
    }

    /// Put the panel at the level the "Float above other windows" setting
    /// names. `.floating` is one step above `.normal`, which is enough to sit
    /// over other applications and low enough that a system alert still wins.
    ///
    /// Anything Jot opens ON TOP of the panel has to be raised to match, or it
    /// opens behind the window that spawned it and reads as not having opened
    /// at all. `SettingsWindowController` is the one that does.
    func applyFloatLevel() {
        level = Prefs.floatAboveOtherWindows ? .floating : .normal
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

/// The panel's content view: hosts the web view, forwards appearance changes so
/// the page's theme class follows the system, and reports whether the pointer is
/// over the window, which is what the chrome is shown by.
///
/// A tracking area rather than mouse-moved events: it is matched against the
/// rect, so the WKWebView filling this view does not have to forward anything,
/// and it keeps reporting while the app is inactive.
@MainActor
final class AppearanceObservingView: NSView {
    var onAppearanceChange: (() -> Void)?
    var onHoverChange: ((Bool) -> Void)?
    private(set) var isHovering = false
    private var tracking: NSTrackingArea?

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearanceChange?()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { setHovering(true) }
    override func mouseExited(with event: NSEvent) { setHovering(false) }

    /// The pointer can be inside the window without an enter event having
    /// fired: the panel is summoned under a cursor that never moved.
    func syncHoverFromPointer() {
        guard let window else { return setHovering(false) }
        let inWindow = window.convertPoint(fromScreen: NSEvent.mouseLocation)
        setHovering(bounds.contains(convert(inWindow, from: nil)))
    }

    private func setHovering(_ hovering: Bool) {
        guard hovering != isHovering else { return }
        isHovering = hovering
        onHoverChange?(hovering)
    }
}
