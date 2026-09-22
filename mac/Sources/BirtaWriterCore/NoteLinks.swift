import Foundation

/// What one note says about other notes, read from its SOURCE bytes: the
/// local links in its body, the wikilinks, and the `sources[].resource` paths
/// its frontmatter names, plus the few attributes a folder view shows.
///
/// A literal port of `shared/noteLinks.ts` (and of `shared/wikiRaw.ts`, which
/// it splits a wikilink with), for the folder index this host builds
/// (`FolderIndex`). The TypeScript is a scanner rather than a parser, held to
/// the editor's own Links scan over the corpus by
/// `webview/__tests__/noteLinksCorpus.test.ts`; this is held to the
/// TypeScript by a golden file, `shared/__tests__/fixtures/noteLinksGolden.json`,
/// which `shared/__tests__/noteLinksGolden.test.ts` regenerates from `readNote`
/// and fails on when stale, and which `NoteLinksGoldenTests` requires this to
/// reproduce input for input. So the chain is editor, then TypeScript, then
/// Swift, and a change to either scanner's patterns alone reddens one link.
///
/// It walks UTF-16 code units, which is what a JavaScript string indexes, so
/// every position, every `\s` and every trim here is the one the TypeScript
/// computes (`JSText`). Nothing here resolves a path; which file a link means
/// is `NoteLinkResolver`'s question.
public enum NoteLinks {
    typealias Units = JSText.Units

    public enum Kind: String, Sendable { case link, wiki, source }

    public struct Ref: Equatable, Sendable {
        public var kind: Kind
        /// The destination as the editor holds it: escapes and character
        /// references decoded, a wikilink's `target#heading`.
        public var href: String
        /// `href` up to its first `#`: the part a resolver takes.
        public var path: String
        public var text: String
        /// 1-based line of the file the reference was written on.
        public var line: Int
    }

    public struct Meta: Equatable, Sendable {
        public var title: String?
        public var type: String?
        public var tags: [String] = []
        public var status: String?
        public var trust: String?
        public var staleAfter: String?
    }

    public struct Reading: Equatable, Sendable {
        public var links: [Ref]
        public var meta: Meta
    }

    public struct BodyLink: Equatable, Sendable {
        public var at: Int
        public var href: String
        public var text: String
        public var wiki: Bool
    }

    private static let c = JSText.c

    // MARK: classification

    /// An href with a scheme, or a bare `#fragment`, is not a link to a note.
    public static func isNoteHref(_ href: String) -> Bool {
        isNoteHref(JSText.units(href))
    }

    static func isNoteHref(_ h: Units) -> Bool {
        guard let first = h.first, first != c("#") else { return false }
        // `/^[a-z][a-z0-9+.-]*:/i`
        guard JSText.isAsciiLetter(first) else { return true }
        var i = 1
        while i < h.count, JSText.isAsciiLetter(h[i]) || JSText.isAsciiDigit(h[i])
                || h[i] == c("+") || h[i] == c(".") || h[i] == c("-") { i += 1 }
        return !(i < h.count && h[i] == c(":"))
    }

    /// Everything before the first `#`.
    static func hrefPath(_ h: Units) -> Units {
        let hash = JSText.indexOf(h, c("#"))
        return hash >= 0 ? Array(h[0..<hash]) : h
    }

    // MARK: decoding

    private static func isAsciiPunct(_ u: UInt16) -> Bool {
        (u >= 0x21 && u <= 0x2F) || (u >= 0x3A && u <= 0x40) || (u >= 0x5B && u <= 0x60) || (u >= 0x7B && u <= 0x7E)
    }

    private static let namedEntities: [Units: Units] = [
        JSText.units("amp"): JSText.units("&"), JSText.units("lt"): JSText.units("<"),
        JSText.units("gt"): JSText.units(">"), JSText.units("quot"): JSText.units("\""),
        JSText.units("apos"): JSText.units("'"), JSText.units("nbsp"): [0xA0],
    ]

