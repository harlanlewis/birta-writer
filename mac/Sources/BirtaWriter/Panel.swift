import AppKit
import BirtaWriterCore

/// The scratchpad window. An NSPanel that behaves like any other window on the
/// machine, remembers its frame, and hides rather than closes.
///
/// Not `.nonactivatingPanel`: key equivalents (Cmd+S, Cmd+C/V/Z inside the
/// WKWebView) route through the app's main menu, which needs the app active,
/// so a panel that never activated could not run its own chords.
///
/// Like any other window is the whole of the window policy, and it is three
/// assignments:
///
///   `level`               `.normal`, so anything can cover this window. One
///                         that will not go behind anything is one you fight,
///                         and the hotkey brings this one back in a keystroke.
///   `hidesOnDeactivate`   false, so the window stays put when you click into
///                         another app rather than vanishing on the click.
///                         This is the one that overrides an `NSPanel`
///                         default; the other two state what a plain window
///                         would do anyway.
///   `collectionBehavior`  which Space the window is on and whether it can
///                         take a full screen of its own.
///                         `BirtaWriterCore.WindowPolicy` decides that from the
///                         Dock setting and says why; `collectionBehavior(for:)`
///                         below is the mapping, re-applied when the setting
///                         moves.
///
/// The level is written down even though it is what an unassigned window would
/// have, and that is worth a line rather than a deletion: `isFloatingPanel`
/// raises a panel's level without the word `level` appearing, so a file that
/// leaves the level out is not a file whose level can be read by eye. This
/// panel shipped once at `.floating`, pinned above every other application,
/// with three comments and a changelog entry saying it was not.
///
/// `measure.sh` reads the level and the collection behaviour back off the live
/// window, and `PanelWindowPolicyTests` off a built one, because prose
/// asserting a window policy is not a check.
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
        // The window policy, all three lines of it. The header says what each
        // one buys and why none of them can be left to the panel's default.
        level = .normal
        hidesOnDeactivate = false
        applyWindowPolicy()
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false
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

    // MARK: window policy

    /// Take the Spaces membership the Dock setting currently implies.
    ///
    /// Called from `init` and again whenever that setting moves
    /// (`AppDelegate.applyActivationPolicy`), which is the only thing that can
    /// change the answer. Assigning the whole behaviour rather than inserting
    /// or removing one flag: a set built from the policy every time cannot
    /// accumulate a flag an earlier answer wanted, which is the failure a
    /// pair of `insert`/`remove` calls has and does not report.
    func applyWindowPolicy() {
        collectionBehavior = Self.collectionBehavior(
            for: WindowPolicy.membership(showInDock: Prefs.showInDock))
    }

    /// `WindowPolicy`'s answer in AppKit's vocabulary.
    ///
    /// `.fullScreenPrimary` in both, so the green button offers Enter Full
    /// Screen and the window takes a Space of its own. Its opposite number,
    /// `.fullScreenAuxiliary`, is what drew this window over another
    /// application's full screen and is in neither answer; nor is
    /// `.canJoinAllSpaces`, which drew it on every Space at once.
    /// `.moveToActiveSpace` is the near neighbour of that second one and is
    /// not the same thing: the window is in ONE place at a time and merely
    /// moves to where the reader is when the app is activated.
    static func collectionBehavior(
        for membership: WindowPolicy.SpaceMembership
    ) -> NSWindow.CollectionBehavior {
        switch membership {
        case .ownSpace: return [.fullScreenPrimary]
        case .followsReader: return [.moveToActiveSpace, .fullScreenPrimary]
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
