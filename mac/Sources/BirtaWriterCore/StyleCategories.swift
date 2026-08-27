import Foundation

/// The style-check categories the reader can switch on and off one at a time,
/// in the order and with the labels the page uses.
///
/// A port of the toggleable half of `STYLE_CATEGORIES` in
/// `webview/utils/styleCategories.ts`, in the same family as `ProofreadFilter`
/// and `AgentRequest`: Swift cannot import TypeScript, so the vocabulary lives
/// twice and `shared/__tests__/styleCategoriesPort.test.ts` reads both files and
/// fails when they disagree on a key, a label, an order or a section.
///
/// `CaseIterable` is what makes the Style Options submenu derived rather than
/// hand-listed. A new category joins the menu by being added here, which the
/// guard above demands the moment the page gains one, so the menu cannot
/// quietly stop offering a check the editor is running.
///
/// `repeated` is deliberately absent, and its absence is the page's decision
/// rather than one taken here: it is folded into the Check Style master and
/// has no row of its own in the toolbar's Checks menu either (`section: null`).
public enum StyleCategory: String, CaseIterable {
    // Phrases
    case fillers
    case redundancies
    case cliches
    case wordiness
    // AI tells
    case aiVocabulary
    case aiArtifacts
    case negativeParallelism
    case ruleOfThree
    case rhythm
    // Prose
    case passive
    case longSentences
    case emDash
    case nonAsciiPunct
    case absolutePerf

    /// The heading the toolbar's Checks menu prints above this category.
    ///
    /// A macOS submenu has no headings, so what the section buys here is the
    /// rule between groups: the reader gets the same three clusters in the
    /// same order, separated rather than titled.
    public enum Section: String, CaseIterable {
        case phrases = "Phrases"
        case aiTells = "AI tells"
        case prose = "Prose"
    }

    public var section: Section {
        switch self {
        case .fillers, .redundancies, .cliches, .wordiness: return .phrases
        case .aiVocabulary, .aiArtifacts, .negativeParallelism, .ruleOfThree, .rhythm: return .aiTells
        case .passive, .longSentences, .emDash, .nonAsciiPunct, .absolutePerf: return .prose
        }
    }

    /// What the row says. The page's own label, so a reader who has used the
    /// toolbar's menu finds the same words here.
    public var label: String {
        switch self {
        case .fillers: return "Fillers"
        case .redundancies: return "Redundancies"
        case .cliches: return "Cliches"
        case .wordiness: return "Wordiness"
        case .aiVocabulary: return "AI vocabulary"
        case .aiArtifacts: return "AI boilerplate"
        case .negativeParallelism: return "Not X, but Y"
        case .ruleOfThree: return "Rule of three"
        case .rhythm: return "Uniform rhythm"
        case .passive: return "Passive voice"
        case .longSentences: return "Long sentences"
        case .emDash: return "Em dash"
        case .nonAsciiPunct: return "Curly punctuation"
        case .absolutePerf: return "Absolute speed claim"
        }
    }
}