    /// The character reference opening at `i` (an `&`): its decoded units and
    /// its length, or nil when there is none to decode.
    private static func entity(_ s: ArraySlice<UInt16>, _ i: Int) -> (Units, Int)? {
        var j = i + 1
        guard j < s.endIndex else { return nil }
        if s[j] == c("#") {
            j += 1
            let hex = j < s.endIndex && (s[j] == c("x") || s[j] == c("X"))
            if hex { j += 1 }
            let start = j
            while j < s.endIndex, hex ? JSText.isHexDigit(s[j]) : JSText.isAsciiDigit(s[j]) { j += 1 }
            let n = j - start
            guard n >= 1, n <= (hex ? 6 : 7), j < s.endIndex, s[j] == c(";") else { return nil }
            let digits = String(decoding: s[start..<j], as: UTF16.self)
            let value = UInt32(digits, radix: hex ? 16 : 10) ?? 0
            // micromark's rule (`decodeNumeric` in shared/noteLinks.ts): the
            // code points no document may carry read as U+FFFD.
            let bad = value < 9 || value == 11 || (value > 13 && value < 32)
                || (value > 126 && value < 160)
                || (value > 55_295 && value < 57_344)
                || (value > 64_975 && value < 65_008)
                || (value & 65_535) == 65_535 || (value & 65_535) == 65_534
                || value > 1_114_111
            let units = bad ? [0xFFFD] : (JSText.fromCodePoint(value) ?? [0xFFFD])
            return (units, j + 1 - i)
        }
        guard JSText.isAsciiLetter(s[j]) else { return nil }
        let start = j
        j += 1
        while j < s.endIndex, JSText.isAsciiLetter(s[j]) || JSText.isAsciiDigit(s[j]) { j += 1 }
        let n = j - start
        guard n >= 2, n <= 32, j < s.endIndex, s[j] == c(";") else { return nil }
        guard let decoded = namedEntities[Array(s[start..<j])] else { return nil }
        return (decoded, j + 1 - i)
    }

    /// Backslash escapes of ASCII punctuation and character references, decoded.
    static func decodeMarkdownText(_ s: ArraySlice<UInt16>) -> Units {
        var out: Units = []
        out.reserveCapacity(s.count)
        var i = s.startIndex
        while i < s.endIndex {
            let ch = s[i]
            if ch == c("\\"), i + 1 < s.endIndex, isAsciiPunct(s[i + 1]) {
                out.append(s[i + 1])
                i += 2
                continue
            }
            if ch == c("&"), let (decoded, length) = entity(s, i) {
                out.append(contentsOf: decoded)
                i += length
                continue
            }
            out.append(ch)
            i += 1
        }
        return out
    }

    /// A reference label as CommonMark matches it: whitespace collapsed, case folded.
    static func normalizeLabel(_ label: ArraySlice<UInt16>) -> Units {
        var collapsed: Units = []
        var inRun = false
        for u in label {
            if u == c("\t") || u == c("\n") || u == c("\r") || u == c(" ") {
                if !inRun { collapsed.append(c(" ")) }
                inRun = true
            } else {
                collapsed.append(u)
                inRun = false
            }
        }
        return JSText.units(JSText.string(JSText.trim(collapsed[...])).lowercased().uppercased())
    }

    /// A label's text as the reader sees it.
    static func labelText(_ label: ArraySlice<UInt16>) -> Units {
        let decoded = decodeMarkdownText(label).filter { $0 != c("*") && $0 != c("_") && $0 != c("`") }
        var out: Units = []
        var inRun = false
        for u in decoded {
            if JSText.isSpace(u) {
                if !inRun { out.append(c(" ")) }
                inRun = true
            } else {
                out.append(u)
                inRun = false
            }
        }
        return JSText.trim(out)
    }

    // MARK: block pass

    private struct BlockPass {
        var mask: [Bool]
        var defs: [Units: Units]
    }

    private static let htmlRawTags = ["script", "pre", "style", "textarea"].map(JSText.units)
    private static let htmlBlockTags = [
        "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
        "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
        "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr",
        "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol",
        "optgroup", "option", "p", "param", "search", "section", "summary", "table", "tbody", "td", "tfoot",
        "th", "thead", "title", "tr", "track", "ul",
    ].map(JSText.units)

    /// Does `s` hold `name` at `at`, ASCII case-insensitively?
    private static func hasName(_ s: ArraySlice<UInt16>, _ at: Int, _ name: Units) -> Bool {
        guard at + name.count <= s.endIndex else { return false }
        for k in 0..<name.count where JSText.asciiLower(s[at + k]) != name[k] { return false }
        return true
    }

