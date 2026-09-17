import Foundation

/// Plain JSON out of a file that was written for a reader that forgives more.
///
/// A VS Code colour theme is JSON with comments and trailing commas, because
/// VS Code's own parser takes both and theme authors write for it. Foundation's
/// does not, so a theme with one `//` line in it fails to decode with an error
/// about a byte offset. This strips what Foundation refuses and nothing else:
/// strings are left exactly as written, comment markers inside them included,
/// which is why it walks characters rather than running two regular
/// expressions over the text.
public enum JSONC {
    public static func strip(_ text: String) -> String {
        var out: [Character] = []
        out.reserveCapacity(text.count)
        var chars = Array(text)
        var i = 0
        var inString = false
        // The index in `out` of a comma that may turn out to be trailing: it
        // is dropped when the next thing that is not whitespace or a comment
        // closes the container it was written in.
        var pendingComma: Int?

        while i < chars.count {
            let c = chars[i]
            if inString {
                out.append(c)
                if c == "\\", i + 1 < chars.count {
                    out.append(chars[i + 1])
                    i += 2
                    continue
                }
                if c == "\"" { inString = false }
                i += 1
                continue
            }
            if c == "\"" {
                inString = true
                pendingComma = nil
                out.append(c)
                i += 1
                continue
            }
            if c == "/", i + 1 < chars.count, chars[i + 1] == "/" {
                while i < chars.count, chars[i] != "\n" { i += 1 }
                continue
            }
            if c == "/", i + 1 < chars.count, chars[i + 1] == "*" {
                i += 2
                while i + 1 < chars.count, !(chars[i] == "*" && chars[i + 1] == "/") { i += 1 }
                i += 2
                continue
            }
            if c == "," {
                pendingComma = out.count
                out.append(c)
                i += 1
                continue
            }
            if c == "]" || c == "}" {
                if let at = pendingComma {
                    out.remove(at: at)
                    pendingComma = nil
                }
                out.append(c)
                i += 1
                continue
            }
            if !c.isWhitespace { pendingComma = nil }
            out.append(c)
            i += 1
        }
        chars.removeAll()
        return String(out)
    }

    /// `JSONSerialization` over the stripped text, as the object it holds.
    public static func object(from data: Data) throws -> Any {
        guard let text = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "JSONC", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "The file is not UTF-8 text."])
        }
        return try JSONSerialization.jsonObject(with: Data(strip(text).utf8), options: [.fragmentsAllowed])
    }
}
