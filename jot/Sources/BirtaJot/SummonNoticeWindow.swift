import AppKit
import BirtaJotCore

/// The notice that hangs off the menu bar item when macOS will not give
/// Birta Writer its summon hotkey.
///
///     ┌──────────────────────────────────────┐
///     │  ⌃⌥⌘J is taken by another app        │
///     │  A global shortcut goes to whichever │
///     │  app asks for it first, so pressing  │
///     │  it will not open Birta Writer. …    │
///     │  ┌────────────────────────────────┐  │
///     │  │  ⌃  ⌥  ⇧  ⌘   J             ⊗  │  │
///     │  └────────────────────────────────┘  │
///     └──────────────────────────────────────┘
///
/// Anchored to the status item rather than raised as an alert, and the anchor
/// is half the message. An alert would say the menu bar icon still works; a
/// card hanging off that icon shows the reader where it is, in the one moment
/// they are looking for a way in. It also cannot appear over another app's
/// window, which an app-modal alert from a menu-bar app can.
///
/// The recorder is here rather than a button that opens Settings. The refusal
/// is the one moment this app has a real question to ask about the hotkey, so
/// it asks it where the news was delivered instead of sending somebody to a
/// window to find the same control.
///
/// `SummonNotice` owns every sentence; this owns the drawing and the one
/// exchange with macOS.
@MainActor
final class SummonNoticeView: NSViewController {
    /// Register `combo` and report what macOS said. `noErr` means it took.
    private let rebind: (HotkeyCombo) -> OSStatus
    private let appName: String

    let titleLabel = NSTextField(labelWithString: "")
    let detailLabel: Caption
    let recorder: HotkeyRecorderView

    /// What the notice currently says. Read back by the tests, which is the
    /// only way to check a sentence that lives in two states.
    private(set) var notice: SummonNotice

    /// Wide enough for the recorder plus its padding, and no wider: the card
    /// is read at a glance and a long measure defeats that.
    private static let width: CGFloat = 300
    private static let pad: CGFloat = 14

    init(refused combo: HotkeyCombo,
         appName: String = AppFlavor.current.displayName,
         rebind: @escaping (HotkeyCombo) -> OSStatus) {
        self.rebind = rebind
        self.appName = appName
        self.notice = .refused(combo, appName: appName)
        self.detailLabel = Caption("", wrapAt: Self.width - Self.pad * 2)
        self.recorder = HotkeyRecorderView(combo: combo)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        titleLabel.font = .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail

        let stack = NSStackView(views: [titleLabel, detailLabel, recorder])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: Self.width),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: Self.pad),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -Self.pad),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: Self.pad),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -Self.pad),
        ])
        view = root

        recorder.onCombo = { [weak self] combo in self?.chose(combo) }
        render()
    }

    private func render() {
        titleLabel.stringValue = notice.title
        detailLabel.say(notice.detail, bad: false)
    }

    /// A combination was pressed in the recorder: ask macOS for it and say
    /// what came back.
    ///
    /// Both answers are reported here rather than by closing on success,
    /// because a hotkey that does nothing and one that works look identical
    /// until somebody presses it, which is the complaint this whole notice
    /// exists to answer. A second refusal names the SECOND combination, so
    /// pressing three taken chords in a row reads as three answers rather than
    /// as one screen that will not change.
    private func chose(_ combo: HotkeyCombo) {
        let status = rebind(combo)
        notice = status == noErr
            ? .accepted(combo, appName: appName)
            : .refused(combo, appName: appName)
        render()
    }

    /// The recorder's own gesture, for a check over what the notice says once
    /// macOS has answered. Nothing else reaches this path: a real refusal
    /// needs another app to be holding the combination.
    func chooseForTesting(_ combo: HotkeyCombo) { chose(combo) }
}

/// The window the notice is drawn in, and the one thing about it that is not a
/// detail: it draws while the app is in the background.
///
/// This started as an `NSPopover`, which is what a notice hanging off a status
/// item is normally made of, and an `NSPopover` cannot do the one job. Asked to
/// show while the app is inactive it does nothing at all: no throw, no warning,
/// and `isShown` false afterwards, which is the same silent no-op this ticket
/// is about, one layer down. A refusal is found out about inside
/// `applicationDidFinishLaunching`, and an `LSUIElement` app is not active
/// then even when a person launched it by hand, so the notice was asked for at
/// every launch and drawn at none.
///
/// Activating instead would have worked and is the wrong trade. This fires at
/// every launch for as long as the conflict lasts, login included, and an app
/// with no window that takes the front from whatever somebody is doing has
/// answered a small problem with a larger one. A `.nonactivatingPanel` ordered
/// front regardless is the shape that owes nobody an activation: it appears
/// beside the menu bar item at the moment of the failure, and it takes the
/// keyboard only once somebody clicks into it.
@MainActor
final class SummonNoticeWindow: NSPanel {
    /// Borderless windows refuse the keyboard by default, and the recorder in
    /// this one is a control whose entire job is to be typed into.
    override var canBecomeKey: Bool { true }
}

