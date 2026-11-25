import Accelerate
import Foundation
import NaturalLanguage

/// Which notes in a folder are alike in what they say, whether or not either
/// links the other: the `similar` pairs the folder index carries
/// (`FolderIndex.similar`, `FolderSimilarity` in shared/folderIndex.ts).
///
/// Each note is turned into a vector by Apple's contextual embedding
/// (NaturalLanguage's `NLContextualEmbedding`, a transformer that runs on
/// this Mac), averaged over the note's words, in the note's own language:
/// macOS has one model per family of scripts (one covers some twenty
/// Latin-script languages), so the language is detected first and the note
/// is read by the model for it. Only a model already on the Mac is used: the
/// app never asks macOS to fetch one (`systemEmbedder`), since that download
/// would be a request the reader did not make, so a language whose model is
/// not installed gets no vectors. Nothing is sent anywhere. What is embedded
/// is a note's title and the opening of its body (`excerpt`), never more, so
/// a vector says what a note is about rather than everything in it.
///
/// Notes are compared only with notes read by the same model (`Embedding`'s
/// `space`, `pairs(grouped:)`), since two models' vectors share no space at
/// all. Within one model, notes in two languages are compared too: the model
/// places one meaning in two languages no nearer each other than unrelated
/// notes, so a pair across languages does not form, and grouping by the
/// model rather than by the detected language is what keeps a short note
/// whose language was guessed wrong among its real neighbours.
///
/// Not the older `NLEmbedding.sentenceEmbedding`, which is quicker and
/// always present: on notes it was tried against, it called unrelated
/// notes alike as readily as related ones, and a likeness drawn on screen
/// that is not one costs more than a likeness left out.
///
/// Raw cosine similarity between these vectors is a poor ranking on its own:
/// every note shares a large common component (its language, that it is a
/// note), so unrelated notes score as high as related ones. So the mean
/// vector of the notes compared is subtracted first, which leaves what
/// distinguishes each note from the rest (`pairs`). A pair is kept only when
/// it clears `threshold` and each note is among the other's `perNote`
/// closest, so a note alike to nothing in particular is joined to nothing.
///
/// These are claims the reader did not make, so the page draws and weighs
/// them apart from links: dashed, credited to the model, a weaker tie, and
/// never a reason to call a note relied on (webview/components/graph).
public enum NoteSimilarity {
    /// The least centred cosine a pair is kept at. Centred, unrelated notes
    /// sit near zero or below with this model, so the line is drawn a little
    /// above zero rather than where raw cosines would put it.
    public static let threshold: Float = 0.15

    /// The most alike notes kept per note, each way.
    public static let perNote = 3

    /// How much of a note's body, in characters, joins its title.
    public static let excerptLength = 400

    /// A note's vector, the model whose space it is in (only notes of one
    /// space are compared), and the language it was read as.
    public struct Embedding: Equatable, Sendable {
        public let space: String
        public let language: String
        public let vector: [Float]

        public init(space: String, language: String, vector: [Float]) {
            self.space = space
            self.language = language
            self.vector = vector
        }
    }

    /// An embedding per text, or nil where none can be made.
    public typealias Embedder = (String) -> Embedding?

    /// The embedder the app shares across every folder: `systemEmbedder`,
    /// made the first time it is asked for a vector rather than when the app
    /// starts, and so on whatever thread first asks, which is the folder
    /// index's queue and never the main thread.
    public static let system: Embedder = {
        let lock = NSLock()
        var made: Embedder?
        return { text in
            lock.lock()
            if made == nil { made = systemEmbedder() }
            let embed = made!
            lock.unlock()
            return embed(text)
        }
    }()

