import Foundation

/// A global hotkey as the user writes it in Preferences ("cmd+alt+ctrl+j") and
/// as Carbon wants it (a virtual key code plus a modifier mask). Parsing is
/// pure so the text field's validation is unit-tested; registration lives in
/// the app target.
///
/// Key names are the ANSI (US) layout: the Carbon virtual key codes name
/// physical positions, so on another layout the letter printed on the key can
/// differ from the one that fires. Good enough for a first cut; a recorder
/// control that captures the pressed key is the later fix.
public struct HotkeyCombo: Equatable, Sendable {
    public let keyCode: UInt32
    /// Carbon modifier bits: cmdKey 0x100, shiftKey 0x200, optionKey 0x800, controlKey 0x1000.
    public let modifiers: UInt32
    /// The canonical spelling ("cmd+alt+ctrl+j"), for storage and display.
    public let spelling: String

    public static let cmdKey: UInt32 = 0x100
    public static let shiftKey: UInt32 = 0x200
    public static let optionKey: UInt32 = 0x800
    public static let controlKey: UInt32 = 0x1000

    /// The release build's default: Command-Option-Control-J. Unclaimed by
    /// macOS and the usual launchers.
    public static let release = HotkeyCombo(keyCode: 38, modifiers: cmdKey | optionKey | controlKey, spelling: "cmd+alt+ctrl+j")

    /// The development build's, which adds Shift.
    ///
    /// A global hotkey is first come first served, so two builds asking for
    /// the same one means the second to launch does not get it, and the only
    /// sign is a caption in a Settings pane nobody has opened.
    public static let dev = HotkeyCombo(keyCode: 38, modifiers: cmdKey | optionKey | controlKey | shiftKey, spelling: "cmd+alt+ctrl+shift+j")

    /// This build's default, whichever it is.
    public static var `default`: HotkeyCombo { AppFlavor.current.defaultHotkey }

    public init(keyCode: UInt32, modifiers: UInt32, spelling: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.spelling = spelling
    }

    public enum ParseError: Error, Equatable, CustomStringConvertible {
        case empty
        case unknownToken(String)
        case noKey
        case twoKeys(String, String)
        case noModifier

        public var description: String {
            switch self {
            case .empty: return "Enter a key combination such as cmd+alt+ctrl+j."
            case .unknownToken(let t): return "Unknown key \"\(t)\"."
            case .noKey: return "Name a key after the modifiers, such as cmd+alt+j."
            case .twoKeys(let a, let b): return "One key only; got \"\(a)\" and \"\(b)\"."
            case .noModifier: return "A global hotkey needs at least one modifier (cmd, alt, ctrl, shift)."
            }
        }
    }

    /// Parse "cmd+alt+ctrl+j". Tokens are case-insensitive and separated by
    /// `+`, `-` or whitespace; modifier synonyms are accepted and the spelling
    /// is normalised to cmd/alt/ctrl/shift in that order.
    ///
    /// `-` is both a separator and a key, so a trailing one is taken as the key
    /// before anything is split. Without that, "cmd+-" tokenises to ["cmd"] and
    /// the minus key is unbindable while `keyCodes` still lists it, which makes
    /// `from(keyCode:)` return nil for a key the user really did press.
    public static func parse(_ text: String) -> Result<HotkeyCombo, ParseError> {
        var body = text.lowercased()
        var trailingMinus: String? = nil
        if body.count > 1, body.hasSuffix("-") {
            body = String(body.dropLast())
            trailingMinus = "-"
        }
        var tokens = body
            .split(whereSeparator: { $0 == "+" || $0 == "-" || $0.isWhitespace })
            .map(String.init)
        if let minus = trailingMinus { tokens.append(minus) }
        guard !tokens.isEmpty else { return .failure(.empty) }
        var mods: UInt32 = 0
        var key: (name: String, code: UInt32)?
        for token in tokens {
            if let bit = modifierBits[token] {
                mods |= bit
            } else if let code = keyCodes[token] {
                if let existing = key { return .failure(.twoKeys(existing.name, token)) }
                key = (token, code)
            } else {
                return .failure(.unknownToken(token))
            }
        }
        guard let k = key else { return .failure(.noKey) }
        guard mods != 0 else { return .failure(.noModifier) }
        var parts: [String] = []
        if mods & cmdKey != 0 { parts.append("cmd") }
        if mods & optionKey != 0 { parts.append("alt") }
        if mods & controlKey != 0 { parts.append("ctrl") }
        if mods & shiftKey != 0 { parts.append("shift") }
        parts.append(k.name)
        return .success(HotkeyCombo(keyCode: k.code, modifiers: mods, spelling: parts.joined(separator: "+")))
    }