/// Putting the notice beside the menu bar item, and taking it away again.
///
/// Under the item rather than anywhere else, because the anchor is half the
/// message: the notice says that clicking that icon opens the app, and
/// pointing at the icon while saying so is what makes the sentence usable.
///
/// One at a time: a second refusal replaces the first, since there is only one
/// hotkey to be refused.
///
/// ## Waiting for the item to exist where it says it does
///
/// The refusal is known during launch, and a status item is not in the menu bar
/// yet at that point: its window is still the empty rectangle at the origin, so
/// converting the button's bounds to the screen answers the bottom left corner
/// of the display. Placing against that put the card off the bottom of the
/// screen, visible and unreachable, which is a worse failure than the one it
/// was drawn to report. So the anchor is checked before it is trusted and the
/// placement waits for it, briefly, then gives up and hangs the card in the
/// menu bar's own corner. Nothing here polls forever: an anchor that never
/// arrives means a menu bar that never drew the item, and then the corner is
/// the honest guess.
@MainActor
final class SummonNoticePresenter: NSObject {
    /// The one that is up, if any. Internal so a check can read the window
    /// back: whether the notice is on screen with the app in the background is
    /// the whole claim this type makes, and nothing else can answer it.
    private(set) static var current: SummonNoticePresenter?

    /// The window the notice is in, for that check.
    var noticeWindow: NSWindow { panel }

    /// Take down whatever is up, so a check leaves no window behind.
    static func dismissForTesting() { current?.close() }

    /// The gap under the menu bar, the margin kept from the screen edge, and
    /// the card's corner. All three are what a system menu leaves.
    private static let gap: CGFloat = 4
    private static let screenMargin: CGFloat = 8
    private static let radius: CGFloat = 10

    /// How long to wait for the status item to take its place: this many
    /// attempts, this far apart. Real time rather than turns of the run loop,
    /// because during launch a queue of turns drains long before the menu bar
    /// has drawn anything and the wait would expire without having waited.
    private static let anchorAttempts = 30
    private static let anchorRetry: TimeInterval = 0.03

    private let panel = SummonNoticeWindow(contentRect: .zero,
                                           styleMask: [.borderless, .nonactivatingPanel],
                                           backing: .buffered, defer: false)
    private var content: SummonNoticeView?
    private var outsideClick: [Any] = []

    /// Show the notice under `anchor`, replacing one already up.
    @discardableResult
    static func show(refused combo: HotkeyCombo,
                     from anchor: NSStatusBarButton,
                     rebind: @escaping (HotkeyCombo) -> OSStatus) -> SummonNoticeView {
        current?.close()
        let presenter = SummonNoticePresenter()
        let view = SummonNoticeView(refused: combo, rebind: rebind)
        current = presenter
        presenter.present(view, from: anchor)
        return view
    }