    /// `^(?:[ ]{0,3}>[ ]?)*`: how many units of blockquote markers open `line`.
    private static func quotePrefixLength(_ line: ArraySlice<UInt16>) -> Int {
        var pos = line.startIndex
        while true {
            var j = pos
            var spaces = 0
            while j < line.endIndex, line[j] == c(" "), spaces < 3 {
                j += 1
                spaces += 1
            }
            guard j < line.endIndex, line[j] == c(">") else { break }
            j += 1
            if j < line.endIndex, line[j] == c(" ") { j += 1 }
            pos = j
        }
        return pos - line.startIndex
    }

    /// `LIST_ITEM`: the marker's length, the spaces after it (1 when it ends
    /// the line), and the whole match's length.
    private static func listItem(_ t: ArraySlice<UInt16>) -> (marker: Int, spaces: Int, match: Int)? {
        let s = t.startIndex
        guard s < t.endIndex else { return nil }
        var m: Int
        if t[s] == c("-") || t[s] == c("*") || t[s] == c("+") {
            m = 1
        } else {
            var j = s
            while j < t.endIndex, JSText.isAsciiDigit(t[j]) { j += 1 }
            let digits = j - s
            guard digits >= 1, digits <= 9, j < t.endIndex, t[j] == c(".") || t[j] == c(")") else { return nil }
            m = digits + 1
        }
        var r = 0
        while s + m + r < t.endIndex, t[s + m + r] == c(" ") { r += 1 }
        if r >= 1, r <= 4, s + m + r < t.endIndex, !JSText.isSpace(t[s + m + r]) {
            return (m, r, m + r)
        }
        var k = s + m
        while k < t.endIndex, t[k] == c(" ") || t[k] == c("\t") { k += 1 }
        if k == t.endIndex { return (m, 1, t.count) }
        return nil
    }

    /// `FENCE_OPEN` and its "a backtick fence's info string holds no backtick" rule.
    private static func fenceOpen(_ t: ArraySlice<UInt16>) -> (char: UInt16, len: Int)? {
        guard let first = t.first, first == c("`") || first == c("~") else { return nil }
        var j = t.startIndex
        while j < t.endIndex, t[j] == first { j += 1 }
        let len = j - t.startIndex
        guard len >= 3 else { return nil }
        let rest = t[j...]
        if rest.contains(where: JSText.isLineTerminator) { return nil }
        if first == c("`"), rest.contains(c("`")) { return nil }
        return (first, len)
    }

    /// `FENCE_CLOSE`: a run of one fence character and nothing but blanks after it.
    private static func fenceClose(_ t: ArraySlice<UInt16>) -> (char: UInt16, len: Int)? {
        guard let first = t.first, first == c("`") || first == c("~") else { return nil }
        var j = t.startIndex
        while j < t.endIndex, t[j] == first { j += 1 }
        let len = j - t.startIndex
        guard len >= 3 else { return nil }
        while j < t.endIndex, t[j] == c(" ") || t[j] == c("\t") { j += 1 }
        return j == t.endIndex ? (first, len) : nil
    }

    /// `HTML_RAW_OPEN`: the tag's name as written, or nil.
    private static func htmlRawOpen(_ t: ArraySlice<UInt16>) -> Units? {
        let s = t.startIndex
        guard s < t.endIndex, t[s] == c("<") else { return nil }
        for name in htmlRawTags where hasName(t, s + 1, name) {
            let after = s + 1 + name.count
            if after == t.endIndex || JSText.isSpace(t[after]) || t[after] == c(">") {
                return Array(t[(s + 1)..<after])
            }
        }
        return nil
    }

    /// `HTML_BLOCK_OPEN`.
    private static func htmlBlockOpen(_ t: ArraySlice<UInt16>) -> Bool {
        var at = t.startIndex
        guard at < t.endIndex, t[at] == c("<") else { return false }
        at += 1
        if at < t.endIndex, t[at] == c("/") { at += 1 }
        for name in htmlBlockTags where hasName(t, at, name) {
            let after = at + name.count
            if after == t.endIndex || JSText.isSpace(t[after]) || t[after] == c(">") { return true }
            if t[after] == c("/"), after + 1 < t.endIndex, t[after + 1] == c(">") { return true }
        }
        return false
    }