    /// The key on its own, as `parse` spells it ("j", "space", "f5").
    public var keyName: String { spelling.split(separator: "+").last.map(String.init) ?? "" }

    /// The combo a pressed key describes: a virtual key code and the Carbon
    /// modifier bits, which is what both `RegisterEventHotKey` and a recorder
    /// control have in hand.
    ///
    /// Nil for a key this vocabulary cannot spell, and nil when no modifier is
    /// held, because a global hotkey without one would take that key away from
    /// every app on the machine.
    public static func from(keyCode: UInt32, modifiers: UInt32) -> HotkeyCombo? {
        guard let name = canonicalKeyNames[keyCode] else { return nil }
        var parts: [String] = []
        if modifiers & cmdKey != 0 { parts.append("cmd") }
        if modifiers & optionKey != 0 { parts.append("alt") }
        if modifiers & controlKey != 0 { parts.append("ctrl") }
        if modifiers & shiftKey != 0 { parts.append("shift") }
        parts.append(name)
        return try? parse(parts.joined(separator: "+")).get()
    }

    /// The symbol form for menus: ⌃⌥⇧⌘J, Apple's order, which is what AppKit
    /// draws a key equivalent in.
    ///
    /// The ORDER is `HostShortcut.symbols`', not this type's, because the
    /// titlebar's buttons spell the same thing from a different source
    /// (`AppMenu.Row`) and two copies of a modifier order drift silently: both
    /// look like chords, and only a person who knows the convention can see
    /// which one is wrong.
    public var symbols: String {
        let keyName = spelling.split(separator: "+").last.map(String.init) ?? "?"
        return HostShortcut.symbols(
            key: keyName,
            command: modifiers & HotkeyCombo.cmdKey != 0,
            shift: modifiers & HotkeyCombo.shiftKey != 0,
            option: modifiers & HotkeyCombo.optionKey != 0,
            control: modifiers & HotkeyCombo.controlKey != 0)
    }

    private static let modifierBits: [String: UInt32] = [
        "cmd": cmdKey, "command": cmdKey, "meta": cmdKey, "super": cmdKey,
        "alt": optionKey, "opt": optionKey, "option": optionKey,
        "ctrl": controlKey, "control": controlKey,
        "shift": shiftKey,
    ]

    /// ANSI virtual key codes (Carbon HIToolbox Events.h).
    static let keyCodes: [String: UInt32] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
        "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
        "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
        "m": 46, ".": 47, "`": 50,
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ]

    /// One name per key code, for spelling a code back out. `keyCodes` holds
    /// synonyms (enter/return, backspace/delete), so the choice has to be made
    /// somewhere rather than left to dictionary order, which is not stable.
    static let canonicalKeyNames: [UInt32: String] = {
        let preferred: Set<String> = ["return", "delete", "escape", "space", "tab"]
        var out: [UInt32: String] = [:]
        for (name, code) in keyCodes {
            guard let existing = out[code] else { out[code] = name; continue }
            if preferred.contains(existing) { continue }
            if preferred.contains(name) || name < existing { out[code] = name }
        }
        return out
    }()
}
