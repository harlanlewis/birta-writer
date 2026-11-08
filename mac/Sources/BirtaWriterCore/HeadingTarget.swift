import Foundation

/// Which line of a Markdown document a place-name means: a heading, by its
/// text or its anchor slug, or a line number. What `bwr <file> --at <target>`
/// resolves before it hands the app a line.
///
/// A port of `shared/headingTarget.ts`, with the two modules it stands on,
/// `shared/headingScan.ts` and `shared/slug.ts`, because Swift cannot import
/// them. The golden file `shared/__tests__/fixtures/headingTargetGolden.json`
/// is what holds the two together: the TypeScript regenerates it on every run
/// and `HeadingTargetGoldenTests` requires this file to answer the same, input
/// for input. That is also why everything here walks UTF-16 code units with
/// `JSText`'s classes rather than Swift `Character`s: the TypeScript is
/// JavaScript string semantics, and a port that trimmed with
/// `Character.isWhitespace` would agree on ASCII and disagree on the first
/// no-break space.
///
/// Lines are 1-based document lines, frontmatter included, which is what the
/// page's `scrollToLine` counts.
public enum HeadingTarget {
    typealias Units = JSText.Units

    /// What a place-name asks for, before any document is read.
    public enum Target: Equatable, Sendable {
        case line(Int)
        case heading(String)
    }

    /// One heading as `scanHeadings` reports it.
    public struct Heading: Equatable, Sendable {
        public let level: Int
        public let text: String
        public let line: Int
    }

    // MARK: parseAtTarget

    /// `parseAtTarget`: `42` and `L42` (either case) are a line; anything else
    /// names a heading, by text or slug, with one leading `#` dropped. Nil for
    /// a name that names nothing: empty, a bare `#`, or line 0.
    public static func parse(_ word: String) -> Target? {
        let trimmed = JSText.trim(JSText.units(word))
        var digits = trimmed[...]
        if let first = digits.first, first == c("L") || first == c("l") { digits = digits.dropFirst() }
        if !digits.isEmpty, digits.allSatisfy(JSText.isAsciiDigit) {
            // `Number.isSafeInteger`: past 2^53 - 1 the TypeScript refuses.
            var n: UInt64 = 0
            for d in digits {
                n = n * 10 + UInt64(d - c("0"))
                if n > 9_007_199_254_740_991 { return nil }
            }
            return n >= 1 ? .line(Int(n)) : nil
        }
        let fragment = trimmed.first == c("#") ? Array(trimmed.dropFirst()) : trimmed
        return JSText.trim(fragment).isEmpty ? nil : .heading(JSText.string(fragment))
    }

    // MARK: resolve

    /// `resolveAtTarget`: the line `target` lands on in `text`, or nil when
    /// the document has no such heading or is shorter than the line.
    public static func resolve(_ target: Target, in text: String) -> Int? {
        switch target {
        case let .heading(fragment): return headingLine(in: text, fragment: fragment)
        case let .line(line): return line <= lineCount(text) ? line : nil
        }
    }

    /// `documentLineCount`: a final newline ends the last line rather than
    /// starting one, and an empty document still has line 1.
    public static func lineCount(_ text: String) -> Int {
        let units = JSText.units(text)
        if units.isEmpty { return 1 }
        let parts = JSText.split(units, c("\n")).count
        return units.last == c("\n") ? parts - 1 : parts
    }

    /// `findHeadingLine`: the line of the heading `fragment` names, by slug
    /// (percent-encoded or not, `foo-1` for the second `Foo`) or by text in
    /// any case. A heading whose slug is empty cannot be named.
    public static func headingLine(in text: String, fragment: String) -> Int? {
        // `decodeURIComponent`, keeping the raw fragment where it throws.
        let decoded = fragment.removingPercentEncoding ?? fragment
        let wanted: Set<String> = [lowerCase(decoded), slugify(decoded)]
        var counts: [String: Int] = [:]
        for heading in scan(text) {
            let base = slugify(rendered(heading.text))
            if base.isEmpty { continue }
            let count = counts[base, default: 0]
            counts[base] = count + 1
            let slug = count == 0 ? base : "\(base)-\(count)"
            if wanted.contains(slug) { return heading.line }
        }
        return nil
    }

    // MARK: slug.ts

