import Foundation

/// WHICH Markdown the editor offers to write, on the app's side of the bridge.
///
/// A port of `shared/syntaxSets.ts`, in the same family as `ProofreadFilter`,
/// `AgentRequest` and `StyleCategories`: Swift cannot import TypeScript, so the
/// vocabulary lives twice and `shared/__tests__/syntaxSetsPort.test.ts` reads
/// both files and fails when they disagree on a set, a feature, a membership,
/// a command, a documentation link or a retired name.
///
/// The app needs its own copy for one reason the page cannot serve: the menu
/// bar belongs to the application, and AppKit takes a key equivalent before the
/// page ever sees it. A Format menu row that writes a syntax the reader's
/// target does not spell has to be withdrawn HERE, or the menu goes on offering
/// what every other surface has stopped offering, and its chord goes on
/// working.
///
/// The same rule holds on this side as on the page's: a document renders
/// everything it contains under every setting, and nothing here reaches the
/// file. What a target governs is the tools.
public enum SyntaxSet: String, CaseIterable, Sendable {
    case gfm
    case obsidian
    case pandoc
    case notion
    case calc

    /// What the Settings row says. The reader is picking a tool they publish
    /// with, so the row names the tool rather than the specification; the one
    /// row that is this editor's own names the thing it writes, because a row
    /// named for the product would say nothing about what its switch withdraws.
    public var label: String {
        switch self {
        case .gfm: return "GitHub"
        case .obsidian: return "Obsidian"
        case .pandoc: return "Pandoc"
        case .notion: return "Notion"
        case .calc: return "Calculation blocks"
        }
    }

    /// The sentence under the row: what enabling it adds, in the syntax a
    /// reader would recognise rather than in feature names.
    ///
    /// Obsidian's names GitHub rather than relisting seven features, and that
    /// is a claim Obsidian's own page makes (it supports CommonMark, GitHub
    /// Flavored Markdown and LaTeX), so the membership table holds every GitHub
    /// feature under Obsidian too. `syntaxSetDescriptions.test.ts` holds each
    /// caption to naming only what its target provides.
    public var caption: String {
        switch self {
        case .gfm:
            return "Tables, ~~strikethrough~~, task lists, footnotes, math, > [!NOTE] alerts and Mermaid diagrams."
        case .obsidian:
            return "Everything in the GitHub row, plus [[wikilinks]], ==highlights== and callouts."
        case .pandoc:
            return "Footnotes, math and ::: fenced divs."
        case .notion:
            return "Notion callouts, as an export writes them. Plain HTML anywhere else."
        case .calc:
            return "Calculations that work out their answers as you type. A plain code block anywhere else."
        }
    }

    /// The target's own page on what its Markdown is, mirroring
    /// `SYNTAX_SET_DOCUMENTATION`. Nil for the calculation block, which is this
    /// editor's own and has no outside page to point at.
    public var documentation: SyntaxDocumentation? {
        switch self {
        case .gfm: return SyntaxDocumentation("GitHub Docs", "https://docs.github.com/en/get-started/writing-on-github")
        case .obsidian: return SyntaxDocumentation("Obsidian Help", "https://obsidian.md/help/obsidian-flavored-markdown")
        case .pandoc: return SyntaxDocumentation("Pandoc Manual", "https://pandoc.org/MANUAL.html#pandocs-markdown")
        case .notion: return SyntaxDocumentation("Notion Help", "https://www.notion.com/help/export-your-content")
        case .calc: return nil
        }
    }
}

/// Where a target documents its own Markdown, for the settings row to link.
public struct SyntaxDocumentation: Equatable, Sendable {
    /// The link's text: the site's name, as its own readers know it.
    public let title: String
    public let url: URL

    /// A literal URL, which is the only kind the vocabulary holds; a string
    /// that does not parse is a typo in this file rather than a runtime case,
    /// and `SettingsPaneTests` draws every one of these, so the typo crashes
    /// a test run rather than shipping as a dead link.
    public init(_ title: String, _ url: String) {
        self.title = title
        self.url = URL(string: url)!
    }
}

/// The floor, for the one Settings row that shows it rather than switches it.
///
/// Not a `SyntaxSet`, and deliberately: every target contains CommonMark, so a
/// set for it could never be turned off, and the row exists to SAY that rather
/// than to ask. Mirrors `COMMONMARK_DOCUMENTATION`.
public enum CommonMark {
    public static let caption = "Supported everywhere."
    public static let documentation = SyntaxDocumentation("CommonMark Reference", "https://commonmark.org/help/")
}

