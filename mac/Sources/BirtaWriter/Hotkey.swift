import AppKit
import Carbon.HIToolbox
import BirtaWriterCore

/// The global hotkey, registered with Carbon `RegisterEventHotKey`.
///
/// Registration rather than a global event monitor: it needs no Accessibility
/// grant, so first run sends nobody to System Settings, and it does not care
/// that an ad-hoc-signed development build changes identity on every rebuild
/// (TCC keys grants to code signature). The Carbon handler is a C callback that
/// cannot capture, hence the `userData` round-trip through `Unmanaged`.
@MainActor
final class GlobalHotkey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    /// Set before `register`; called on the main queue for every press.
    var onPress: () -> Void = {}
    private(set) var combo: HotkeyCombo?

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetEventDispatcherTarget(), { _, _, userData -> OSStatus in
            guard let userData else { return noErr }
            let me = Unmanaged<GlobalHotkey>.fromOpaque(userData).takeUnretainedValue()
            // The dispatcher runs on the main run loop; hop anyway so the
            // callback returns before any AppKit work happens.
            DispatchQueue.main.async { me.onPress() }
            return noErr
        }, 1, &spec, selfPtr, &handlerRef)
    }

    /// The option `register` asks for, and the reason the status it returns is
    /// worth reading at all.
    ///
    /// Without `kEventHotKeyExclusive`, `RegisterEventHotKey` answers `noErr`
    /// when ANOTHER PROCESS already holds the combination: the registration
    /// succeeds, the key goes on reaching whoever asked for it first, and the
    /// status reports nothing wrong. That is the whole failure this app is
    /// trying to tell people about, so a caller checking the status was
    /// checking something that never fired outside its own process.
    ///
    /// **Exclusive narrows that gap rather than closing it, and the limit is
    /// measured rather than assumed.** Two processes, one chord, four
    /// combinations:
    ///
    /// | holder | this app | result |
    /// | -- | -- | -- |
    /// | plain | plain | `noErr` |
    /// | plain | exclusive | `noErr` |
    /// | exclusive | exclusive | `eventHotKeyExistsErr` |
    /// | exclusive | plain | `noErr` |
    ///
    /// So a refusal arrives only when the app that got there first ALSO asked
    /// exclusively, and most apps do not. Asking exclusively is still strictly
    /// better than not asking, because it is the only way any cross-process
    /// refusal reaches us at all, and it costs nothing: the last row shows an
    /// exclusive holder does not block a later plain request, so this does not
    /// take the chord away from anybody.
    ///
    /// Its reach stops at the Carbon registry besides, which is not everything
    /// macOS binds: the app switcher and Mission Control are in it, Spotlight
    /// and the screenshot keys are not.
    ///
    /// The asymmetry both limits produce is the thing to hold onto: a refusal
    /// is proof the summon will not work, and a clean status is NOT proof that
    /// it will. Nothing here can tell somebody their chord is live.
    static let registrationOptions = OptionBits(kEventHotKeyExclusive)

    /// Bind (or rebind) the hotkey. Returns the OSStatus of the registration;
    /// anything but `noErr` means the combination is spoken for and pressing
    /// it will not summon the panel.
    @discardableResult
    func register(_ combo: HotkeyCombo) -> OSStatus {
        unregister()
        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: fourCC("BWRT"), id: 1)
        let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, id, GetEventDispatcherTarget(),
                                         Self.registrationOptions, &ref)
        if status == noErr {
            hotKeyRef = ref
            self.combo = combo
        }
        return status
    }

    func unregister() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
            combo = nil
        }
    }

    deinit {
        if let ref = hotKeyRef { UnregisterEventHotKey(ref) }
        if let h = handlerRef { RemoveEventHandler(h) }
    }

    private func fourCC(_ s: String) -> OSType {
        var result: OSType = 0
        for u in s.utf8.prefix(4) { result = (result << 8) | OSType(u) }
        return result
    }
}

/// The AppKit side of a combo: reading one off a key event, and drawing one the
/// way the system draws a shortcut. The core type stays Foundation-only so its
/// parsing is testable without a window, so the bridging lives here.
extension HotkeyCombo {
    /// The combo a key-down event describes, or nil when it is not one the app can
    /// register (a bare key, or one outside the ANSI vocabulary).
    static func from(event: NSEvent) -> HotkeyCombo? {
        from(keyCode: UInt32(event.keyCode), modifiers: carbonModifiers(event.modifierFlags))
    }

    /// Carbon bits from an event's flags. Only the four that
    /// `RegisterEventHotKey` takes; Caps Lock and Fn are not modifiers a hotkey
    /// can hold.
    static func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
        var bits: UInt32 = 0
        if flags.contains(.command) { bits |= cmdKey }
        if flags.contains(.option) { bits |= optionKey }
        if flags.contains(.control) { bits |= controlKey }
        if flags.contains(.shift) { bits |= shiftKey }
        return bits
    }

    var menuModifierMask: NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if modifiers & HotkeyCombo.cmdKey != 0 { flags.insert(.command) }
        if modifiers & HotkeyCombo.optionKey != 0 { flags.insert(.option) }
        if modifiers & HotkeyCombo.controlKey != 0 { flags.insert(.control) }
        if modifiers & HotkeyCombo.shiftKey != 0 { flags.insert(.shift) }
        return flags
    }

    /// The character AppKit wants for `NSMenuItem.keyEquivalent`, which is the
    /// key itself for letters and digits and a control or function-key scalar
    /// for the named ones.
    var menuKeyEquivalent: String {
        func scalar(_ value: Int) -> String {
            UnicodeScalar(UInt32(value)).map { String(Character($0)) } ?? ""
        }
        switch keyName {
        case "return", "enter": return "\r"
        case "tab": return "\t"
        case "space": return " "
        case "delete", "backspace": return "\u{8}"
        case "escape", "esc": return "\u{1b}"
        case "left": return scalar(NSLeftArrowFunctionKey)
        case "right": return scalar(NSRightArrowFunctionKey)
        case "up": return scalar(NSUpArrowFunctionKey)
        case "down": return scalar(NSDownArrowFunctionKey)
        default:
            if keyName.first == "f", let n = Int(keyName.dropFirst()), (1...12).contains(n) {
                return scalar(NSF1FunctionKey + n - 1)
            }
            return keyName
        }
    }

    /// The key's own symbol, as a menu draws it: ⏎, ␣, an arrow, or the letter.
    var keySymbol: String {
        switch keyName {
        case "return", "enter": return "↩"
        case "tab": return "⇥"
        case "space": return "Space"
        case "delete", "backspace": return "⌫"
        case "escape", "esc": return "⎋"
        case "left": return "←"
        case "right": return "→"
        case "up": return "↑"
        case "down": return "↓"
        default: return keyName.uppercased()
        }
    }
}
