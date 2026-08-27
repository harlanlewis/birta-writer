import Foundation

/// What the About window says, decided with no window and no bundle around it.
///
/// The window is an icon, three lines and a row of links, so the part worth
/// holding here is WHICH strings those lines carry. Two of the three have a
/// rule: a version has to distinguish a release from a build somebody made off
/// the tree, and a copyright can be absent, since it lives in Info.plist and a
/// process running without a bundle has none to read.
public struct AboutInfo: Sendable, Equatable {
    /// The app as it names itself everywhere else: its menus, its window
    /// titles, its bundle in the Finder. Carries the flavour suffix, so a
    /// development copy says so here as well.
    public let name: String
    /// One line under the name, either a version to quote or a statement that
    /// there is none.
    public let versionLine: String
    /// The copyright line, or nil when there is no bundle to read one from.
    ///
    /// Absent rather than invented. `Info.plist`'s `NSHumanReadableCopyright`
    /// is where macOS itself looks, for the Finder's Get Info and for the
    /// standard About panel, so a second copy in Swift would be a year to
    /// maintain in two places and to disagree about.
    public let copyright: String?

    /// The version every build carries but a released one.
    ///
    /// `docs/RELEASING.md`: the release job is the only version authority and
    /// stamps `CFBundleShortVersionString` on its way out, so anything built
    /// anywhere else says this.
    public static let unstampedVersion = "0.0.0"

    /// This project, as GitHub names it.
    ///
    /// One string with three consumers, which is why it is here rather than at
    /// any of them: the Source Code link, the Report an Issue link, and the
    /// release feed `Updater` polls. They must name one repository or the app
    /// offers updates from somewhere other than where it sends bug reports.
    public static let repository = "harlanlewis/birta-writer"

    /// Birta Labs, whose product this is.
    public static let website = "https://www.birtalabs.com"

    public init(name: String, shortVersion: String?, copyright: String?) {
        self.name = name
        self.versionLine = Self.versionLine(shortVersion: shortVersion)
        // An empty string and an unset key are one absence: a plist carrying
        // the key with nothing in it would otherwise reserve a blank line.
        if let copyright, !copyright.isEmpty {
            self.copyright = copyright
        } else {
            self.copyright = nil
        }
    }

    /// This build, as its bundle describes it.
    public static var current: AboutInfo {
        AboutInfo(name: AppFlavor.current.displayName,
                  shortVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
                  copyright: Bundle.main.infoDictionary?["NSHumanReadableCopyright"] as? String)
    }

    /// `Version 2026.821.0` for a release, and what an unstamped build is for
    /// anything else.
    ///
    /// The distinction is the whole point of the line. A version is something
    /// to quote in a bug report, and `Version 0.0.0` invites somebody to quote
    /// a number that identifies no release and dates nothing.
    public static func versionLine(shortVersion: String?) -> String {
        guard let version = shortVersion, !version.isEmpty, version != unstampedVersion else {
            return "Development build"
        }
        return "Version \(version)"
    }
}

/// Where the About window can send somebody, in the order it draws them.
///
/// An enum rather than a list built at the window, so the row that draws them
/// and the test that checks it read the same declaration: a link added here
/// reaches the window with no other edit, and a check written over
/// `allCases` cannot miss it.
public enum AboutLink: String, CaseIterable, Sendable {
    case website = "Website"
    case source = "Source Code"
    case issues = "Report an Issue"

    /// The title the row draws. The raw value, so a case cannot be added
    /// without naming itself.
    public var title: String { rawValue }

    public var address: String {
        switch self {
        case .website: return AboutInfo.website
        case .source: return "https://github.com/\(AboutInfo.repository)"
        case .issues: return "https://github.com/\(AboutInfo.repository)/issues"
        }
    }

    /// Force-unwrapped because these are literals assembled here: a URL that
    /// does not parse is a typo in this file, which `AboutInfoTests` fails on
    /// rather than shipping a link that goes nowhere.
    public var url: URL { URL(string: address)! }
}