    /// `HTML_TAG_LINE`: one complete open or close tag, and nothing after it but blanks.
    private static func htmlTagLine(_ t: ArraySlice<UInt16>) -> Bool {
        var j = t.startIndex
        guard j < t.endIndex, t[j] == c("<") else { return false }
        j += 1
        let closing = j < t.endIndex && t[j] == c("/")
        if closing { j += 1 }
        guard j < t.endIndex, JSText.isAsciiLetter(t[j]) else { return false }
        j += 1
        while j < t.endIndex, JSText.isAsciiLetter(t[j]) || JSText.isAsciiDigit(t[j]) || t[j] == c("-") { j += 1 }
        func restBlank(_ from: Int) -> Bool { t[from...].allSatisfy(JSText.isSpace) }
        if closing {
            while j < t.endIndex, JSText.isSpace(t[j]) { j += 1 }
            return j < t.endIndex && t[j] == c(">") && restBlank(j + 1)
        }
        guard j < t.endIndex else { return false }
        if t[j] == c(">") { return restBlank(j + 1) }
        if t[j] == c("/") { return j + 1 < t.endIndex && t[j + 1] == c(">") && restBlank(j + 2) }
        guard JSText.isSpace(t[j]) else { return false }
        var k = j + 1
        while k < t.endIndex, t[k] != c("<"), t[k] != c(">") { k += 1 }
        return k < t.endIndex && t[k] == c(">") && restBlank(k + 1)
    }

    /// `DEFINITION`: the raw label and destination of a link reference definition.
    private static func definition(_ t: ArraySlice<UInt16>) -> (label: ArraySlice<UInt16>, dest: ArraySlice<UInt16>)? {
        var j = t.startIndex
        guard j < t.endIndex, t[j] == c("[") else { return nil }
        j += 1
        guard j < t.endIndex, t[j] != c("^") else { return nil }
        let labelStart = j
        var items = 0
        while j < t.endIndex {
            let u = t[j]
            if u == c("]") || u == c("\n") { break }
            if u == c("\\") {
                guard j + 1 < t.endIndex, !JSText.isLineTerminator(t[j + 1]) else { break }
                j += 2
            } else {
                j += 1
            }
            items += 1
        }
        guard items >= 1, items <= 999, j + 1 < t.endIndex, t[j] == c("]"), t[j + 1] == c(":") else { return nil }
        let label = t[labelStart..<j]
        j += 2
        while j < t.endIndex, t[j] == c(" ") || t[j] == c("\t") { j += 1 }
        guard j < t.endIndex else { return nil }
        if t[j] == c("<") {
            var k = j + 1
            while k < t.endIndex, t[k] != c("<"), t[k] != c(">"), t[k] != c("\n") { k += 1 }
            if k < t.endIndex, t[k] == c(">") { return (label, t[(j + 1)..<k]) }
        }
        var k = j
        while k < t.endIndex, !JSText.isSpace(t[k]) { k += 1 }
        return k > j ? (label, t[j..<k]) : nil
    }

    /// `/^#{1,6}(?:\s|$)/`
    private static func isAtxHeading(_ t: ArraySlice<UInt16>) -> Bool {
        var j = t.startIndex
        while j < t.endIndex, t[j] == c("#") { j += 1 }
        let n = j - t.startIndex
        return n >= 1 && n <= 6 && (j == t.endIndex || JSText.isSpace(t[j]))
    }

    /// ASCII case-insensitive search for `needle` anywhere in `s`.
    private static func containsFolded(_ s: ArraySlice<UInt16>, _ needle: Units) -> Bool {
        guard s.count >= needle.count else { return false }
        var i = s.startIndex
        while i + needle.count <= s.endIndex {
            if hasName(s, i, needle) { return true }
            i += 1
        }
        return false
    }

    private enum HtmlUntil { case blank, closer(Units) }

