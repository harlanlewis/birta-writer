import Foundation

/// The page title and description a link card shows, parsed from HTML.
///
/// A port of `src/utils/openGraph.ts`, and deliberately the same shape: two
/// narrow regexes plus entity decoding, no DOM parser. The only thing wanted
/// is a title and a description, which live in a handful of `<meta>` tags near
/// the top of `<head>`, and a real parser would be a large dependency and a
/// much larger attack surface for a value that is then reduced to plain text
/// anyway. Nothing here can hang on a hostile page: the caller caps the bytes
/// before this sees them.
///
/// Everything returned is sanitized: entities decoded, control characters and
/// newlines collapsed to spaces, trimmed, and length-capped. `nil` means the
/// page carried nothing usable, which the caller shows as a plain link.
public enum OpenGraph {
    /// Hard cap on a returned string, in characters, after sanitizing.
    public static let maxLength = 300

    /// The named entities worth decoding for a title. Numeric references are
    /// handled by code point; an unknown name is left verbatim, because a
    /// literal `&frob;` reads better than a hole where text was.
    static let namedEntities: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ",
        "mdash": "\u{2014}", "ndash": "\u{2013}", "hellip": "\u{2026}",
        "lsquo": "\u{2018}", "rsquo": "\u{2019}", "ldquo": "\u{201C}", "rdquo": "\u{201D}",
    ]

    public static func decodeHtmlEntities(_ input: String) -> String {
        guard input.contains("&") else { return input }
        let pattern = "&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return input }
        let ns = input as NSString
        var out = ""
        var last = 0
        re.enumerateMatches(in: input, range: NSRange(location: 0, length: ns.length)) { match, _, _ in
            guard let match else { return }
            out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            let whole = ns.substring(with: match.range)
            let body = ns.substring(with: match.range(at: 1))
            out += replacement(for: body) ?? whole
            last = match.range.location + match.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    private static func replacement(for body: String) -> String? {
        if body.hasPrefix("#") {
            let isHex = body.dropFirst().first.map { $0 == "x" || $0 == "X" } ?? false
            let digits = String(body.dropFirst(isHex ? 2 : 1))
            guard let value = UInt32(digits, radix: isHex ? 16 : 10),
                  let scalar = Unicode.Scalar(value) else { return nil }
            return String(Character(scalar))
        }
        return namedEntities[body]
    }

    /// One clean line, or nil when nothing usable is left. Order matters:
    /// decode first, so an encoded newline becomes a real one and is then
    /// collapsed with the rest.
    public static func sanitize(_ raw: String) -> String? {
        var s = decodeHtmlEntities(raw)
        s = String(s.map { ch in
            guard let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else { return ch }
            let v = scalar.value
            return (v <= 0x1f || (v >= 0x7f && v <= 0x9f)) ? " " : ch
        })
        s = s.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if s.count > maxLength {
            s = String(s.prefix(maxLength)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return s.isEmpty ? nil : s
    }

    /// The page's display title: `og:title`, then `<title>`, then nil. An
    /// `og:title` that sanitizes to nothing falls through rather than ending
    /// the search.
    public static func title(in html: String) -> String? {
        if let og = metaContent(html, "og:title"), let clean = sanitize(og) { return clean }
        if let bare = titleTag(html), let clean = sanitize(bare) { return clean }
        return nil
    }

    /// The page's one-line description: `og:description`, then
    /// `<meta name="description">`, then nil.
    public static func description(in html: String) -> String? {
        if let og = metaContent(html, "og:description"), let clean = sanitize(og) { return clean }
        if let plain = metaContent(html, "description"), let clean = sanitize(plain) { return clean }
        return nil
    }

    // MARK: parsing

    /// The `content` of the first `<meta>` whose `property` or `name` is
    /// `key`. Both spellings are accepted: `og:` is conventionally carried on
    /// `property`, and plenty of pages use `name` instead.
    static func metaContent(_ html: String, _ key: String) -> String? {
        guard let tagRe = try? NSRegularExpression(pattern: "<meta\\b[^>]*>", options: [.caseInsensitive]) else {
            return nil
        }
        let ns = html as NSString
        var found: String?
        tagRe.enumerateMatches(in: html, range: NSRange(location: 0, length: ns.length)) { match, _, stop in
            guard let match else { return }
            let tag = ns.substring(with: match.range)
            let name = attribute(tag, "property") ?? attribute(tag, "name")
            guard name?.lowercased() == key else { return }
            if let content = attribute(tag, "content") {
                found = content
                stop.pointee = true
            }
        }
        return found
    }

    static func titleTag(_ html: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: "<title\\b[^>]*>([\\s\\S]*?)</title>",
                                                options: [.caseInsensitive]) else { return nil }
        let ns = html as NSString
        guard let m = re.firstMatch(in: html, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges >= 2 else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    /// One attribute's value out of a tag. Accepts double-quoted,
    /// single-quoted and unquoted values, in any attribute order.
    static func attribute(_ tag: String, _ name: String) -> String? {
        let pattern = "\\b\(name)\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))"
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let ns = tag as NSString
        guard let m = re.firstMatch(in: tag, range: NSRange(location: 0, length: ns.length)) else { return nil }
        for group in 2...4 where m.range(at: group).location != NSNotFound {
            return ns.substring(with: m.range(at: group))
        }
        return nil
    }
}
