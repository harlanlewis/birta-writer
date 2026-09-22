import Foundation

/// The READING half of `parseTabularFrontmatter` (shared/frontmatterTable.ts)
/// and the Open Knowledge Format's provenance reads over it (`readOkfProvenance`,
/// shared/okf.ts), for the folder index (`NoteLinks.readNote`).
///
/// A port of the parser's accept/refuse decisions and of the values it keeps,
/// and of nothing it keeps for writing: quote styles, spans and indentation
/// exist for the panel's serializer, which this host does not run. What it
/// must reproduce exactly is WHICH blocks parse, because a block the parser
/// refuses yields no title, no type and no `sources` at all, so a refusal
/// the two sides disagree on is a note whose edges differ between the hosts.
/// `NoteLinksGoldenTests` holds this to the TypeScript's answers over the
/// golden file `shared/__tests__/noteLinksGolden.test.ts` writes.
enum FrontmatterTable {
    typealias Units = JSText.Units

    struct Leaf: Equatable {
        var key: Units
        var value: Units
        var origLine: Units?
    }

    struct Item: Equatable {
        var leaves: [Leaf]
        var origLine: Units?
    }

    struct Entry: Equatable {
        var key: Units
        var value: Units
        /// The list's item values, present (possibly empty) when the value is a list.
        var list: [Units]?
        /// The mappings under a nested value, present when it is one.
        var nested: [Item]?
    }

    private static let c = JSText.c

    // MARK: scalars

    /// `parseQuotedToken(token).value`.
    static func unquoteToken(_ token: Units) -> (value: Units, quoted: Bool) {
        if token.count >= 2, token.first == c("\""), token.last == c("\"") {
            // `.replace(/\\(.)/g, "$1")`: `.` stops at a line terminator.
            var out: Units = []
            let inner = token[1..<(token.count - 1)]
            var i = inner.startIndex
            while i < inner.endIndex {
                if inner[i] == c("\\"), i + 1 < inner.endIndex, !JSText.isLineTerminator(inner[i + 1]) {
                    out.append(inner[i + 1])
                    i += 2
                    continue
                }
                out.append(inner[i])
                i += 1
            }
            return (out, true)
        }
        if token.count >= 2, token.first == c("'"), token.last == c("'") {
            return (Array(token[1..<(token.count - 1)]), true)
        }
        return (JSText.trim(token), false)
    }

    /// A leaf's or entry's value with its quotes taken off (`unquote` in okf.ts and noteLinks.ts).
    static func unquote(_ value: Units) -> Units {
        unquoteToken(JSText.trim(value)).value
    }

    private static func isSafeScalarValue(_ value: Units) -> Bool {
        guard let v0 = value.first else { return true }
        if JSText.units("|>&*[{#!%@`").contains(v0) { return false }
        if JSText.hasSpaceHash(value[...]) { return false }
        if v0 == c("\"") || v0 == c("'") {
            return value.count >= 2 && value.last == v0
        }
        return true
    }

    /// Split a single-line flow sequence body on top-level commas, respecting quotes.
    private static func splitInlineFlow(_ body: ArraySlice<UInt16>) -> [Units]? {
        var parts: [Units] = []
        var cur: Units = []
        var quote: UInt16?
        var i = body.startIndex
        while i < body.endIndex {
            let ch = body[i]
            if let q = quote {
                cur.append(ch)
                if q == c("\""), ch == c("\\") {
                    i += 1
                    if i < body.endIndex { cur.append(body[i]) }
                    i += 1
                    continue
                }
                if ch == q { quote = nil }
            } else if ch == c("\"") || ch == c("'") {
                quote = ch
                cur.append(ch)
            } else if JSText.units("[]{}#").contains(ch) {
                return nil
            } else if ch == c(",") {
                parts.append(cur)
                cur = []
            } else {
                cur.append(ch)
            }
            i += 1
        }
        if quote != nil { return nil }
        parts.append(cur)
        return parts
    }

    private static func isNestedLeafValue(_ value: Units) -> Bool {
        guard let v0 = value.first else { return false }
        if value.contains(c("\r")) || value.contains(c("\n")) { return false }
        if value == [c("-")] || JSText.startsWith(value, JSText.units("- ")) { return false }
        if JSText.units("|>&*{#!%@`").contains(v0) { return false }
        if JSText.hasSpaceHash(value[...]) { return false }
        if v0 == c("\"") || v0 == c("'") {
            return value.count >= 2 && value.last == v0
        }
        if v0 == c("[") {
            return value.last == c("]") && value.count >= 2 && splitInlineFlow(value[1..<(value.count - 1)]) != nil
        }
        return true
    }

