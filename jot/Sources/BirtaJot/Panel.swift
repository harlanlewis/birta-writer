import AppKit

/// The scratchpad window. An NSPanel that joins every Space and is available
/// over a fullscreen app, remembers its frame, and hides rather than closes.
///
/// Not `.nonactivatingPanel`: key equivalents (Cmd+S, Cmd+C/V/Z inside the
/// WKWebView) route through the app's main menu, which needs the app active,
/// so a panel that never activated could not run its own chords.
///
/// At the ORDINARY window level, and `level` is assigned rather than left out.
/// An `NSPanel` is `.floating` by default and `isFloatingPanel` is the setter
/// for that level, so the level a panel ends up at is never the absence of a
/// line, and a file that leaves it out is describing a level it does not set.
/// A window that will not go behind anything is a window you fight, and
/// the hotkey brings this one back in a keystroke. `measure.sh` reads the
/// level, because prose asserting one is not a check.
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
        level = .normal
        // Both of these are assignments AppKit would otherwise make for us,
        // and both defaults are the opposite of what this panel wants: an
        // `NSPanel` is `.floating` and hides itself on deactivation unless
        // told not to. The window stays put when you click into another app,
        // and anything can cover it, which is the whole of the behaviour the
        // removed float setting and its replacement were arguing about.
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // The system's own show and hide, not a chosen one.
        animationBehavior = .default
        minSize = NSSize(width: 360, height: 240)
        // Remembered for a person, never for a measurement. The autosave goes
        // to the app's standard defaults rather than through `Prefs`, so it is
        // the one piece of state `BIRTA_JOT_DEFAULTS_SUITE` does not already
        // cover, and a checking run that resizes the panel would otherwise
        // hand the user back a window the width of whatever it finished on.
        if Prefs.isUserStore { setFrameAutosaveName("JotPanel") }
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    /// The close button hides; the buffer is never "closed".
    override func close() {
        onHideRequest?()
    }

    /// First show with no remembered frame: centre on the screen under the mouse.
    func placeIfUnplaced() {
        // Guarded for the reason the autosave above is, and separately:
        // `setFrameUsingName` reads that defaults key whether or not this
        // window ever named itself, so without this a checking run would still
        // open at the user's own size and measure a width nobody chose.
        if Prefs.isUserStore, setFrameUsingName("JotPanel") { return }
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