    private static func blockPass(_ body: Units) -> BlockPass {
        var mask = [Bool](repeating: false, count: body.count)
        var defs: [Units: Units] = [:]
        var fence: (char: UInt16, len: Int)?
        var math = false
        var html: HtmlUntil?
        var listIndent = 0
        var inParagraph = false
        var pos = 0
        while pos <= body.count {
            let nl = JSText.indexOf(body, c("\n"), from: pos)
            let end = nl < 0 ? body.count : nl
            var lineEnd = end
            if lineEnd > pos, body[lineEnd - 1] == c("\r") { lineEnd -= 1 }
            let line = body[pos..<lineEnd]
            let rest = line.dropFirst(quotePrefixLength(line))
            var cols = 0
            var chars = rest.startIndex
            while chars < rest.endIndex, rest[chars] == c(" ") || rest[chars] == c("\t") {
                cols = rest[chars] == c("\t") ? cols + 4 - (cols % 4) : cols + 1
                chars += 1
            }
            var text = rest[chars...]
            let blank = text.isEmpty
            let maskLine = { for k in pos..<end { mask[k] = true } }
            defer { pos = nl < 0 ? body.count + 1 : nl + 1 }

            if let open = fence {
                maskLine()
                if let close = fenceClose(text), close.char == open.char, close.len >= open.len { fence = nil }
                continue
            }
            if math {
                maskLine()
                if JSText.indexOf(Array(text), JSText.units("$$")) >= 0 { math = false }
                continue
            }
            if let until = html {
                switch until {
                case .blank:
                    if blank { html = nil } else { maskLine() }
                case let .closer(closer):
                    maskLine()
                    if containsFolded(line, closer) { html = nil }
                }
                continue
            }
            if blank {
                inParagraph = false
                continue
            }

            let item = (cols - listIndent <= 3 || listIndent == 0) ? listItem(text) : nil
            if listIndent > 0, cols < listIndent, item == nil, !inParagraph { listIndent = 0 }
            let relative = listIndent > 0 && cols >= listIndent ? cols - listIndent : cols

            if relative >= 4, !inParagraph, item == nil {
                maskLine()
                continue
            }
            if let item {
                listIndent = cols + item.marker + item.spaces
                text = text.dropFirst(item.match)
                inParagraph = false
            }

            if let open = fenceOpen(text) {
                fence = open
                inParagraph = false
                maskLine()
            } else if JSText.startsWith(text, JSText.units("$$")) {
                if JSText.indexOf(Array(text.dropFirst(2)), JSText.units("$$")) < 0 { math = true }
                inParagraph = false
                maskLine()
            } else if let tag = htmlRawOpen(text) {
                let closer = JSText.units("</") + tag.map(JSText.asciiLower) + JSText.units(">")
                if !containsFolded(text, closer) { html = .closer(closer) }
                inParagraph = false
                maskLine()
            } else if htmlBlockOpen(text) || (!inParagraph && htmlTagLine(text)) {
                html = .blank
                inParagraph = false
                maskLine()
            } else if !inParagraph, let def = definition(text) {
                let label = normalizeLabel(def.label)
                if defs[label] == nil { defs[label] = decodeMarkdownText(def.dest) }
                maskLine()
            } else {
                inParagraph = !isAtxHeading(text)
            }
        }
        return BlockPass(mask: mask, defs: defs)
    }

    // MARK: inline pass

    private static func blankLineAt(_ s: Units, _ i: Int) -> Bool {
        guard i < s.count, s[i] == c("\n") else { return false }
        var j = i + 1
        while j < s.count, s[j] == c(" ") || s[j] == c("\t") || s[j] == c("\r") { j += 1 }
        return j >= s.count || s[j] == c("\n")
    }

    private static func tickRun(_ s: Units, _ i: Int) -> Int {
        var j = i
        while j < s.count, s[j] == c("`") { j += 1 }
        return j - i
    }

    private static func codeSpanEnd(_ s: Units, _ i: Int, _ mask: [Bool]) -> Int {
        let n = tickRun(s, i)
        var j = i + n
        while j < s.count {
            if mask[j] || blankLineAt(s, j) { return -1 }
            if s[j] == c("`") {
                let m = tickRun(s, j)
                if m == n { return j + m }
                j += m
                continue
            }
            j += 1
        }
        return -1
    }