    /// A key before the first colon, refused as `parseTabularFrontmatter` refuses one.
    private static func keyAndValue(_ text: Units) -> (key: Units, value: Units)? {
        let colon = JSText.indexOf(text, c(":"))
        if colon <= 0 { return nil }
        if colon + 1 < text.count, text[colon + 1] != c(" "), text[colon + 1] != c("\t") { return nil }
        let key = text[0..<colon]
        if JSText.trim(key).isEmpty || key.contains(where: { $0 == c("\"") || $0 == c("'") || $0 == c("#") }) { return nil }
        return (Array(JSText.trim(key)), Array(JSText.trim(text[(colon + 1)...])))
    }

    private static func parseNestedPair(_ text: Units) -> Leaf? {
        guard let (key, value) = keyAndValue(text), isNestedLeafValue(value) else { return nil }
        return Leaf(key: key, value: value, origLine: nil)
    }

    private static func parseFlowMap(_ text: Units) -> [Leaf]? {
        let t = JSText.trim(text)
        guard t.count >= 2, t.first == c("{"), t.last == c("}") else { return nil }
        let body = t[1..<(t.count - 1)]
        if JSText.trim(body).isEmpty { return nil }
        guard let parts = splitInlineFlow(body) else { return nil }
        var leaves: [Leaf] = []
        for part in parts {
            guard let pair = parseNestedPair(JSText.trim(part)) else { return nil }
            leaves.append(pair)
        }
        return leaves
    }

    private static func isMappingToken(_ token: Units, quoted: Bool) -> Bool {
        if quoted { return false }
        let colon = JSText.indexOf(token, c(":"))
        if colon <= 0 { return false }
        return colon + 1 >= token.count || token[colon + 1] == c(" ") || token[colon + 1] == c("\t")
    }

    private static func startsWithSpaceOrTab(_ s: Units) -> Bool {
        guard let first = s.first else { return false }
        return first == c(" ") || first == c("\t")
    }

    private static func leadingSpaceOrTab(_ s: Units) -> Units {
        Array(s.prefix { $0 == c(" ") || $0 == c("\t") })
    }

    private static func isBlank(_ s: Units) -> Bool { JSText.trim(s).isEmpty }

    /// `^(\s*)- (.*)$`: the indentation and the item text, or nil.
    private static func blockItem(_ l: Units) -> (indent: Units, rest: Units)? {
        var k = 0
        while k < l.count, JSText.isSpace(l[k]) { k += 1 }
        guard k + 1 < l.count, l[k] == c("-"), l[k + 1] == c(" ") else { return nil }
        let rest = Array(l[(k + 2)...])
        if rest.contains(where: JSText.isLineTerminator) { return nil }
        return (Array(l[0..<k]), rest)
    }

    /// `FLOW_ITEM_RE`: one flow-sequence item alone on its line; the token, or nil.
    private static func flowItemToken(_ l: Units) -> Units? {
        var k = 0
        while k < l.count, JSText.isSpace(l[k]) { k += 1 }
        guard k < l.count else { return nil }
        let s = l[k...]
        /// `\s*(,?)\s*$` over what follows the token.
        func tailMatches(_ from: Int) -> Bool {
            var j = from
            while j < s.endIndex, JSText.isSpace(s[j]) { j += 1 }
            if j < s.endIndex, s[j] == c(",") { j += 1 }
            while j < s.endIndex, JSText.isSpace(s[j]) { j += 1 }
            return j == s.endIndex
        }
        let first = s[k]
        if first == c("\"") {
            var j = k + 1
            while j < s.endIndex {
                if s[j] == c("\\") {
                    guard j + 1 < s.endIndex, !JSText.isLineTerminator(s[j + 1]) else { return nil }
                    j += 2
                    continue
                }
                if s[j] == c("\"") { break }
                j += 1
            }
            guard j < s.endIndex, tailMatches(j + 1) else { return nil }
            return Array(s[k...j])
        }
        if first == c("'") {
            guard let close = s[(k + 1)...].firstIndex(of: c("'")), tailMatches(close + 1) else { return nil }
            return Array(s[k...close])
        }
        let refusedFirst = JSText.units(",[]{}#\"'")
        if JSText.isSpace(first) || refusedFirst.contains(first) { return nil }
        // The lazy body is the shortest one the tail accepts, which is the
        // one that leaves the longest tail: strip `\s* ,? \s*` off the end.
        var end = s.endIndex
        while end > k + 1, JSText.isSpace(s[end - 1]) { end -= 1 }
        if end > k + 1, s[end - 1] == c(",") { end -= 1 }
        while end > k + 1, JSText.isSpace(s[end - 1]) { end -= 1 }
        let refusedBody = JSText.units(",[]{}#")
        if s[(k + 1)..<end].contains(where: { refusedBody.contains($0) }) { return nil }
        return Array(s[k..<end])
    }

    private static func endsWithComma(_ l: Units) -> Bool {
        var end = l.count
        while end > 0, JSText.isSpace(l[end - 1]) { end -= 1 }
        return end > 0 && l[end - 1] == c(",")
    }

