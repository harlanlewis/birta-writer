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
/// popover hanging off that icon shows the reader where it is, in the one
/// moment they are looking for a way in. It also cannot appear over another
/// app's window, which an app-modal alert from a menu-bar app can.
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

    /// Wide enough for the recorder plus its padding, and no wider: a popover
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

/// Hanging the notice off the status item, and keeping it alive while it is up.
///
/// A popover is not retained by the view it points at, so something has to hold
/// it. That is here rather than in `Coordinator`, which has enough to hold, and
/// it is one at a time: a second refusal replaces the first rather than
/// stacking, since there is only one hotkey to be refused.
@MainActor
final class SummonNoticePopover: NSObject, NSPopoverDelegate {
    private static var current: SummonNoticePopover?

    private let popover = NSPopover()

    /// Show the notice under `anchor`, replacing one already up.
    ///
    /// The app is NOT activated. This fires at launch, and a login item that
    /// steals the front window from whatever somebody is doing has answered a
    /// small problem with a bigger one. Clicking into the notice activates the
    /// app the way clicking any background window does, which is what the
    /// recorder needs and all it needs.
    @discardableResult
    static func show(refused combo: HotkeyCombo,
                     from anchor: NSStatusBarButton,
                     rebind: @escaping (HotkeyCombo) -> OSStatus) -> SummonNoticeView {
        current?.popover.performClose(nil)
        let controller = SummonNoticePopover()
        let content = SummonNoticeView(refused: combo, rebind: rebind)
        controller.popover.contentViewController = content
        // Transient: a click anywhere else dismisses it, including a click on
        // the icon it names, which is the gesture the notice is pointing at.
        controller.popover.behavior = .transient
        controller.popover.delegate = controller
        current = controller
        controller.popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .maxY)
        return content
    }

    func popoverDidClose(_ notification: Notification) {
        if Self.current === self { Self.current = nil }
    }
}