/// A syntax a target either supports or does not. Every member is beyond
/// CommonMark, which is the floor and is never withdrawn; and none is a
/// renderer's fence (`svg`, PlantUML, Graphviz), because drawing what a code
/// block holds is rendering rather than syntax and no target can take it away.
public enum SyntaxFeature: String, CaseIterable, Sendable {
    case table
    case strikethrough
    case taskList
    case footnote
    case math
    case highlight
    case wikiLink
    case calloutAlert
    case fencedDiv
    case notionCallout
    case mermaid
    case calc
}

/// What each target spells, and which of the app's own menu rows a target can
/// take away.
public enum SyntaxScope {
    /// The membership table, mirroring `SYNTAX_SET_FEATURES`.
    public static func features(of set: SyntaxSet) -> [SyntaxFeature] {
        switch set {
        case .gfm: return [.table, .strikethrough, .taskList, .footnote, .math, .calloutAlert, .mermaid]
        case .obsidian: return [.table, .strikethrough, .taskList, .footnote, .math, .highlight,
                                .wikiLink, .calloutAlert, .mermaid]
        case .pandoc: return [.table, .strikethrough, .footnote, .math, .fencedDiv]
        case .notion: return [.notionCallout]
        case .calc: return [.calc]
        }
    }

    /// The syntax an editor command writes, where it writes one beyond
    /// CommonMark. Mirrors the `syntax` field on `EDITOR_COMMANDS`.
    ///
    /// A command that acts on a construct the document already has is absent
    /// here on purpose, and the pair to check the rule against is in the Lists
    /// submenu: Task List writes `- [ ]` and goes under a target with no task
    /// lists, while Toggle Task Done and Uncheck All Tasks act on tasks that
    /// are already there and stay, because the document renders them whatever
    /// the target says and a row that could not tick a box the reader can see
    /// would be the target reaching into the file.
    public static func feature(forCommand id: String) -> SyntaxFeature? {
        switch id {
        case "toggleStrikethrough": return .strikethrough
        case "toggleHighlight": return .highlight
        case "toggleTaskList": return .taskList
        case "insertTable": return .table
        case "insertMath": return .math
        case "insertFootnote": return .footnote
        case "insertCallout": return .calloutAlert
        case "toggleCallout": return .calloutAlert
        default: return nil
        }
    }

    /// Whether any enabled target spells `feature`. A nil feature is the
    /// CommonMark answer and is always true, so a caller can pass an optional
    /// straight through.
    public static func allows(_ feature: SyntaxFeature?, in sets: Set<SyntaxSet>) -> Bool {
        guard let feature else { return true }
        return sets.contains { features(of: $0).contains(feature) }
    }

    /// Whether command `id` may be offered under `sets`.
    public static func allows(command id: String, in sets: Set<SyntaxSet>) -> Bool {
        allows(feature(forCommand: id), in: sets)
    }

    /// Every target enabled, which is what a reader who has never opened the
    /// setting gets: the app as it was before targets existed.
    public static let all: Set<SyntaxSet> = Set(SyntaxSet.allCases)

    /// Set names a stored list may still carry from before the vocabulary
    /// changed, and what each reads as now. Mirrors `LEGACY_SYNTAX_SETS`: the
    /// `birta` target split into `notion` and `calc`, and a list written under
    /// the old name keeps the tools it had rather than losing two of them on
    /// the next launch. The next write spells the list in the current
    /// vocabulary, so the old name is read for as long as it is stored and
    /// never written again.
    public static let legacy: [String: [SyntaxSet]] = ["birta": [.notion, .calc]]

    /// A stored list back into a set, dropping anything the vocabulary does not
    /// know and reading a retired name as what it became.
    ///
    /// An EMPTY stored list is kept empty rather than read as "unset", because
    /// empty is the CommonMark-only target and is a thing a reader can choose.
    /// Only a MISSING value falls back to `all`, which is what `Prefs` decides
    /// and this function is deliberately not asked to.
    public static func sets(from stored: [String]) -> Set<SyntaxSet> {
        Set(stored.flatMap { name in
            SyntaxSet(rawValue: name).map { [$0] } ?? legacy[name] ?? []
        })
    }

    /// The stored spelling of a set, in the vocabulary's own order so the
    /// defaults domain does not churn on a rewrite of the same choice.
    public static func stored(_ sets: Set<SyntaxSet>) -> [String] {
        SyntaxSet.allCases.filter(sets.contains).map(\.rawValue)
    }
}
