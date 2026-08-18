import AppKit
import Carbon.HIToolbox
import BirtaJotCore

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

    /// Bind (or rebind) the hotkey. Returns the OSStatus of the registration;
    /// a non-zero value usually means another app owns the combination.
    @discardableResult
    func register(_ combo: HotkeyCombo) -> OSStatus {
        unregister()
        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: fourCC("BJOT"), id: 1)
        let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, id, GetEventDispatcherTarget(), 0, &ref)
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
