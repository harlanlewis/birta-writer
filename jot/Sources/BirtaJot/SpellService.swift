import AppKit
import BirtaJotCore

/// Spelling and grammar for the page, answered by the system's own checker.
///
/// The page posts `lintBlocks` and draws whatever comes back; who does the
/// checking is the host's business. In VS Code that is Harper, a WASM engine in
/// the extension process. Here it is `NSSpellChecker`, which every Mac already
/// has, already knows the user's language and their learned words, and costs
/// this app no dependency, no WASM binary and no resident engine of its own.
/// The findings differ in wording from Harper's, which is what "the host
/// answers the lint" means; the page renders them identically either way.
///
/// ## Why it is sliced rather than done in one pass
///
/// `NSSpellChecker` is AppKit and is checked on the main thread, and the page
/// sends every block of the document at once. Done in one pass a long note
/// would hold that thread for a whole-document check, which is the one thing
/// this panel cannot afford: it is also the thread the editor types on. So the
/// blocks are checked a batch at a time, handing the run loop back between
/// batches, and the reply goes out when the last batch is done.
///
/// `requestChecking`, the asynchronous API, looks like the obvious answer and
/// is not usable here: its completion is delivered through the checker's own
/// machinery, which does not run in a unit-test host, so the whole feature
/// would be untestable and the only place it could be observed is by hand.
///
/// ## Why the results are filtered here
///
/// The page draws what it is given, and a checker that flags `getEditorView`
/// or `src/utils/lineMap.ts` fills a technical document with underlines nobody
/// wants. `ProofreadFilter` is the extension's own rule for that, ported, so
/// the same paragraph is marked up the same way on both surfaces.
@MainActor
final class SpellService {
    /// The document tag, so words learned or ignored here are scoped to this
    /// app rather than leaking into every other document the checker serves.
    private let tag = NSSpellChecker.uniqueSpellDocumentTag()

    /// Kinds where a tech-like token is noise rather than prose, which here is
    /// both of them.
    ///
    /// The extension filters `Spelling, Typo, Capitalization, BoundaryError,
    /// Word Choice` and leaves Harper's multi-word grammar findings alone. This
    /// checker has two buckets rather than five, and its Grammar one is where
    /// the equivalents of Capitalization and Word Choice land, so filtering
    /// both is the closer read of that list than filtering Spelling alone would
    /// be. What the filter can do to a real multi-word finding is bounded: it
    /// vetoes only a span whose surrounding chunk looks like a path or a URL.
    private static let tokenKinds: Set<String> = ["Spelling", "Grammar"]

    // No `deinit` closing the spell document: the coordinator holds this for
    // the app's lifetime, so the close would be a line that never runs, and
    // reaching AppKit from a nonisolated `deinit` to run it is a hazard bought
    // for nothing. The tag is released with the process.

    /// How much TEXT is checked before the run loop gets a turn.
    ///
    /// A count of blocks is the wrong budget, because what this thread is being
    /// held for is the checking, and that scales with characters rather than
    /// with paragraphs. A working document of unwrapped 900-character
    /// paragraphs put twenty of them, eighteen thousand characters, into one
    /// uninterrupted turn; a note of one-line bullets put a few hundred into the
    /// same turn. The first is the shape that made the caret stutter, and the
    /// block count could not tell the two apart.
    ///
    /// Sized so an ordinary paragraph goes in one turn: below this and a batch
    /// is one long paragraph, above it several short ones. A single block always
    /// goes, whatever its length, because a block is the smallest thing this
    /// checker can be asked about and a budget that could refuse one would never
    /// finish. So a single very long paragraph still holds the thread for as
    /// long as it takes; bounding THAT means splitting a block, which changes
    /// what the checker sees across a sentence boundary and is not worth it.
    ///
    /// `jot-trace lint` prints `chars` and `ms` per round trip, which is where
    /// to read what this currently costs rather than trusting a figure here.
    private static let batchChars = 1000

    /// Lint every block, then answer once.
    ///
    /// `completion` is called exactly once, on the main actor, including when
    /// `blocks` is empty: the page holds its request open until it hears back,
    /// and it correlates the answer by id, so an unanswered batch is a request
    /// that never settles.
    func lint(blocks: [LintBlock], completion: @escaping @MainActor ([LintBlockResult]) -> Void) {
        drain(blocks[...], done: [], cost: Cost(), completion: completion)
    }

    /// What one `lint` cost the thread it ran on.
    ///
    /// Carried through the recursion beside `done` and `pending` rather than
    /// stored on the service, because nothing serializes two lint requests: a
    /// second one arriving mid-drain would reset counters held here and the
    /// first request's trace line would report the second's numbers. The
    /// coordinator holds ONE service per window and the page can have a request
    /// open when the next rescan fires, so that overlap is reachable.
    struct Cost {
        /// The longest UNINTERRUPTED main-thread hold, in seconds, which is the
        /// number the batch budget exists to bound.
        ///
        /// Total time is the wrong reading for it: a check spread over many
        /// turns costs the same total and costs the caret nothing, and a figure
        /// that only says how long the answer took cannot tell the two apart.
        /// This says how long the thread was unavailable at a stretch.
        var longestHold: TimeInterval = 0
        /// How many turns of the run loop it took.
        ///
        /// The testable half of `longestHold`, which is a duration and so is a
        /// figure a loaded machine can move. This one is arithmetic, and is
        /// what a test can assert without asserting a clock.
        var batches = 0
    }