    private static func labelEnd(_ s: Units, _ open: Int, _ mask: [Bool]) -> Int {
        var depth = 0
        var j = open
        while j < s.count {
            if mask[j] || blankLineAt(s, j) { return -1 }
            let ch = s[j]
            if ch == c("\\") {
                j += 2
                continue
            }
            if ch == c("`") {
                let end = codeSpanEnd(s, j, mask)
                j = end > 0 ? end : j + tickRun(s, j)
                continue
            }
            if ch == c("[") {
                depth += 1
            } else if ch == c("]") {
                depth -= 1
                if depth == 0 { return j }
            }
            j += 1
        }
        return -1
    }

    private static func inlineDestination(_ s: Units, _ open: Int) -> (dest: ArraySlice<UInt16>, end: Int)? {
        var j = open + 1
        func skipSpace() {
            var newlines = 0
            while j < s.count, s[j] == c(" ") || s[j] == c("\t") || s[j] == c("\r") || s[j] == c("\n") {
                if s[j] == c("\n") {
                    newlines += 1
                    if newlines > 1 { return }
                }
                j += 1
            }
        }
        skipSpace()
        let dest: ArraySlice<UInt16>
        if j < s.count, s[j] == c("<") {
            let close = JSText.indexOf(s, c(">"), from: j + 1)
            if close < 0 { return nil }
            dest = s[(j + 1)..<close]
            if dest.contains(c("\n")) || dest.contains(c("<")) { return nil }
            j = close + 1
        } else {
            let start = j
            var depth = 0
            while j < s.count {
                let ch = s[j]
                if ch == c("\\"), j + 1 < s.count {
                    j += 2
                    continue
                }
                if JSText.isSpace(ch) || ch <= 0x1F { break }
                if ch == c("(") {
                    depth += 1
                } else if ch == c(")") {
                    if depth == 0 { break }
                    depth -= 1
                }
                j += 1
            }
            if depth != 0 { return nil }
            dest = s[start..<min(j, s.count)]
        }
        let afterDest = j
        skipSpace()
        if j > afterDest, j < s.count, s[j] == c("\"") || s[j] == c("'") || s[j] == c("(") {
            let closer = s[j] == c("(") ? c(")") : s[j]
            j += 1
            while j < s.count, s[j] != closer {
                if s[j] == c("\\") { j += 1 }
                j += 1
            }
            if j >= s.count { return nil }
            j += 1
            skipSpace()
        }
        guard j < s.count, s[j] == c(")") else { return nil }
        return (dest, j + 1)
    }

    private static func wikiAt(_ s: Units, _ i: Int) -> (raw: ArraySlice<UInt16>, end: Int)? {
        guard i + 1 < s.count, s[i] == c("["), s[i + 1] == c("[") else { return nil }
        var j = i + 2
        while j < s.count, s[j] != c("["), s[j] != c("]"), s[j] != c("\n"), s[j] != c("\r") { j += 1 }
        guard j > i + 2, j + 1 < s.count, s[j] == c("]"), s[j + 1] == c("]") else { return nil }
        if j + 2 < s.count, s[j + 2] == c("(") { return nil }
        return (s[(i + 2)..<j], j + 2)
    }

    /// `IMAGE_ONLY_LABEL`: a label that is one image and nothing else.
    private static func isImageOnlyLabel(_ label: ArraySlice<UInt16>) -> Bool {
        var j = label.startIndex
        while j < label.endIndex, JSText.isSpace(label[j]) { j += 1 }
        guard j + 1 < label.endIndex, label[j] == c("!"), label[j + 1] == c("[") else { return false }
        j += 2
        while j < label.endIndex, label[j] != c("]") { j += 1 }
        guard j + 1 < label.endIndex, label[j + 1] == c("(") else { return false }
        j += 2
        while j < label.endIndex, label[j] != c(")") { j += 1 }
        guard j < label.endIndex else { return false }
        return label[(j + 1)...].allSatisfy(JSText.isSpace)
    }