    /// The embedder the app uses. Each text's language is detected, and the
    /// text read by the contextual model for that language, loaded the first
    /// time a text in it is seen, if macOS has it installed; its token vectors
    /// are averaged into one. A text whose language cannot be told, or whose
    /// model is not installed or will not load, gets no vector, and is then
    /// compared with nothing rather than read by a model that does not know
    /// its language.
    public static func systemEmbedder() -> Embedder {
        // Models by identifier: several languages share one, and loading it
        // once serves them all. Not documented as safe across threads, and
        // the index is built off the main thread: one lock, held per text.
        var models: [String: NLContextualEmbedding] = [:]
        var refused: Set<String> = []
        let lock = NSLock()
        return { text in
            lock.lock()
            defer { lock.unlock() }
            guard !text.isEmpty, let language = NLLanguageRecognizer.dominantLanguage(for: text),
                  !refused.contains(language.rawValue) else { return nil }
            guard let model = NLContextualEmbedding(language: language), model.hasAvailableAssets else {
                refused.insert(language.rawValue)
                return nil
            }
            let loaded: NLContextualEmbedding
            if let known = models[model.modelIdentifier] {
                loaded = known
            } else {
                guard (try? model.load()) != nil else { refused.insert(language.rawValue); return nil }
                models[model.modelIdentifier] = model
                loaded = model
            }
            guard let result = try? loaded.embeddingResult(for: text, language: language) else { return nil }
            let dimension = loaded.dimension
            var sum = [Float](repeating: 0, count: dimension)
            var count: Float = 0
            result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vector, _ in
                for i in 0..<min(dimension, vector.count) { sum[i] += Float(vector[i]) }
                count += 1
                return true
            }
            return count > 0 ? Embedding(space: loaded.modelIdentifier, language: language.rawValue, vector: sum.map { $0 / count }) : nil
        }
    }

    /// The fewest notes in one space worth comparing: centring two notes
    /// leaves them exact opposites, so two can never be alike.
    public static let minimumGroup = 3

    /// The pairs among `embeddings` (by note path), each model's space
    /// compared on its own (`pairs`), merged and sorted by path.
    public static func pairs(grouped embeddings: [String: Embedding]) -> [Pair] {
        var bySpace: [String: [String: [Float]]] = [:]
        for (path, e) in embeddings { bySpace[e.space, default: [:]][path] = e.vector }
        return bySpace.values.filter { $0.count >= minimumGroup }.flatMap { pairs($0) }
            .sorted { $0.a != $1.a ? $0.a < $1.a : $0.b < $1.b }
    }

    /// What a note is embedded from: its title, then the opening of its body
    /// as words alone, the frontmatter and every mark of punctuation taken
    /// out, so a heading's `#` or a link's brackets do not count as words.
    public static func excerpt(title: String, text: String) -> String {
        let body = Frontmatter.split(text).body
        var cleaned = ""
        cleaned.reserveCapacity(excerptLength)
        var lastWasSpace = true
        for ch in body {
            if cleaned.count >= excerptLength { break }
            let keep = ch.isLetter || ch.isNumber || ch == "'"
            if keep {
                cleaned.append(ch)
                lastWasSpace = false
            } else if !lastWasSpace {
                cleaned.append(" ")
                lastWasSpace = true
            }
        }
        let opening = cleaned.trimmingCharacters(in: .whitespaces)
        return opening.isEmpty ? title : "\(title). \(opening)"
    }

    /// One kept pair, its paths in order, with its centred cosine.
    public struct Pair: Equatable, Sendable {
        public let a: String
        public let b: String
        public let score: Float

        public init(a: String, b: String, score: Float) {
            self.a = a
            self.b = b
            self.score = score
        }
    }

    /// The pairs among `vectors` (by note path) worth keeping: centred, then
    /// compared all at once as one matrix product, then filtered to mutual
    /// top-`perNote` neighbours at or above `threshold`. Sorted by path so
    /// the same folder gives the same list.
    public static func pairs(_ vectors: [String: [Float]]) -> [Pair] {
        let paths = vectors.keys.sorted()
        let n = paths.count
        guard n >= 2, let dim = vectors[paths[0]]?.count, dim > 0,
              paths.allSatisfy({ vectors[$0]!.count == dim }) else { return [] }

        // Rows of the matrix, centred and scaled to unit length, so a row
        // times a row is a cosine.
        var m = [Float](repeating: 0, count: n * dim)
        for (i, p) in paths.enumerated() { m.replaceSubrange(i * dim..<(i + 1) * dim, with: vectors[p]!) }
        var mean = [Float](repeating: 0, count: dim)
        for i in 0..<n { vDSP_vadd(mean, 1, Array(m[i * dim..<(i + 1) * dim]), 1, &mean, 1, vDSP_Length(dim)) }
        var inv = 1 / Float(n)
        vDSP_vsmul(mean, 1, &inv, &mean, 1, vDSP_Length(dim))
        for i in 0..<n {
            var row = Array(m[i * dim..<(i + 1) * dim])
            vDSP_vsub(mean, 1, row, 1, &row, 1, vDSP_Length(dim))
            var norm: Float = 0
            vDSP_svesq(row, 1, &norm, vDSP_Length(dim))
            norm = norm.squareRoot()
            if norm > 0 { var s = 1 / norm; vDSP_vsmul(row, 1, &s, &row, 1, vDSP_Length(dim)) }
            m.replaceSubrange(i * dim..<(i + 1) * dim, with: row)
        }
        // All cosines at once: M times M transposed.
        var t = [Float](repeating: 0, count: dim * n)
        vDSP_mtrans(m, 1, &t, 1, vDSP_Length(dim), vDSP_Length(n))
        var sims = [Float](repeating: 0, count: n * n)
        vDSP_mmul(m, 1, t, 1, &sims, 1, vDSP_Length(n), vDSP_Length(n), vDSP_Length(dim))

        // Each note's closest, by score then path.
        var top = [Set<Int>](repeating: [], count: n)
        for i in 0..<n {
            let ranked = (0..<n).filter { $0 != i && sims[i * n + $0] >= threshold }
                .sorted { sims[i * n + $0] != sims[i * n + $1] ? sims[i * n + $0] > sims[i * n + $1] : paths[$0] < paths[$1] }
            top[i] = Set(ranked.prefix(perNote))
        }
        var out: [Pair] = []
        for i in 0..<n {
            for j in top[i] where j > i && top[j].contains(i) {
                // Two places, so a vector that wobbles in the last digit does
                // not make an index that changes on every build.
                out.append(Pair(a: paths[i], b: paths[j], score: (sims[i * n + j] * 100).rounded() / 100))
            }
        }
        return out.sorted { $0.a != $1.a ? $0.a < $1.a : $0.b < $1.b }
    }
}
