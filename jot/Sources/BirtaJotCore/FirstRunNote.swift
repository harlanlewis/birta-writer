import Foundation

/// The note a fresh install opens with, and the rule for when it may be
/// written.
///
/// A first launch otherwise lands on an empty panel, which shows nothing of
/// what this editor does that a text field does not. So the first note is a
/// short tour: a checklist a person works down, where ticking an item is
/// itself the thing being demonstrated.
///
/// It is ORDINARY CONTENT, not a screen. It lands in the note as markdown the
/// user owns, so every gesture in it is the real one, select-all-delete
/// removes it for good, and nothing has to be dismissed. That is also why the
/// text is here rather than in a view: there is no view.
///
/// The whole of the risk is that this writes over something. Two things keep
/// it from doing so, and they are separate on purpose: `shouldWrite` refuses
/// unless the note is provably empty, and the caller only asks on a real first
/// run. Either alone would be enough for the case anybody thinks of; the pair
/// is what covers the case nobody does.
public enum FirstRunNote {
    /// What the note already holds, as the only three answers that matter.
    ///
    /// `empty` is separate from `absent` because the two arrive by different
    /// routes and mean the same thing here: a fresh scratchpad has never been
    /// written, while the new-file-each-session mode creates its note as an
    /// empty file before anything is bound to it. Collapsing them into
    /// `fileExists` would have made the second case unreachable.
    public enum Existing: String, CaseIterable, Sendable {
        case absent
        case empty
        case hasContent
    }

    /// Whether the tour may be written into a note in state `existing`.
    ///
    /// Every argument is a refusal. `isFirstRun` is the caller's, and it is
    /// what stops the tour reappearing for somebody who deleted it; the other
    /// two are this type's own, and they are what stops it landing on top of
    /// writing. `bufferIsEmpty` is not implied by the file being empty: the
    /// panel can hold bytes the file has not been given yet, and writing here
    /// would put the tour underneath them and then lose one of the two.
    public static func shouldWrite(existing: Existing,
                                   bufferIsEmpty: Bool,
                                   isFirstRun: Bool) -> Bool {
        guard isFirstRun, bufferIsEmpty else { return false }
        return existing != .hasContent
    }

    /// The tour itself.
    ///
    /// Deliberately short. It is the first thing somebody sees, and a tour
    /// long enough to scroll reads as work rather than as a welcome; what is
    /// not here is reachable from the slash menu, which the tour points at.
    ///
    /// The two embed links are PLACEHOLDERS with no content behind them, and
    /// they are shaped so the cards recognise them (`shared/embedProviders.ts`
    /// wants 32 hex characters for Loom and 10 or more alphanumerics for a
    /// Figma key). Nothing is fetched for them on a first run whatever they
    /// point at, because the network ships off and the cards stay closed until
    /// somebody opens them; that is the behaviour the note goes on to explain,
    /// so it is being shown rather than described.
    public static let markdown = """
    # Welcome to Birta Writer

    This is a real Markdown file on your Mac, and it is yours. Work down the
    list, then select all and delete when you are done. It will not come back.

    ## The basics

    - [ ] Put the caret on this line and press Cmd+Shift+D to tick it off.
    - [ ] Start a new line and type `/` to open the slash menu. Everything below came from it.
    - [ ] Select this sentence, and use the toolbar that appears to make a word bold.
    - [ ] Take hold of the handle at this line's left edge and drag it somewhere else.
    - [ ] Press Cmd+F and look for the word Figma.

    ## Numbers that answer themselves

    - [ ] Put the caret at the end of the next line and type `=`

    340 * 12 =

    The answer is worked out here on your Mac, and what lands in the file is an
    ordinary number. Nothing in the Markdown marks it as special, so it reads
    the same anywhere else you open this file.

    ## A table

    | Feature | Renders | Needs the network |
    | --- | --- | --- |
    | Tables | here, and editable | no |
    | Diagrams | below | no |
    | Math | below | no |
    | Embeds | below | yes |

    - [ ] Hover the table's edge for the grips that add, remove and reorder rows.

    ## A diagram

    ```mermaid
    flowchart LR
      Type --> Render --> Own[It stays your file]
    ```

    ## Some math

    $$
    E = mc^2
    $$

    ## Things from elsewhere

    A link alone on its own line becomes a card. These two point at nothing:
    replace them with a Loom and a Figma file of your own.

    https://www.loom.com/share/deadbeefdeadbeefdeadbeefdeadbeef

    https://www.figma.com/design/BirtaWriterTourPlaceholder/Birta-Writer-Tour

    > [!NOTE]
    > Those cards are closed, and they stay closed. Birta Writer makes no
    > network request until you turn that on yourself, in Settings.

    ## When you are ready

    - [ ] Press your summon hotkey to put this panel away, and again to bring it back.
    - [ ] Press Cmd+, to choose where your notes live.
    - [ ] Press Cmd+N to start a note of your own, and leave this one to come back to.

    """
}
