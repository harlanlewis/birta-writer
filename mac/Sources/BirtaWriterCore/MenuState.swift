import Foundation

/// One of the on/off things a menu row can draw.
///
/// Named separately from HOW a row draws it (`AppMenu.RowState`), because the
/// two are independent: the outline panel is a checkmark's worth of state and
/// wears a title instead, and any of the others could go the other way without
/// a second mechanism.
public enum MenuToggle: Equatable {
    /// A row of the page's Checks menu, by its OWN option key
    /// (`ProofreadOptionKey` in shared/messages.ts): "proofreading" for the
    /// master gate, "spellCheck", "styleCheck", "fillers" and the rest.
    ///
    /// The key rather than a case per row, because this list is the page's and
    /// grows there; `StyleCategory` is the half of it a check holds against
    /// the page's own declaration.
    case proofread(String)
    /// The in-text note-marker highlight.
    ///
    /// NOT a proofreading option, and the distinction is the design's rather
    /// than an implementation detail: proofreading findings are the editor's
    /// opinion about your prose, and the markers are text the writer typed on
    /// purpose, so the gate silencing one must not take away the other
    /// (docs/DESIGN_PRINCIPLES.md, "A gate silences the editor's opinions").
    case noteHighlight
    /// Whether the outline panel is out.
    case tocShown
}

/// What the app knows about the state its menu rows draw, at the moment a menu
/// opens.
///
/// A value rather than a set of reads scattered through the menu code, so the
/// rule for each answer is written once and a check can ask the same questions
/// the menu does without a running app.
public struct MenuState: Equatable {
    /// Only what the reader has CHANGED, exactly as the page posted it. An
    /// absent key is the page's default rather than off.
    public var proofreadOptions: [String: Bool]
    public var noteHighlight: Bool
    public var tocShown: Bool

    public init(proofreadOptions: [String: Bool] = [:],
                noteHighlight: Bool = true,
                tocShown: Bool = false) {
        self.proofreadOptions = proofreadOptions
        self.noteHighlight = noteHighlight
        self.tocShown = tocShown
    }

    public func isOn(_ toggle: MenuToggle) -> Bool {
        switch toggle {
        // Every proofreading option ships ON, and the host stores only the
        // rows the reader has touched, so an absent answer is on. Reading it
        // as off is the failure this line exists to name: it would draw a
        // menu full of unchecked rows over a document that is being checked.
        case let .proofread(key): return proofreadOptions[key] ?? true
        case .noteHighlight: return noteHighlight
        case .tocShown: return tocShown
        }
    }

    /// Record a flip the page has reported.
    ///
    /// Here rather than as three assignments at the message handler, because
    /// this is the half that is decidable without a window: a `Coordinator`
    /// cannot be built in the unit suite without starting WebKit, so anything
    /// left there is unreachable by a test. What is worth pinning is that every
    /// toggle a menu DRAWS is also a toggle this RECORDS, and a mutating method
    /// over the same `MenuToggle` the drawing reads makes the two one list
    /// rather than two that can drift.
    public mutating func record(_ toggle: MenuToggle, on: Bool) {
        switch toggle {
        case let .proofread(key): proofreadOptions[key] = on
        case .noteHighlight: noteHighlight = on
        case .tocShown: tocShown = on
        }
    }
}
