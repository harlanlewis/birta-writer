import Foundation

/// The hosts the page's content-security-policy may name, restated for Swift.
///
/// The list itself belongs to `shared/embedProviders.ts`, which is the one
/// place a provider is added: its extractor, its card and the extension's own
/// CSP grants all read from there. Swift cannot import TypeScript, so this is
/// a second copy in the same shape the host profile's capabilities are, and it
/// is held to the original by `shared/__tests__/macCsp.test.ts` rather than by
/// anybody remembering. Adding a provider is a two-file change, and forgetting
/// the second file fails a test rather than rendering a blank frame nobody can
/// explain.
///
/// Why the app pins hosts at all, when it could open the whole of `https:` the
/// moment the network switch goes on: an embed is the only place in either
/// surface where somebody else's JavaScript runs inside the editor's own page,
/// and a document can carry a link to any host there is. The grant is what
/// decides which of those a document can put a frame around, so it is the
/// difference between a page that can frame the providers the card table
/// understands and one that can frame anything a link names.
public enum EmbedHosts {
    /// Framed by an embed card's player. Mirrors `EMBED_CSP_FRAME_HOSTS`.
    public static let frameSrc: [String] = [
        "https://www.youtube-nocookie.com",
        "https://player.vimeo.com",
        "https://www.loom.com",
        "https://embed.figma.com",
        "https://www.figma.com",
        "https://drive.google.com",
        "https://docs.google.com",
        "https://miro.com",
        "https://codepen.io",
        "https://codesandbox.io",
        "https://stackblitz.com",
    ]

    /// Loaded as an image by a card's facade. Mirrors `EMBED_CSP_IMG_HOSTS`.
    public static let imgSrc: [String] = [
        "https://i.ytimg.com",
    ]
}
