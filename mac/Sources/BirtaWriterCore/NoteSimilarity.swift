import Accelerate
import Foundation
import NaturalLanguage

/// Which notes in a folder are alike in what they say, whether or not either
/// links the other: the `similar` pairs the folder index carries
/// (`FolderIndex.similar`, `FolderSimilarity` in shared/folderIndex.ts).
///
/// Each note is turned into a vector by Apple's contextual embedding
/// (NaturalLanguage's `NLContextualEmbedding`, English, a transformer that
/// runs on this Mac), averaged over the note's words. Only when its model is
/// already on the Mac: the app never asks macOS to fetch it (`systemEmbedder`),
/// since that download would be a request the reader did not make. Nothing
/// is sent anywhere. What is embedded is a note's title and the opening of its
/// body (`excerpt`), never more, so a vector says what a note is about rather
/// than everything in it.
///
/// Not the older `NLEmbedding.sentenceEmbedding`, which is quicker and
/// always present: on notes it was tried against, it called unrelated
/// notes alike as readily as related ones, and a likeness drawn on screen
/// that is not one costs more than a likeness left out.
///
/// Raw cosine similarity between these vectors is a poor ranking on its own:
/// every note shares a large common component (it is English, it is a note),
/// so unrelated notes score as high as related ones. So the folder's mean
/// vector is subtracted first, which leaves what distinguishes each note
/// from the rest of its folder (`pairs`). A pair is kept only when it clears
/// `threshold` and each note is among the other's `perNote` closest, so a
/// note alike to nothing in particular is joined to nothing.
///
/// These are claims the reader did not make, so the page draws and weighs
/// them apart from links: dashed, a weaker tie, and never a reason to call a
/// note relied on (webview/components/graph).
public enum NoteSimilarity {
    /// The least centred cosine a pair is kept at. Centred, unrelated notes
    /// sit near zero or below with this model, so the line is drawn a little
    /// above zero rather than where raw cosines would put it.
    public static let threshold: Float = 0.15

    /// The most alike notes kept per note, each way.
    public static let perNote = 3

    /// How much of a note's body, in characters, joins its title.
    public static let excerptLength = 400

    /// A vector per text, or nil where none can be made.
    public typealias Embedder = (String) -> [Float]?

    /// The embedder the app uses: the English contextual embedding, its
    /// token vectors averaged into one per text. Nil on a Mac whose model is
    /// not already installed, or that cannot load it, which leaves the index
    /// with no `similar` pairs.
    public static func systemEmbedder() -> Embedder? {
        guard let embedding = NLContextualEmbedding(language: .english),
              embedding.hasAvailableAssets,
              (try? embedding.load()) != nil else { return nil }
        let dimension = embedding.dimension
        // Not documented as safe across threads, and the index is built off
        // the main thread: one lock, held per text.
        let lock = NSLock()
        return { text in
            lock.lock()
            defer { lock.unlock() }
            guard !text.isEmpty, let result = try? embedding.embeddingResult(for: text, language: .english) else { return nil }
            var sum = [Float](repeating: 0, count: dimension)
            var count: Float = 0
            result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vector, _ in
                for i in 0..<min(dimension, vector.count) { sum[i] += Float(vector[i]) }
                count += 1
                return true
            }
            return count > 0 ? sum.map { $0 / count } : nil
        }
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