    /// `slugify`: lower case, keep only letters, digits, `_`, `-` and space,
    /// then each space becomes a hyphen. Repeats are kept and nothing is
    /// trimmed, as GitHub's anchors do.
    public static func slugify(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in lowerCase(text).unicodeScalars {
            switch scalar {
            case " ": out.append("-")
            case "_", "-": out.append(scalar)
            default:
                if isLetterOrNumber(scalar) { out.append(scalar) }
            }
        }
        return String(out)
    }

    /// `String.prototype.toLowerCase`: Unicode's full lower-case mapping, with
    /// its one context rule, a capital sigma ending a word becoming `ς`.
    /// Swift's own `lowercased()` maps each scalar alone and writes `σ`, so a
    /// Greek heading would slug apart from the page's anchor; ICU through a
    /// locale applies the rule, and the POSIX locale adds no language's own
    /// tailoring (Turkish dotless i), which JavaScript does not apply either.
    private static func lowerCase(_ text: String) -> String {
        text.lowercased(with: Locale(identifier: "en_US_POSIX"))
    }

    /// `\p{L}` and `\p{N}`, by general category.
    private static func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            return true
        default:
            return false
        }
    }

    // MARK: renderedHeadingText

    /// `renderedHeadingText`: a link or an image keeps only its text, and
    /// code drops its backticks, in that order and each a global replace.
    public static func rendered(_ raw: String) -> String {
        var units = JSText.units(raw)
        units = replaceBracketed(units, image: true)
        units = replaceBracketed(units, image: false)
        units = replaceCode(units)
        return JSText.string(units)
    }

    /// `/!?\[([^\]]*)\]\([^)]*\)/g` with `$1`: the label runs to the FIRST
    /// `]`, which must be followed at once by `(`, and the target to the
    /// first `)`. A position that does not match moves on by one unit, as
    /// the regular expression's scan does.
    private static func replaceBracketed(_ s: Units, image: Bool) -> Units {
        var out: Units = []
        var i = 0
        while i < s.count {
            let open = image ? i + 1 : i
            if (!image || s[i] == c("!")), open < s.count, s[open] == c("[") {
                let close = JSText.indexOf(s, c("]"), from: open + 1)
                if close != -1, close + 1 < s.count, s[close + 1] == c("(") {
                    let end = JSText.indexOf(s, c(")"), from: close + 2)
                    if end != -1 {
                        out.append(contentsOf: s[(open + 1)..<close])
                        i = end + 1
                        continue
                    }
                }
            }
            out.append(s[i])
            i += 1
        }
        return out
    }

    /// ``/`([^`]*)`/g`` with `$1`.
    private static func replaceCode(_ s: Units) -> Units {
        var out: Units = []
        var i = 0
        while i < s.count {
            if s[i] == c("`") {
                let close = JSText.indexOf(s, c("`"), from: i + 1)
                if close != -1 {
                    out.append(contentsOf: s[(i + 1)..<close])
                    i = close + 1
                    continue
                }
            }
            out.append(s[i])
            i += 1
        }
        return out
    }

    // MARK: headingScan.ts

    /// `scanHeadings`: ATX and setext headings in source order with their
    /// 1-based lines, skipping fenced code and a leading YAML or TOML
    /// frontmatter block.
    public static func scan(_ text: String) -> [Heading] {
        let lines: [Units] = JSText.split(JSText.units(text), c("\n")).map {
            $0.last == c("\r") ? Array($0.dropLast()) : $0
        }
        let n = lines.count
        var headings: [Heading] = []
        var i = 0

        // A frontmatter block opens on line 1 and is skipped only when its
        // own delimiter closes it; YAML also closes on the end marker `...`.
        if n > 0 {
            let yaml = isDelimiter(lines[0], c("-"))
            let toml = isDelimiter(lines[0], c("+"))
            if yaml || toml {
                var j = 1
                while j < n {
                    let line = lines[j]
                    if yaml ? (isDelimiter(line, c("-")) || isDelimiter(line, c("."))) : isDelimiter(line, c("+")) { break }
                    j += 1
                }
                if j < n { i = j + 1 }
            }
        }

        while i < n {
            let line = lines[i]

            if let fence = fenceRun(trimStart(line)) {
                i += 1
                while i < n {
                    if let close = fenceRun(trimStart(lines[i])), close.marker == fence.marker, close.length >= fence.length { break }
                    i += 1
                }
                i += 1
                continue
            }

            if let atx = atx(line) {
                headings.append(Heading(level: atx.level, text: JSText.string(atx.text), line: i + 1))
                i += 1
                continue
            }

            // Setext: a non-blank line that is not indented code, over an
            // underline of `=` (level 1) or `-` (level 2).
            if !JSText.trim(line).isEmpty, !hasFourSpaceIndent(line), i + 1 < n, let level = setextLevel(lines[i + 1]) {
                headings.append(Heading(level: level, text: JSText.string(JSText.trim(line)), line: i + 1))
                i += 2
                continue
            }
            i += 1
        }
        return headings
    }

    /// `^---[ \t]*$`, `^\.\.\.[ \t]*$` or `^\+\+\+[ \t]*$`, by the repeated unit.
    private static func isDelimiter(_ line: Units, _ unit: UInt16) -> Bool {
        guard line.count >= 3, line[0] == unit, line[1] == unit, line[2] == unit else { return false }
        return line[3...].allSatisfy(isSpaceOrTab)
    }

    /// `^(`{3,}|~{3,})`: the marker and the whole run's length.
    private static func fenceRun(_ s: ArraySlice<UInt16>) -> (marker: UInt16, length: Int)? {
        guard let first = s.first, first == c("`") || first == c("~") else { return nil }
        let length = s.prefix { $0 == first }.count
        return length >= 3 ? (first, length) : nil
    }

    /// `^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$`, then the closing run
    /// `[ \t]+#+[ \t]*$` removed and the rest trimmed.
    private static func atx(_ line: Units) -> (level: Int, text: Units)? {
        var i = 0
        while i < line.count, line[i] == c(" ") { i += 1 }
        guard i <= 3 else { return nil }
        var hashes = 0
        while i + hashes < line.count, line[i + hashes] == c("#") { hashes += 1 }
        guard hashes >= 1, hashes <= 6 else { return nil }
        let rest = line[(i + hashes)...]
        guard let first = rest.first else { return (hashes, []) }
        guard isSpaceOrTab(first) else { return nil }
        // `.` refuses a line terminator, so a line holding one is no heading
        // unless all of what follows the hashes is space.
        var content = rest.drop { isSpaceOrTab($0) }
        while let last = content.last, isSpaceOrTab(last) { content = content.dropLast() }
        if content.contains(where: JSText.isLineTerminator) { return nil }
        return (hashes, JSText.trim(Array(removingClosingRun(content))))
    }

    /// `raw.replace(/[ \t]+#+[ \t]*$/, "")`.
    private static func removingClosingRun(_ s: ArraySlice<UInt16>) -> ArraySlice<UInt16> {
        var end = s.endIndex
        while end > s.startIndex, isSpaceOrTab(s[end - 1]) { end -= 1 }
        let hashEnd = end
        while end > s.startIndex, s[end - 1] == c("#") { end -= 1 }
        guard end < hashEnd else { return s }
        let spaceEnd = end
        while end > s.startIndex, isSpaceOrTab(s[end - 1]) { end -= 1 }
        guard end < spaceEnd else { return s }
        return s[s.startIndex..<end]
    }

    /// `^ {0,3}(=+|-+)[ \t]*$`.
    private static func setextLevel(_ line: Units) -> Int? {
        var i = 0
        while i < line.count, line[i] == c(" ") { i += 1 }
        guard i <= 3, i < line.count, line[i] == c("=") || line[i] == c("-") else { return nil }
        let marker = line[i]
        while i < line.count, line[i] == marker { i += 1 }
        guard line[i...].allSatisfy(isSpaceOrTab) else { return nil }
        return marker == c("=") ? 1 : 2
    }

    /// `/^ {4,}/`.
    private static func hasFourSpaceIndent(_ line: Units) -> Bool {
        line.count >= 4 && line.prefix(4).allSatisfy { $0 == c(" ") }
    }

    /// `String.prototype.trimStart`.
    private static func trimStart(_ s: Units) -> ArraySlice<UInt16> {
        s.drop(while: JSText.isSpace)
    }

    private static func isSpaceOrTab(_ u: UInt16) -> Bool { u == 0x20 || u == 0x09 }

    @inline(__always)
    private static func c(_ s: Unicode.Scalar) -> UInt16 { JSText.c(s) }
}