    private static func parseNestedBlock(_ lines: [Units], _ start: Int) -> (items: [Item], next: Int)? {
        guard start < lines.count, !isBlank(lines[start]) else { return nil }
        let first = lines[start]
        let indent = leadingSpaceOrTab(first)
        let dashPrefix = indent + JSText.units("- ")
        if JSText.startsWith(first, dashPrefix) {
            let leafPrefix = indent + JSText.units("  ")
            var items: [Item] = []
            var j = start
            while j < lines.count {
                let line = lines[j]
                if isBlank(line) { break }
                if !JSText.startsWith(line, dashPrefix) {
                    if startsWithSpaceOrTab(line) { return nil }
                    break
                }
                let head = Array(line[dashPrefix.count...])
                if head.first == c("{") {
                    guard let leaves = parseFlowMap(head) else { return nil }
                    items.append(Item(leaves: leaves, origLine: line))
                    j += 1
                    continue
                }
                guard var head0 = parseNestedPair(head) else { return nil }
                head0.origLine = line
                var leaves = [head0]
                j += 1
                while j < lines.count {
                    let cont = lines[j]
                    if isBlank(cont) || !JSText.startsWith(cont, leafPrefix) { break }
                    let rest = Array(cont[leafPrefix.count...])
                    if startsWithSpaceOrTab(rest) { return nil }
                    guard var pair = parseNestedPair(rest) else { return nil }
                    pair.origLine = cont
                    leaves.append(pair)
                    j += 1
                }
                items.append(Item(leaves: leaves, origLine: nil))
            }
            if items.isEmpty { return nil }
            return (items, j)
        }
        if indent.isEmpty { return nil }
        var leaves: [Leaf] = []
        var j = start
        while j < lines.count {
            let line = lines[j]
            if isBlank(line) || !JSText.startsWith(line, indent) { break }
            let rest = Array(line[indent.count...])
            if startsWithSpaceOrTab(rest) { return nil }
            guard var pair = parseNestedPair(rest) else { return nil }
            pair.origLine = line
            leaves.append(pair)
            j += 1
        }
        if leaves.isEmpty { return nil }
        return ([Item(leaves: leaves, origLine: nil)], j)
    }

    /// The inner text of a `---` block, or nil for anything `splitFences`
    /// refuses or that is not YAML.
    private static func yamlInner(_ raw: Units) -> Units? {
        let open = JSText.units("---\n")
        guard JSText.startsWith(raw, open) else { return nil }
        // `([\s\S]*?)(\r?\n\2\r?\n?)$` with no `\r` anywhere: the shortest
        // inner, so the longer closing fence is preferred when both fit.
        for close in [JSText.units("\n---\n"), JSText.units("\n---")] where JSText.endsWith(raw[...], close) {
            let end = raw.count - close.count
            if end >= open.count { return Array(raw[open.count..<end]) }
        }
        return nil
    }

