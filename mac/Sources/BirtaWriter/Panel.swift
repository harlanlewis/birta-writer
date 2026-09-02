import AppKit
import BirtaWriterCore

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
final class AppPanel: NSPanel {
    var onHideRequest: (() -> Void)?

    /// Whether this window is the one that remembers its size and position
    /// between launches.
    ///
    /// Exactly one is, and it has to be: AppKit's frame autosave is a name to
    /// frame map, so a second window sharing the name would overwrite the same
    /// entry on every move and they would all restore on top of each other.
    /// `setFrameAutosaveName` says so itself, by returning false for a name
    /// already in use in this process, which is a return value worth reading
    /// rather than discarding: the quiet version of this failure is windows
    /// two and after silently keeping no frame at all.
    ///
    /// The first window keeps the historic name, so somebody who has been
    /// dragging this panel to where they like it for months finds it there.
    /// The rest cascade off whichever window spawned them.
    private let remembersFrame: Bool

    /// Whether this window has been given a position yet.
    ///
    /// `placeIfUnplaced` runs from every `show`, and a summon now shows every
    /// window at once, so without this a window that had been dragged
    /// somewhere would be re-centred under the pointer on the next summon.
    private var placed = false

    init(remembersFrame: Bool) {
        self.remembersFrame = remembersFrame
        // All three window buttons, and the style mask each one needs: a panel
        // showing a lone close button reads as a window with something missing.
        // A placeholder rather than the opening size. What the window opens at
        // is decided against the screen it opens ON (`placeIfUnplaced`), and
        // no screen is known here: `NSScreen.main` before the window exists is
        // the screen with the keyboard focus, which is not where this window
        // is about to be centred. `PanelSize.preferred` is the size it wants,
        // so a window that somehow never reaches placement is at least the
        // right shape rather than the historic 640 by 480.
        super.init(contentRect: NSRect(origin: .zero, size: PanelSize.preferred),
                   styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = AppFlavor.current.displayName
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
        minSize = PanelSize.minimum
        // Remembered for a person, never for a measurement. The autosave goes
        // to the app's standard defaults rather than through `Prefs`, so it is
        // the one piece of state `BIRTA_MAC_DEFAULTS_SUITE` does not already
        // cover, and a checking run that resizes the panel would otherwise
        // hand the user back a window the width of whatever it finished on.
        if remembersFrame, Prefs.isUserStore, !setFrameAutosaveName("AppPanel") {
            NSLog("Birta Writer: the panel frame autosave name was refused, so this window will not remember its size")
        }
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    /// A close is a REQUEST while anybody is listening for one, and a real
    /// close when nobody is.
    ///
    /// The close button and Cmd+W both arrive here, and what they mean is the
    /// app's to decide: with several windows open this one closes, and with one
    /// it hides, so the editor stays mounted and the next summon is immediate.
    ///
    /// The fall-through matters as much as the request, and did not exist while
    /// nothing could close a window. Without it there is no way to close this
    /// window at all, in any code path: `orderOut` takes it off the screen and
    /// leaves it in `NSApp.windows`, which is the list AppKit builds the Window
    /// menu from, so a note you closed would go on being listed there. Clearing
    /// `onHideRequest` is what a teardown does to say it means this one.
    override func close() {
        guard let onHideRequest else {
            super.close()
            return
        }
        onHideRequest()
    }

    /// Put this window one step down and right of `point`, at the size of the
    /// window it was spawned from, and answer where the NEXT one goes.
    ///
    /// The step is AppKit's rather than a number chosen here, which is what
    /// `cascadeTopLeft(from:)` is for. Seeding it is the part worth reading:
    /// asking the SPAWN window to cascade from `NSZeroPoint` does not move it,
    /// because a zero point means "tell me where the next one goes", so the
    /// seed is obtained without disturbing the window it came from.
    func cascade(after other: AppPanel, from point: NSPoint?) -> NSPoint {
        setContentSize(other.contentRect(forFrameRect: other.frame).size)
        placed = true
        return cascadeTopLeft(from: point ?? other.cascadeTopLeft(from: .zero))
    }

    /// First show with no remembered frame: size for the screen under the
    /// mouse, then centre on it.
    ///
    /// SIZE and then place, in that order, because the placement is a centring
    /// and a centring needs the final size. Sizing here rather than at
    /// construction is what lets the size answer to the screen at all: no
    /// window has a screen before it has a frame, so a size chosen in `init`
    /// can only ever be a constant.
    func placeIfUnplaced() {
        guard !placed else { return }
        placed = true
        // Guarded for the reason the autosave above is, and separately:
        // `setFrameUsingName` reads that defaults key whether or not this
        // window ever named itself, so without this a checking run would still
        // open at the user's own size and measure a width nobody chose.
        if remembersFrame, Prefs.isUserStore, setFrameUsingName("AppPanel") { return }
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        setContentSize(PanelSize.forScreen(visible: visible.size))
        // The FRAME's size, not the content's: the title bar is part of what
        // has to stay on the screen, and it is the part that goes off the top.
        setFrameOrigin(PanelSize.origin(for: frame.size, visible: visible))
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