    private static func inlinePass(_ body: Units, _ pass: BlockPass) -> [(at: Int, href: Units, text: Units, wiki: Bool)] {
        let mask = pass.mask
        var out: [(at: Int, href: Units, text: Units, wiki: Bool)] = []
        let commentOpen = JSText.units("<!--")
        let commentClose = JSText.units("-->")
        var i = 0
        while i < body.count {
            if mask[i] {
                i += 1
                continue
            }
            let ch = body[i]
            if ch == c("\\") {
                i += 2
                continue
            }
            if ch == c("`") {
                let end = codeSpanEnd(body, i, mask)
                i = end > 0 ? end : i + tickRun(body, i)
                continue
            }
            if ch == c("<"), JSText.startsWith(body, commentOpen, at: i) {
                let close = JSText.indexOf(body, commentClose, from: i + 4)
                i = close < 0 ? body.count : close + 3
                continue
            }
            let image = ch == c("!") && i + 1 < body.count && body[i + 1] == c("[")
            if ch != c("["), !image {
                i += 1
                continue
            }
            let open = image ? i + 1 : i
            if !image, let wiki = wikiAt(body, open) {
                let raw = Array(wiki.raw)
                out.append((open, WikiRaw.href(raw), WikiRaw.displayText(raw), true))
                i = wiki.end
                continue
            }
            let close = labelEnd(body, open, mask)
            if close < 0 {
                i = open + 1
                continue
            }
            let label = body[(open + 1)..<close]
            var href: Units?
            var end = close + 1
            if close + 1 < body.count, body[close + 1] == c("("), let dest = inlineDestination(body, close + 1) {
                href = decodeMarkdownText(dest.dest)
                end = dest.end
            }
            if href == nil, close + 1 < body.count, body[close + 1] == c("[") {
                let refClose = labelEnd(body, close + 1, mask)
                if refClose > 0 {
                    let ref = body[(close + 2)..<refClose]
                    if let def = pass.defs[normalizeLabel(ref.isEmpty ? label : ref)] {
                        href = def
                        end = refClose + 1
                    }
                }
            }
            if href == nil, label.first != c("^"), let def = pass.defs[normalizeLabel(label)] {
                href = def
            }
            guard let found = href else {
                i = open + 1
                continue
            }
            if !image, !isImageOnlyLabel(label) {
                out.append((open, found, labelText(label), false))
            }
            i = end
        }
        return out
    }

    // MARK: entry points

    /// Every body link the page scanner would report, local or not, in source
    /// order, positions in UTF-16 units.
    public static func scanBodyLinks(_ body: String) -> [BodyLink] {
        let units = JSText.units(body)
        return inlinePass(units, blockPass(units)).map {
            BodyLink(at: $0.at, href: JSText.string($0.href), text: JSText.string($0.text), wiki: $0.wiki)
        }
    }

    private static func readMeta(_ entries: [FrontmatterTable.Entry]?) -> Meta {
        var meta = Meta()
        guard let entries else { return meta }
        func scalar(_ key: String) -> String? {
            guard let entry = FrontmatterTable.find(entries, key), entry.list == nil, entry.nested == nil else { return nil }
            let value = FrontmatterTable.unquote(entry.value)
            return value.isEmpty ? nil : JSText.string(value)
        }
        meta.title = scalar("title")
        meta.type = scalar("type")
        if let tags = FrontmatterTable.find(entries, "tags") {
            if let list = tags.list {
                meta.tags = list.filter { !$0.isEmpty }.map(JSText.string)
            } else if tags.nested == nil {
                let one = FrontmatterTable.unquote(tags.value)
                if !one.isEmpty { meta.tags = [JSText.string(one)] }
            }
        }
        if let provenance = FrontmatterTable.provenance(entries) {
            meta.status = provenance.status?.rawValue
            meta.trust = provenance.trust?.rawValue
            meta.staleAfter = provenance.staleAfter
        }
        return meta
    }

