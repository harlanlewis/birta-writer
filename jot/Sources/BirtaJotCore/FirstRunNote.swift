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

    /// What the note at `url` holds, as the rule below asks the question.
    ///
    /// HERE rather than at the call site, and the caller is shorter for it,
    /// which is not the reason. `shouldWrite` is the rule and was covered over
    /// its whole space from the day it landed; the mapping from a file to an
    /// `Existing` is the OTHER half of the same decision and sat in a private
    /// method on a `Coordinator` that needs a panel, a web view and a
    /// preferences domain to construct. So the arm that decides whether a note
    /// counts as written-in was the one arm nothing could reach, and it is the
    /// arm standing between the tour and somebody's writing.
    ///
    /// Size rather than contents, and `.hasContent` for any non-zero file: a
    /// note holding one space is a note somebody made, and reading the bytes to
    /// judge whether they are blank would be this type deciding what counts as
    /// writing. Anything it cannot stat is `.absent`, which is the same answer
    /// as a path that is not there and the safe one either way, because
    /// `bufferIsEmpty` is a second refusal the caller still has to clear.
    public static func existing(at url: URL,
                                fileManager: FileManager = .default) -> Existing {
        guard let size = (try? fileManager.attributesOfItem(atPath: url.path))?[.size]
                as? NSNumber else {
            return .absent
        }
        return size.intValue == 0 ? .empty : .hasContent
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
    /// Deliberately short, and ordered by what a first run has to establish
    /// rather than by feature. It opens on the summon, because that gesture IS
    /// the product: somebody who does not learn it has installed a thing that
    /// opened once. The reader has just performed it to get here, so the first
    /// line names what they did rather than instructing them.
    ///
    /// The first thing it ASKS for is typing, not reading. A pre-rendered
    /// heading could be a picture of an editor; a heading that appears under
    /// somebody's own fingers cannot be. That is the one claim this product
    /// has to land, so it is spent first and on a gesture rather than a
    /// sentence.
    ///
    /// Two constraints on that type-along, both found by driving it rather
    /// than by reading, and both silent if broken:
    ///
    ///   - The target line must be a TOP-LEVEL paragraph. Return from inside a
    ///     list continues the list, and `## ` typed there is escaped to a
    ///     literal `\##` instead of becoming a heading, so a tour that put its
    ///     type-along inside the checklist would demonstrate the opposite of
    ///     what it claims.
    ///   - The demo line must NOT already carry the character the reader is
    ///     told to type. `340 + 12 =` plus a typed `=` is `==`, which computes
    ///     nothing.
    ///
    /// The calc line says to press Tab, because the answer is ADVISORY: the
    /// `=` offers a result and Tab confirms it, while Enter deliberately stays
    /// a newline (`webview/plugins/calc.ts`). A tour promising the answer
    /// simply arrives would be describing the auto-insert setting rather than
    /// the default.
    ///
    /// Every operator here avoids `*`, which the serializer escapes mid-line:
    /// `340 * 12` reaches the user's own file as `340 \* 12`, which is a
    /// backslash nobody typed in the first document they ever open.
    ///
    /// The two embed links are the SAME pair `samples/content-inventory.md`
    /// demonstrates, and that is what makes them checkable rather than hoped
    /// for. The Figma one is Figma's own public Embed Kit examples file, so
    /// the preview genuinely loads; the Loom one is a real recording. Nothing
    /// in this repository can prove a third-party URL is alive, so the guard
    /// in `shared/__tests__/firstRunNote.test.ts` does the next best thing and
    /// requires every link here to be one the sample also carries: there is
    /// one list of known-live embed URLs, and a link retired from the sample
    /// takes this note red rather than leaving it pointing at nothing.
    ///
    /// On a first run neither link is a card at all, and the section says so.
    /// `providerCardGateOpen` refuses a provider whose card would fetch while
    /// the network switch is off, and both of these are such providers, so
    /// what the reader sees is two plain links. The section is written to
    /// demonstrate that rather than to promise around it: prose saying the
    /// cards are merely closed describes a card that was never drawn, which is
    /// what shipped, and the reader's own screen is what contradicts it.
    /// `firstRunNote.test.ts` holds the gate's answer against the default, so
    /// a change to either takes the sentence red. The links still have to resolve,
    /// because the reader can turn the network on and the note is the first
    /// thing they will try it against, which is exactly what a placeholder
    /// could not survive.
    ///
    /// The Cmd+F item names a word that has to appear elsewhere in the note,
    /// or the gesture it teaches finds nothing. That coupling is invisible in
    /// the text and is guarded in the same file.
    ///
    /// The network callout is scoped to the NOTE, and the scope is the whole
    /// accuracy of it. `Prefs.autoUpdate` ships on, so a release build asks
    /// `api.github.com` for the newest version at launch, before anybody has
    /// read this far: rung 0c in `docs/NETWORK_POSTURE.md`, which carries
    /// nothing of the user's and is on by default. An unqualified "makes no
    /// network request" is therefore false the moment it is read. What is
    /// true, and is what the section is about, is that nothing in a document
    /// reaches out until the network switch is on.
    ///
    /// The opening says where the app lives and says nothing about the Dock.
    /// `Prefs.showInDock` ships off, but the first-run screen offers it one
    /// screen before this note is written, so a reader who took it would find
    /// the note's first paragraph contradicting the switch they just moved.
    /// Nothing here may assert a setting the welcome screen has just let
    /// somebody change.
    public static let markdown = """
    # You're in

    Press the same keys again and this panel goes away. Press them once more
    and it is back, exactly as you left it. That is Birta Writer: it lives in
    your menu bar, so it is always one keystroke away.

    What you are typing into is a real Markdown file on your Mac. Plain text,
    yours, and readable by anything.

    ## See what it does

    Put the caret at the end of the next line, press Return, then type two hash
    marks, a space, and a word.

    Try it here.

    The hashes disappear and leave a heading behind. That is the whole idea:
    you write Markdown and you see the document. On disk the file still says
    `##`, so it opens the same way everywhere else.

    ## The rest of the basics

    - [ ] Click the box at the start of this line to tick it off.
    - [ ] Or put the caret on a line and press Cmd+Shift+D.
    - [ ] Select this sentence, and use the toolbar that appears to make a word bold.
    - [ ] Take hold of the handle at this line's left edge and drag it somewhere else.
    - [ ] Press Cmd+F and look for the word Figma.
    - [ ] Type `/` on a new line to reach everything else.

    ## Numbers that answer themselves

    Put the caret at the end of the next line, type an equals sign, then press
    Tab to take the answer it offers.

    340 + 12

    It is worked out here on your Mac, and what lands in the file is an
    ordinary number. Nothing marks it as special, so it reads the same
    anywhere else you open this file.

    ## A table

    | Feature | Renders | Needs the network |
    | --- | --- | --- |
    | Tables | here, and editable | no |
    | Diagrams | below | no |
    | Math | below | no |
    | Embeds | below | yes |

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

    A link alone on its own line can become a card: a Loom recording, a Figma
    file, and the same for YouTube, GitHub, Google Docs and the rest.

    https://www.loom.com/share/e41353f2fe1c43eba6c6829693e0f2c5

    https://www.figma.com/design/nrPSsILSYjesyc5UHjYYa4/Embed-Kit-2-0-examples

    > [!NOTE]
    > Those two are still plain links. A card is drawn from the site it points
    > at, so nothing in this note reaches the network until you turn that on
    > yourself, in Settings.

    ## When you are ready

    - [ ] Press Cmd+, to see where these notes are kept, and to change it.
    - [ ] Press Cmd+N to start a note of your own.
    - [ ] Select all and delete to clear this one. It will not come back.

    """
}