    override private init() {
        super.init()
        panel.level = .popUpMenu
        panel.isFloatingPanel = true
        // Neither of these is AppKit's default for a panel, and both defaults
        // would take the notice away at the worst moment: it is shown to an app
        // that is NOT in front, so a window that hides on deactivation is a
        // window nobody ever sees.
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false
        // The card is drawn by the effect view inside; the window itself is a
        // clear rectangle, or its square corners show through the rounding.
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // A menu bar item is on every Space, and so is the news about it.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    }

    private func present(_ view: SummonNoticeView, from anchor: NSStatusBarButton) {
        content = view

        // `.popover` is the material a system popover uses, so the card matches
        // the menus and popovers reachable from the same bar rather than being
        // a grey box of our own invention.
        let card = NSVisualEffectView()
        card.material = .popover
        card.blendingMode = .behindWindow
        card.state = .active
        card.wantsLayer = true
        card.layer?.cornerRadius = Self.radius
        card.layer?.masksToBounds = true

        let body = view.view
        body.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(body)
        NSLayoutConstraint.activate([
            body.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            body.topAnchor.constraint(equalTo: card.topAnchor),
            body.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])
        panel.contentView = card
        // Laid out and sized BEFORE anything is placed. The window is built at
        // the zero rectangle, and a card positioned at no size lands by its
        // corner and then grows out of where it was put.
        //
        // No test can hold these two lines, and they are not decoration. A
        // check reads the window back after AppKit has done a layout pass of
        // its own, by which time the frame is right however it got there, so
        // removing them leaves the suite green. What they are for is the frame
        // `place` reads one statement later, which a running app answers with
        // zeroes without them.
        card.layoutSubtreeIfNeeded()
        panel.setContentSize(card.fittingSize)
        reveal(under: anchor, attemptsLeft: Self.anchorAttempts)
    }

    /// Place and show, once the item is somewhere worth pointing at.
    private func reveal(under anchor: NSStatusBarButton, attemptsLeft: Int) {
        if let rect = Self.anchorRect(anchor) {
            place(below: rect, on: anchor.window?.screen)
        } else if attemptsLeft > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.anchorRetry) { [weak self, weak anchor] in
                guard let self, let anchor else { return }
                self.reveal(under: anchor, attemptsLeft: attemptsLeft - 1)
            }
            return
        } else {
            place(below: Self.menuBarCorner(), on: NSScreen.main)
        }
        // `orderFrontRegardless`, not `makeKeyAndOrderFront`: the app is not in
        // front and must not be put there. The keyboard arrives when somebody
        // clicks into the recorder, which is the only control here.
        panel.orderFrontRegardless()
        watchForOutsideClick()
    }

    /// Where the button really is on screen, or nil while it is still nowhere.
    ///
    /// The test is that the rectangle is IN A MENU BAR, and it has to be that
    /// rather than anything about the window being present. A status item that
    /// has not been laid out still answers: it reports a window at the origin,
    /// sometimes with no height and sometimes with one, and every coordinate
    /// derived from it converts cleanly into the bottom left corner of the
    /// display. A status item lives in the menu bar by definition, so a rectangle
    /// anywhere else is a report from before the item existed, whatever shape it
    /// arrives in.
    private static func anchorRect(_ anchor: NSStatusBarButton) -> NSRect? {
        guard let window = anchor.window else { return nil }
        let rect = window.convertToScreen(anchor.convert(anchor.bounds, to: nil))
        guard let screen = window.screen ?? NSScreen.main,
              rect.maxY >= screen.visibleFrame.maxY else { return nil }
        return rect
    }

    /// The trailing end of the menu bar on the main screen: where a status item
    /// would be if we could see one.
    private static func menuBarCorner() -> NSRect {
        guard let screen = NSScreen.main else { return .zero }
        let barHeight = max(screen.frame.maxY - screen.visibleFrame.maxY, 24)
        return NSRect(x: screen.visibleFrame.maxX - 22, y: screen.frame.maxY - barHeight,
                      width: 22, height: barHeight)
    }

    /// Below `rect`, aligned to its trailing edge the way a menu is, and never
    /// off the side or the bottom of the screen it hangs from.
    private func place(below rect: NSRect, on screen: NSScreen?) {
        let size = panel.frame.size
        var x = rect.maxX - size.width
        var top = rect.minY - Self.gap
        if let visible = (screen ?? NSScreen.main)?.visibleFrame {
            x = min(x, visible.maxX - size.width - Self.screenMargin)
            x = max(x, visible.minX + Self.screenMargin)
            top = min(top, visible.maxY)
            top = max(top, visible.minY + size.height + Self.screenMargin)
        }
        panel.setFrameTopLeftPoint(NSPoint(x: x, y: top))
    }

    /// A click anywhere else dismisses it, including on the icon it names,
    /// which is the gesture the notice is pointing at.
    ///
    /// Two monitors, because one cannot see both sides. The global one reports
    /// clicks in OTHER apps and never fires for our own; the local one sees
    /// ours, and has to hand the click back rather than eat it, or the first
    /// click on the recorder would only close the notice.
    private func watchForOutsideClick() {
        let mouse: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mouse, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }) {
            outsideClick.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mouse, handler: { [weak self] event in
            if let self, event.window !== self.panel { self.close() }
            return event
        }) {
            outsideClick.append(local)
        }
    }

    /// Take it down and stop listening. Safe to call twice: the monitors go on
    /// the first, and a window already ordered out orders out harmlessly.
    private func close() {
        for monitor in outsideClick { NSEvent.removeMonitor(monitor) }
        outsideClick = []
        panel.orderOut(nil)
        content = nil
        if Self.current === self { Self.current = nil }
    }
}
