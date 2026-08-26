import Foundation

/// The lint protocol's three shapes, as the page spells them
/// (`shared/messages.ts`).
///
/// The page posts blocks out and draws whatever comes back, so these names and
/// this JSON are a contract with it rather than with any particular checker.
/// `kind` is the checker's own word for the sort of finding, which the popup
/// prints as a chip; the extension passes Harper's through and this shell
/// passes the system checker's, and the page is indifferent.
///
/// Offsets are UTF-16 code units, because that is what a JavaScript string
/// index is. `ProofreadFilter` says more about why nothing here converts.
public struct LintBlock: Equatable, Sendable {
    /// The block's position in the document, which the page uses to map the
    /// answer back. Opaque here: a host must return it unchanged.
    public let key: Int
    public let text: String

    public init(key: Int, text: String) {
        self.key = key
        self.text = text
    }
}

public struct HarperLint: Equatable, Sendable {
    public let start: Int
    public let end: Int
    public let kind: String
    public let message: String
    public let suggestions: [String]

    public init(start: Int, end: Int, kind: String, message: String, suggestions: [String]) {
        self.start = start
        self.end = end
        self.kind = kind
        self.message = message
        self.suggestions = suggestions
    }

    public var json: [String: Any] {
        ["start": start, "end": end, "kind": kind, "message": message, "suggestions": suggestions]
    }
}

public struct LintBlockResult: Equatable, Sendable {
    public let key: Int
    public let lints: [HarperLint]

    public init(key: Int, lints: [HarperLint]) {
        self.key = key
        self.lints = lints
    }

    public var json: [String: Any] {
        ["key": key, "lints": lints.map(\.json)]
    }
}
