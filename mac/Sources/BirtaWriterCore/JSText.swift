import Foundation

/// The few JavaScript string semantics a port of a TypeScript text scanner has
/// to reproduce exactly, over UTF-16 code units.
///
/// The TypeScript side indexes strings in UTF-16 code units and its regular
/// expressions draw on JavaScript's own character classes, so a port that
/// walked Swift `Character`s, or leaned on `Character.isWhitespace`, would
/// agree with it on ASCII and disagree the first time a note held a
/// no-break space or an emoji. Everything here is named for the JavaScript
/// construct it restates.
enum JSText {
    typealias Units = [UInt16]

    /// JavaScript's `\s`, which is also what `String.prototype.trim` strips:
    /// WhiteSpace plus LineTerminator, BOM included.
    static func isSpace(_ u: UInt16) -> Bool {
        switch u {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// The characters JavaScript's `.` refuses to match (without the `s` flag).
    static func isLineTerminator(_ u: UInt16) -> Bool {
        u == 0x0A || u == 0x0D || u == 0x2028 || u == 0x2029
    }

    static func isAsciiLetter(_ u: UInt16) -> Bool {
        (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A)
    }

    static func isAsciiDigit(_ u: UInt16) -> Bool {
        u >= 0x30 && u <= 0x39
    }

    static func isHexDigit(_ u: UInt16) -> Bool {
        isAsciiDigit(u) || (u >= 0x41 && u <= 0x46) || (u >= 0x61 && u <= 0x66)
    }

    /// ASCII lower case, the only folding a JavaScript `i` flag applies to an
    /// ASCII pattern (a non-ASCII character never folds onto an ASCII one).
    static func asciiLower(_ u: UInt16) -> UInt16 {
        (u >= 0x41 && u <= 0x5A) ? u + 0x20 : u
    }

    /// The code unit of an ASCII scalar, for readable comparisons.
    @inline(__always)
    static func c(_ s: Unicode.Scalar) -> UInt16 { UInt16(s.value) }

    static func units(_ s: String) -> Units { Array(s.utf16) }

    /// The string these units spell. A lone surrogate, which a JavaScript
    /// string can hold and a Swift one cannot, becomes U+FFFD.
    static func string(_ u: ArraySlice<UInt16>) -> String { String(decoding: u, as: UTF16.self) }
    static func string(_ u: Units) -> String { String(decoding: u, as: UTF16.self) }

    /// `String.prototype.trim`.
    static func trim(_ s: ArraySlice<UInt16>) -> ArraySlice<UInt16> {
        var lo = s.startIndex
        var hi = s.endIndex
        while lo < hi, isSpace(s[lo]) { lo += 1 }
        while hi > lo, isSpace(s[hi - 1]) { hi -= 1 }
        return s[lo..<hi]
    }

    static func trim(_ s: Units) -> Units { Array(trim(s[...])) }

    /// `s.indexOf(needle, from)`.
    static func indexOf(_ s: Units, _ needle: Units, from: Int = 0) -> Int {
        guard !needle.isEmpty else { return min(from, s.count) }
        guard s.count >= needle.count else { return -1 }
        var i = max(from, 0)
        let last = s.count - needle.count
        while i <= last {
            if s[i] == needle[0] {
                var k = 1
                while k < needle.count, s[i + k] == needle[k] { k += 1 }
                if k == needle.count { return i }
            }
            i += 1
        }
        return -1
    }

    static func indexOf(_ s: Units, _ unit: UInt16, from: Int = 0) -> Int {
        var i = max(from, 0)
        while i < s.count {
            if s[i] == unit { return i }
            i += 1
        }
        return -1
    }

    /// `s.startsWith(prefix, at)`.
    static func startsWith(_ s: ArraySlice<UInt16>, _ prefix: Units, at: Int? = nil) -> Bool {
        let start = at ?? s.startIndex
        guard start >= s.startIndex, start + prefix.count <= s.endIndex else { return false }
        for k in 0..<prefix.count where s[start + k] != prefix[k] { return false }
        return true
    }

    static func startsWith(_ s: Units, _ prefix: Units, at: Int = 0) -> Bool {
        startsWith(s[...], prefix, at: at)
    }

    static func endsWith(_ s: ArraySlice<UInt16>, _ suffix: Units) -> Bool {
        guard s.count >= suffix.count else { return false }
        return startsWith(s, suffix, at: s.endIndex - suffix.count)
    }

    /// `s.split(sep)` for a one-unit separator.
    static func split(_ s: Units, _ sep: UInt16) -> [Units] {
        var out: [Units] = []
        var cur: Units = []
        for u in s {
            if u == sep {
                out.append(cur)
                cur = []
            } else {
                cur.append(u)
            }
        }
        out.append(cur)
        return out
    }

    /// Does `s` contain a `\s` immediately followed by `#`? (`/\s#/.test(s)`)
    static func hasSpaceHash(_ s: ArraySlice<UInt16>) -> Bool {
        var i = s.startIndex
        while i + 1 < s.endIndex {
            if isSpace(s[i]) && s[i + 1] == c("#") { return true }
            i += 1
        }
        return false
    }

    /// The code point's UTF-16 spelling, as `String.fromCodePoint` gives it:
    /// a surrogate stays a lone unit. Nil past U+10FFFF, where JavaScript
    /// throws.
    static func fromCodePoint(_ cp: UInt32) -> Units? {
        if cp <= 0xFFFF { return [UInt16(cp)] }
        if cp <= 0x10FFFF {
            let v = cp - 0x10000
            return [UInt16(0xD800 + (v >> 10)), UInt16(0xDC00 + (v & 0x3FF))]
        }
        return nil
    }
}
