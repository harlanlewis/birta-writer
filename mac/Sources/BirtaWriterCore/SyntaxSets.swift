import Foundation

/// WHICH Markdown the editor offers to write, on the app's side of the bridge.
///
/// A port of `shared/syntaxSets.ts`, in the same family as `ProofreadFilter`,
/// `AgentRequest` and `StyleCategories`: Swift cannot import TypeScript, so the
/// vocabulary lives twice and `shared/__tests__/syntaxSetsPort.test.ts` reads
/// both files and fails when they disagree on a set, a feature, a membership or
/// a command.
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
    case birta

    /// What the Settings row says. The reader is picking a tool they publish
    /// with, so the row names the tool rather than the specification.
    public var label: String {
        switch self {
        case .gfm: return "GitHub"
        case .obsidian: return "Obsidian"
        case .pandoc: return "Pandoc"
        case .birta: return "Birta Writer"
        }
    }

    /// The sentence under the row: what enabling it adds, in the syntax a
    /// reader would recognise rather than in feature names.
    public var caption: String {
        switch self {
        case .gfm:
            return "Tables, ~~strikethrough~~, task lists, footnotes, math, > [!NOTE] alerts and Mermaid diagrams."
        case .obsidian:
            return "Wikilinks, ==highlights== and callouts, over the GitHub set."
        case .pandoc:
            return "Footnotes, math and ::: fenced divs."
        case .birta:
            return "Calculation and SVG blocks, and Notion callouts. These render fully here and as a code block or plain HTML elsewhere."
        }
    }
}

/// A syntax a target either supports or does not. Every member is beyond
/// CommonMark, which is the floor and is never withdrawn.
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
    case svg
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
        case .birta: return [.calc, .svg, .notionCallout]
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

    /// A stored list back into a set, dropping anything the vocabulary does not
    /// know.
    ///
    /// An EMPTY stored list is kept empty rather than read as "unset", because
    /// empty is the CommonMark-only target and is a thing a reader can choose.
    /// Only a MISSING value falls back to `all`, which is what `Prefs` decides
    /// and this function is deliberately not asked to.
    public static func sets(from stored: [String]) -> Set<SyntaxSet> {
        Set(stored.compactMap(SyntaxSet.init(rawValue:)))
    }

    /// The stored spelling of a set, in the vocabulary's own order so the
    /// defaults domain does not churn on a rewrite of the same choice.
    public static func stored(_ sets: Set<SyntaxSet>) -> [String] {
        SyntaxSet.allCases.filter(sets.contains).map(\.rawValue)
    }
}