    private static func readSources(_ entries: [FrontmatterTable.Entry]?, _ frontmatter: Units) -> [Ref] {
        guard let items = entries.flatMap({ FrontmatterTable.find($0, "sources") })?.nested else { return [] }
        let lines = JSText.split(frontmatter, c("\n"))
        var out: [Ref] = []
        for item in items {
            guard let leaf = item.leaves.first(where: { $0.key == JSText.units("resource") }) else { continue }
            let href = FrontmatterTable.unquote(leaf.value)
            guard isNoteHref(href) else { continue }
            let title = item.leaves.first { $0.key == JSText.units("title") }
            let source = leaf.origLine ?? item.origLine
            let lineIdx = source.flatMap { s in lines.firstIndex(of: s) } ?? -1
            out.append(Ref(
                kind: .source,
                href: JSText.string(href),
                path: JSText.string(hrefPath(href)),
                text: JSText.string(title.map { FrontmatterTable.unquote($0.value) } ?? href),
                line: lineIdx >= 0 ? lineIdx + 1 : 1))
        }
        return out
    }

    /// One note's references to other notes, and its attributes.
    public static func readNote(_ content: String) -> Reading {
        let split = Frontmatter.split(content)
        let frontmatter = JSText.units(split.frontmatter)
        let body = JSText.units(split.body)
        let entries = frontmatter.isEmpty ? nil : FrontmatterTable.parse(frontmatter)
        let bodyLine0 = frontmatter.isEmpty ? 0 : frontmatter.filter { $0 == c("\n") }.count

        var starts = [0]
        for (i, u) in body.enumerated() where u == c("\n") { starts.append(i + 1) }
        func lineOf(_ at: Int) -> Int {
            var lo = 0
            var hi = starts.count - 1
            while lo < hi {
                let mid = (lo + hi + 1) >> 1
                if starts[mid] <= at { lo = mid } else { hi = mid - 1 }
            }
            return bodyLine0 + lo + 1
        }

        var links = readSources(entries, frontmatter)
        for link in inlinePass(body, blockPass(body)) where isNoteHref(link.href) {
            links.append(Ref(
                kind: link.wiki ? .wiki : .link,
                href: JSText.string(link.href),
                path: JSText.string(hrefPath(link.href)),
                text: JSText.string(link.text),
                line: lineOf(link.at)))
        }
        return Reading(links: links, meta: readMeta(entries))
    }
}

/// The reading of a wikilink's raw inner bytes (`target#heading|alias`): a port
/// of `shared/wikiRaw.ts`, which the page's wikilink node splits with too.
enum WikiRaw {
    typealias Units = JSText.Units
    private static let c = JSText.c

    struct Parts: Equatable {
        var target: Units
        var heading: Units?
        var alias: Units?
    }

    private static func unescapePipes(_ s: ArraySlice<UInt16>) -> Units {
        var out: Units = []
        var i = s.startIndex
        while i < s.endIndex {
            if s[i] == c("\\"), i + 1 < s.endIndex, s[i + 1] == c("|") {
                out.append(c("|"))
                i += 2
                continue
            }
            out.append(s[i])
            i += 1
        }
        return out
    }

    static func parse(_ raw: Units) -> Parts {
        var pipe = -1
        var i = 0
        while i < raw.count {
            if raw[i] == c("\\") {
                i += 2
                continue
            }
            if raw[i] == c("|") {
                pipe = i
                break
            }
            i += 1
        }
        let targetPart = pipe >= 0 ? raw[0..<pipe] : raw[...]
        let aliasPart = pipe >= 0 ? raw[(pipe + 1)...] : nil
        let hash = targetPart.firstIndex(of: c("#"))
        let target = JSText.trim(unescapePipes(hash.map { targetPart[..<$0] } ?? targetPart))
        let heading = hash.map { JSText.trim(unescapePipes(targetPart[($0 + 1)...])) }
        let alias = aliasPart.map { JSText.trim(unescapePipes($0)) }
        return Parts(target: target, heading: heading, alias: alias)
    }

    /// `target#heading`, as the page scanner forms a wikilink's href.
    static func href(_ raw: Units) -> Units {
        let parts = parse(raw)
        guard let heading = parts.heading, !heading.isEmpty else { return parts.target }
        return parts.target + [c("#")] + heading
    }

    /// The text a wikilink displays.
    static func displayText(_ raw: Units) -> Units {
        let parts = parse(raw)
        if let alias = parts.alias, !alias.isEmpty { return alias }
        let text = parts.heading.map { !$0.isEmpty ? parts.target + [c("#")] + $0 : parts.target } ?? parts.target
        return JSText.trim(text).isEmpty ? JSText.units("[[") + raw + JSText.units("]]") : text
    }
}