    /// The cost of the most recently COMPLETED `lint`, for the trace line.
    ///
    /// Written once, when a drain finishes, so an overlapping request cannot
    /// blank it midway the way a counter stored per service did.
    ///
    /// What makes it right for the request being traced, and it is a constraint
    /// rather than an observation: the write sits IMMEDIATELY before
    /// `completion(done)`, with no suspension point between them, and both are
    /// on the main actor. A completion reads this and gets its own drain's cost,
    /// because nothing can interleave between those two lines. Put an `await`
    /// between them and a second request finishing in the gap becomes the figure
    /// this reports.
    private(set) var lastCost = Cost()

    /// One batch, then either the answer or a turn of the run loop.
    ///
    /// The state is passed along rather than captured, because a recursive
    /// local closure has to be captured by an escaping one to schedule itself,
    /// and that is a shared mutable box the compiler is right to warn about.
    private func drain(_ pending: ArraySlice<LintBlock>,
                       done: [LintBlockResult],
                       cost: Cost,
                       completion: @escaping @MainActor ([LintBlockResult]) -> Void) {
        var pending = pending
        var done = done
        var cost = cost
        var spent = 0
        let batchStart = Date()
        // `spent == 0` first, so the budget can never refuse the batch's first
        // block: a block longer than the whole budget still has to be checked,
        // and a loop that declined one would hand back the run loop forever.
        while spent == 0 || spent < Self.batchChars {
            guard let block = pending.first else { break }
            pending = pending.dropFirst()
            spent += block.text.count
            done.append(LintBlockResult(key: block.key, lints: check(block.text)))
        }
        cost.longestHold = max(cost.longestHold, Date().timeIntervalSince(batchStart))
        cost.batches += 1
        guard !pending.isEmpty else {
            lastCost = cost
            completion(done)
            return
        }
        // Back through the run loop, so a long document is checked in the gaps
        // rather than in front of the caret.
        let rest = pending
        let far = done
        let carried = cost
        Task { @MainActor [weak self] in
            self?.drain(rest, done: far, cost: carried, completion: completion)
        }
    }

    /// One block, checked and filtered.
    private func check(_ text: String) -> [HarperLint] {
        let ns = text as NSString
        guard ns.length > 0 else { return [] }
        let results = NSSpellChecker.shared.check(
            text,
            range: NSRange(location: 0, length: ns.length),
            types: NSTextCheckingResult.CheckingType([.spelling, .grammar]).rawValue,
            options: nil,
            inSpellDocumentWithTag: tag,
            orthography: nil,
            wordCount: nil)
        return lints(from: results, in: text)
    }

    /// Teach the system checker a word, which is what the page's "Add to
    /// dictionary" means on this surface. It is the SYSTEM's dictionary rather
    /// than a store of this app's own, so a word taught here is known to every
    /// app on the Mac, which is what a reader expects of a spell checker and is
    /// why this app keeps no user-word list.
    func learn(_ word: String) {
        NSSpellChecker.shared.learnWord(word)
    }

    private func lints(from results: [NSTextCheckingResult]?, in text: String) -> [HarperLint] {
        guard let results else { return [] }
        let ns = text as NSString
        var out: [HarperLint] = []
        for result in results {
            switch result.resultType {
            case .spelling:
                append(&out, range: result.range, in: ns, text: text, kind: "Spelling",
                       message: "Possible misspelling",
                       suggestions: guesses(for: result.range, in: text))
            case .grammar:
                // One result can carry several details, each with its own range
                // RELATIVE to the result's, and its own description.
                for detail in result.grammarDetails ?? [] {
                    // The detail's range is RELATIVE to the result's, which is
                    // the part of this API most easily got wrong: used as an
                    // absolute range it underlines the right number of
                    // characters in the wrong place, and only in sentences
                    // whose grammar hit is not at the start.
                    let local = (detail[NSGrammarRange] as? NSValue)?.rangeValue
                    let range = local.map {
                        NSRange(location: result.range.location + $0.location, length: $0.length)
                    } ?? result.range
                    append(&out, range: range, in: ns, text: text, kind: "Grammar",
                           message: detail[NSGrammarUserDescription] as? String ?? "Possible grammar issue",
                           suggestions: (detail[NSGrammarCorrections] as? [String]) ?? [])
                }
            default:
                continue
            }
        }
        return out
    }

    /// Add one finding, unless the filter says the span is not prose.
    private func append(_ out: inout [HarperLint], range: NSRange, in ns: NSString,
                        text: String, kind: String, message: String, suggestions: [String]) {
        guard range.location != NSNotFound,
              range.length > 0,
              range.location + range.length <= ns.length else { return }
        let spanText = ns.substring(with: range)
        // Anything touching a masked span is about content the reader does not
        // see as prose, whatever the kind, exactly as the extension has it.
        if spanText.unicodeScalars.contains(where: { $0.value == 0xFFFC }) { return }
        if Self.tokenKinds.contains(kind),
           ProofreadFilter.isTechSpan(text, start: range.location,
                                      end: range.location + range.length) { return }
        out.append(HarperLint(start: range.location,
                              end: range.location + range.length,
                              kind: kind,
                              message: message,
                              suggestions: Array(suggestions.prefix(5))))
    }

    private func guesses(for range: NSRange, in text: String) -> [String] {
        NSSpellChecker.shared.guesses(forWordRange: range, in: text,
                                      language: nil, inSpellDocumentWithTag: tag) ?? []
    }
}
