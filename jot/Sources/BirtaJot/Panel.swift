import AppKit

/// The scratchpad window. An NSPanel that joins every Space and sits over
/// fullscreen apps, remembers its frame, and hides rather than closes.
///
/// Not `.nonactivatingPanel`: key equivalents (Cmd+S, Cmd+C/V/Z inside the
/// WKWebView) route through the app's main menu, which needs the app active,
/// so a panel that never activated could not run its own chords.
///
/// At the ORDINARY window level, always. The panel used to take `.floating`
/// under a setting, and both the setting and the level are gone: a window that
/// will not go behind anything is a window you fight, the hotkey already brings
/// it back in one keystroke, and every other window Jot opened had to be raised
/// to match or it opened behind the one that spawned it. What the setting was
/// reaching for is `hideWhenInactive`, which answers it the other way round by
/// taking the panel away instead of pinning it up.
@MainActor
final class JotPanel: NSPanel {
    var onHideRequest: (() -> Void)?

    init() {
        // All three window buttons, and the style mask each one needs: a panel
        // showing a lone close button reads as a window with something missing.
        super.init(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
                   styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "Birta Writer Jot"
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isFloatingPanel = true
        applyHideWhenInactive()
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // The system's own show and hide, not a chosen one.
        animationBehavior = .default
        minSize = NSSize(width: 360, height: 240)
        setFrameAutosaveName("JotPanel")
    }

    /// Put the panel where the "Hide when Jot is not in front" setting says.
    ///
    /// `hidesOnDeactivate` is AppKit's own overlay behaviour, so the hiding,
    /// the animation and the ordering are the system's rather than a
    /// notification handler racing them. Called at init and again whenever
    /// either half of the pairing moves, since a Dock icon appearing has to
    /// take the behaviour away (`Prefs.hidesWhenInactiveInForce`).
    ///
    /// Deliberately not `isFloatingPanel = false` when it is off: floating
    /// panel status is about how the window behaves in its own app, and the
    /// window LEVEL, which is the thing users noticed, is `.normal` in every
    /// case now.
    func applyHideWhenInactive() {
        hidesOnDeactivate = Prefs.hidesWhenInactiveInForce
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
    /// Every layout pass, which is where anything sized from this view's own
    /// bounds has to be refitted. The titlebar drag strip is the one such
    /// thing, and a resize is exactly when it would otherwise go stale.
    var onLayout: (() -> Void)?
    private(set) var isHovering = false
    private var tracking: NSTrackingArea?

    override func layout() {
        super.layout()
        onLayout?()
    }

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
