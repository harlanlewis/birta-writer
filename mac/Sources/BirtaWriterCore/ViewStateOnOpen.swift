import Foundation

/// Which of a file's remembered view state survives OPENING it, and which only
/// survives a view coming back.
///
/// The app remembers a bag per file (`Prefs.viewStateJSON`) holding table
/// widths, folds, list numbering, the formatting row, and the scroll offset.
/// Every one of those is a fact about the DOCUMENT and is right to restore
/// whenever the document is on screen again. The offset is not: where you were
/// reading is a fact about a READING, and a file opened again later opens at
/// the top the way every document in every editor does.
///
/// The two are told apart by what the page load IS rather than by anything the
/// bag holds:
///
///   opening   the window is being pointed at this file. A launch, a rebind,
///             Open Recent, Open With. The offset goes.
///   remount   the same window, on the same file, building its page again: a
///             settings change reloads the page, and a WebKit content process
///             that died is recovered by reloading it. The offset stays,
///             because from the reader's side nothing happened and being
///             thrown to the top of a long note by flipping a setting is the
///             behaviour this distinction exists to avoid.
///
/// HERE rather than at the call site, and not merely for the test: the same
/// rule has a page-side half (`withoutScroll` in `webview/messageHandlers.ts`,
/// which refuses the offset out of the host's per-file echo), and a rule split
/// across two languages needs each half to be readable on its own. The page's
/// half is what makes VS Code obey it too; this half is what keeps the Mac
/// app's settings reload from losing your place, because the Mac shim seeds
/// the page's live state bag from this JSON and the page cannot tell the two
/// apart once it has arrived.
///
/// Text in, text out. The bag crosses into the page as JSON and this is the
/// only thing on this side that looks inside it, so a `Codable` model of a bag
/// whose other keys belong entirely to the page would be a second declaration
/// of a shape this side has no business knowing.
public enum ViewStateOnOpen {
    /// The key the page stores the scroll offset under
    /// (`webview/scrollPersistence.ts`).
    ///
    /// A name that has drifted apart from the page's silently stops stripping
    /// anything, which is why `ViewStateOnOpenTests` asserts against a bag that
    /// really carries it rather than against this constant alone.
    static let scrollKey = "scrollY"

    /// The bag to hand a page that is OPENING `json`'s file.
    ///
    /// Nil in, nil out: a file with nothing remembered stays that way rather
    /// than becoming an empty object, so the page's own "no view state" arm is
    /// the one that runs. Unparseable in, unchanged out, for the same reason
    /// `Prefs` hands this JSON around as text: this type is not the one that
    /// gets to decide a bag it cannot read is worthless.
    public static func forOpen(_ json: String?) -> String? {
        guard let json,
              let data = json.data(using: .utf8),
              var bag = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              bag[scrollKey] != nil else {
            return json
        }
        bag.removeValue(forKey: scrollKey)
        guard let out = try? JSONSerialization.data(withJSONObject: bag,
                                                    options: [.sortedKeys]) else {
            return json
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// The bag to hand a page that is REMOUNTING on the file it is already on.
    ///
    /// The identity, and it exists to be called. A remount reading
    /// `viewStateJSON` directly would be a call site with no name on it, which
    /// is how the two cases stop being told apart at all: the difference would
    /// live in whether somebody remembered to wrap one of them.
    public static func forRemount(_ json: String?) -> String? { json }
}
