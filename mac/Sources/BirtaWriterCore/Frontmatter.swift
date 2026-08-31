import Foundation

/// The metadata block a Markdown file opens with, and the body the editor
/// renders in its place.
///
/// This is the HOST's half of a contract the page cannot keep on its own. The
/// panel above the editor is fed a `frontmatter` field, and the ProseMirror
/// document is fed a body with that block already removed, so a host that
/// sends the whole file as `content` sends the panel nothing and hands the
/// block to the Markdown parser instead, which reads `---` as a rule and the
/// lines under it as a setext heading.
///
/// A literal port of `extractFrontmatter` (shared/contentTransform.ts) and
/// `sourceLineCount` (shared/lineMap.ts), down to the pattern string, and
/// `FrontmatterTests` mirrors `contentTransform.test.ts` case for case. The two
/// surfaces read the same files, so a file the extension calls frontmatter and
/// this side does not is a file whose bytes move when it is opened here.
public enum Frontmatter {
    /// A document's two halves.
    public struct Split: Equatable {
        /// The block, closing fence and its line break included, or empty.
        public let frontmatter: String
        /// Everything after it, which is the whole document when there is none.
        public let body: String

        public init(frontmatter: String, body: String) {
            self.frontmatter = frontmatter
            self.body = body
        }
    }

    /// The block pattern, character for character the one in
    /// `shared/contentTransform.ts`. Two properties of it are load-bearing and
    /// neither is obvious from reading it:
    ///
    /// - the lazy quantifier backtracks past inner lines that merely START
    ///   with the delimiter (`--- draft`, `----`), so a block is closed only by
    ///   a full line of exactly the opening fence;
    /// - the backreference is what stops one dialect's fence closing the
    ///   other's, so a mismatched pair is not frontmatter at all and the panel
    ///   can never write `---` over a `+++`.
    ///
    /// Force-unwrapped on purpose: the pattern is a literal, so a throw here
    /// would be a typo in this file rather than anything a run can produce.
    private static let block = try! NSRegularExpression(
        pattern: #"^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1(?:\r?\n|$)"#)

    /// Split `content` into its frontmatter block and the body under it.
    public static func split(_ content: String) -> Split {
        // The pattern is anchored at the start of the string, so a document
        // that does not open with a fence cannot match. Asking that first
        // keeps both the regex and the NSString bridge it needs off every
        // document that has no frontmatter, which is most of them.
        guard content.hasPrefix("---") || content.hasPrefix("+++") else {
            return Split(frontmatter: "", body: content)
        }
        let ns = content as NSString
        // The location is checked rather than assumed: everything below reads
        // the match as a PREFIX, and a match found anywhere else would be
        // silently cut from the front of the document instead.
        guard let match = block.firstMatch(in: content, range: NSRange(location: 0, length: ns.length)),
              match.range.location == 0 else {
            return Split(frontmatter: "", body: content)
        }
        return Split(frontmatter: ns.substring(to: match.range.length),
                     body: ns.substring(from: match.range.length))
    }

    /// How many source lines `text` occupies.
    ///
    /// A block always ends at its closing fence, with or without the trailing
    /// line break a file ending there would lack, so the count of line
    /// terminators is exactly how far the body below it is pushed down. That
    /// number is what the page adds back to every document line it reports, so
    /// an agent reference into a file with frontmatter names the line the file
    /// actually has.
    ///
    /// Counted over unicode scalars rather than characters: Swift makes
    /// `\r\n` ONE character, so a CRLF file counted the obvious way reports
    /// zero lines and every reference into it comes out short by the whole
    /// block.
    public static func sourceLineCount(_ text: String) -> Int {
        text.unicodeScalars.reduce(0) { $0 + ($1 == "\n" ? 1 : 0) }
    }
}

/// What the page's frontmatter panel is holding, and how a message from either
/// side becomes a whole document again.
///
/// A mirror rather than a re-read of the buffer, and that is the load-bearing
/// choice. The document after an `update` is `frontmatter + body`, so
/// re-deriving the block from the rebuilt document would agree with the mirror
/// in every case but one, and that one loses bytes: with no frontmatter at all,
/// a body whose own first lines happen to form a block (`---`, a line, `---`,
/// which is a rule and a setext heading and something a person can type) would
/// be read as one and prepended to itself on the next update.
public struct DocumentSplit: Equatable {
    /// The block the panel currently holds; empty when the document has none.
    public private(set) var frontmatter = ""

    public init() {}

    /// Split `content` for the page, recording the block the panel is given.
    ///
    /// Mutating because sending is what makes the mirror true: every path that
    /// puts a document in front of the page goes through here, so the mirror
    /// cannot describe a panel that was never fed.
    public mutating func forPage(_ content: String) -> (body: String, frontmatter: String, lineOffset: Int) {
        let split = Frontmatter.split(content)
        frontmatter = split.frontmatter
        return (split.body, split.frontmatter, Frontmatter.sourceLineCount(split.frontmatter))
    }

    /// The document an editor `update` amounts to. The page serializes the body
    /// alone, because the block never entered its document.
    public func document(body: String) -> String {
        frontmatter + body
    }

    /// The document a `frontmatterUpdate` amounts to: the panel's block
    /// replaced, the body under it untouched, byte for byte.
    ///
    /// The mirror is what the block is measured by. Falling back to a re-split
    /// when it is not a prefix cannot reach the duplication above, because an
    /// empty mirror is a prefix of everything.
    public mutating func document(_ content: String, replacingFrontmatterWith newFrontmatter: String) -> String {
        let body = content.hasPrefix(frontmatter)
            ? String(content.dropFirst(frontmatter.count))
            : Frontmatter.split(content).body
        frontmatter = newFrontmatter
        return newFrontmatter + body
    }
}