    /// `parseTabularFrontmatter(raw)`, keeping only what a reader needs.
    static func parse(_ raw: Units) -> [Entry]? {
        if raw.contains(c("\r")) { return nil }
        guard let inner = yamlInner(raw) else { return nil }
        let lines = inner.isEmpty ? [] : JSText.split(inner, c("\n"))
        var entries: [Entry] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if isBlank(line) {
                i += 1
                continue
            }
            if startsWithSpaceOrTab(line) { return nil }
            let first = line[0]
            if first == c("#") || first == c("?") || first == c("%") || first == c("!") { return nil }
            if line == [c("-")] || JSText.startsWith(line, JSText.units("- ")) { return nil }
            guard let (key, value) = keyAndValue(line) else { return nil }

            if value.first == c("[") {
                guard value.last == c("]"), value.count >= 2 else { return nil }
                let body = value[1..<(value.count - 1)]
                let parts: [Units]
                if JSText.trim(body).isEmpty {
                    parts = []
                } else {
                    guard let split = splitInlineFlow(body) else { return nil }
                    parts = split
                }
                var items: [Units] = []
                for part in parts {
                    let token = JSText.trim(part)
                    if token.isEmpty { return nil }
                    let (v, quoted) = unquoteToken(token)
                    if !quoted, !isSafeScalarValue(v) { return nil }
                    if isMappingToken(v, quoted: quoted) { return nil }
                    items.append(v)
                }
                entries.append(Entry(key: key, value: [], list: items, nested: nil))
                i += 1
                continue
            }

            if value.isEmpty {
                let nextLine: Units? = i + 1 < lines.count ? lines[i + 1] : nil
                if let nextLine, isFlowOpen(nextLine) {
                    var items: [Units] = []
                    var itemLines: [Units] = []
                    var j = i + 2
                    var closed = false
                    while j < lines.count {
                        let l = lines[j]
                        if isFlowClose(l) {
                            closed = true
                            break
                        }
                        guard let token = flowItemToken(l) else { return nil }
                        let (v, quoted) = unquoteToken(token)
                        if !quoted, !isSafeScalarValue(v) { return nil }
                        if isMappingToken(v, quoted: quoted) { return nil }
                        items.append(v)
                        itemLines.append(l)
                        j += 1
                    }
                    if !closed { return nil }
                    if !itemLines.isEmpty {
                        let all = itemLines.allSatisfy(endsWithComma)
                        let exceptLast = itemLines.dropLast().allSatisfy(endsWithComma) && !endsWithComma(itemLines.last!)
                        if !all && !exceptLast { return nil }
                    }
                    entries.append(Entry(key: key, value: [], list: items, nested: nil))
                    i = j + 1
                    continue
                }

                if let nested = parseNestedBlock(lines, i + 1) {
                    entries.append(Entry(key: key, value: [], list: nil, nested: nested.items))
                    i = nested.next
                    continue
                }

                if let nextLine, let head = blockItem(nextLine) {
                    var items: [Units] = []
                    var j = i + 1
                    while j < lines.count {
                        guard let m = blockItem(lines[j]) else { break }
                        if m.indent != head.indent { return nil }
                        let token = JSText.trim(m.rest)
                        if token.isEmpty || JSText.startsWith(token, JSText.units("- ")) { return nil }
                        let (v, quoted) = unquoteToken(token)
                        if !quoted, !isSafeScalarValue(v) { return nil }
                        if !quoted, JSText.hasSpaceHash(v[...]) { return nil }
                        if isMappingToken(v, quoted: quoted) { return nil }
                        items.append(v)
                        j += 1
                    }
                    entries.append(Entry(key: key, value: [], list: items, nested: nil))
                    i = j
                    continue
                }

                entries.append(Entry(key: key, value: [], list: nil, nested: nil))
                i += 1
                continue
            }

            if value.first == c("{") {
                guard let leaves = parseFlowMap(value) else { return nil }
                entries.append(Entry(key: key, value: [], list: nil, nested: [Item(leaves: leaves, origLine: line)]))
                i += 1
                continue
            }

            if !isSafeScalarValue(value) { return nil }
            entries.append(Entry(key: key, value: value, list: nil, nested: nil))
            i += 1
        }
        return entries
    }

    /// `^(\s*)\[\s*$`
    private static func isFlowOpen(_ l: Units) -> Bool {
        let t = JSText.trim(l)
        return t == [c("[")] && !l.isEmpty && isAllSpaceAround(l, c("["))
    }

    /// `^\s*\]\s*$`
    private static func isFlowClose(_ l: Units) -> Bool {
        JSText.trim(l) == [c("]")] && isAllSpaceAround(l, c("]"))
    }

    /// Everything but the one `mark` in `l` is `\s`.
    private static func isAllSpaceAround(_ l: Units, _ mark: UInt16) -> Bool {
        l.filter { $0 == mark }.count == 1 && l.allSatisfy { $0 == mark || JSText.isSpace($0) }
    }

    // MARK: the Open Knowledge Format's provenance (shared/okf.ts)

    enum Status: String { case draft, stable, deprecated }
    enum Trust: String { case unverified, machine, human }

    struct Provenance: Equatable {
        var status: Status?
        var staleAfter: String?
        var trust: Trust?
    }

    static func find(_ entries: [Entry], _ key: String) -> Entry? {
        let k = JSText.units(key)
        return entries.first { $0.key == k }
    }

    static func leaf(_ item: Item, _ key: String) -> Units? {
        let k = JSText.units(key)
        return item.leaves.first { $0.key == k }.map { unquote($0.value) }
    }

    private static func readTrust(_ entries: [Entry]) -> Trust? {
        if let verified = find(entries, "verified") {
            let actors = (verified.nested ?? []).compactMap { leaf($0, "by") }.filter { !$0.isEmpty }
            if actors.contains(where: { JSText.startsWith($0, JSText.units("human:")) }) { return .human }
            if !actors.isEmpty { return .machine }
            return .unverified
        }
        return find(entries, "generated") != nil ? .unverified : nil
    }

    /// `readOkfProvenance(entries)`.
    static func provenance(_ entries: [Entry]) -> Provenance? {
        let statusValue = JSText.string(unquote(find(entries, "status")?.value ?? []))
        let status = Status(rawValue: statusValue)
        let staleRaw = unquote(find(entries, "stale_after")?.value ?? [])
        let staleAfter = staleRaw.isEmpty ? nil : JSText.string(staleRaw)
        let trust = readTrust(entries)
        if status == nil && staleAfter == nil && trust == nil { return nil }
        return Provenance(status: status, staleAfter: staleAfter, trust: trust)
    }
}
