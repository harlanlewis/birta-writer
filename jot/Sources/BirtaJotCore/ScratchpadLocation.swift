import Foundation

/// WHERE Jot keeps the one file a person who has changed no settings ever
/// sees, and the only place that question is answered.
///
/// Two homes, and the setting chooses between them:
///
///     iCloud    <iCloud Drive>/Birta Writer Jot/Birta Writer Jot.md
///     local     ~/Documents/Birta Writer/Birta Writer Jot.md
///
/// Both are places a person can find in Finder, which is the whole reason
/// neither is Application Support any more: a scratchpad kept in a Library
/// folder is a file the app can open and its owner cannot, and the first thing
/// anybody asks of a note is where it went.
///
/// The folder names differ between the two on purpose, and it is not an
/// oversight to tidy up. iCloud Drive's top level is a list of applications,
/// so a folder there is named after the app; `~/Documents` is the user's own,
/// where a folder named after the app would claim more than Jot is, and the
/// note sits with anything else Birta Writer keeps.
///
/// Pure, and takes its two roots as arguments rather than reading
/// `FileManager` for them, so a test names a temporary directory and gets a
/// real answer. `Prefs` is the one caller that supplies the real roots.
public enum ScratchpadLocation: String, CaseIterable, Sendable {
    case iCloud
    case local

    /// The app's own name, and the only spelling of it that reaches the
    /// filesystem.
    ///
    /// `JOT_PRODUCT_NAME` in shared/product.ts is the source; Swift cannot
    /// import TypeScript, so this restates it and the drift test in
    /// `shared/__tests__/editorCommandsContributions.test.ts` reads this file
    /// and fails when the two disagree. It lives HERE rather than in `Prefs`
    /// because this is where the name is spent, and a constant the paths do
    /// not read is one that agrees with its test rather than with the app.
    public static let productName = "Birta Writer Jot"

    /// The company's product line, which is what the LOCAL folder is named
    /// after. `PRODUCT_NAME` in shared/product.ts is its source, held to it by
    /// the same drift test.
    public static let suiteName = "Birta Writer"

    /// The folder each home puts the note in, relative to its own root.
    ///
    /// Both are derived rather than spelled, so a rename reaches the paths
    /// through the same two constants the drift test holds.
    public var folderName: String {
        switch self {
        case .iCloud: return Self.productName
        case .local: return Self.suiteName
        }
    }

    /// The note's own name. The same in both homes: it is what the window
    /// titles itself with, and a file that renamed itself when the setting
    /// moved would be a different note to anyone reading the title.
    public static let fileName = "\(productName).md"

    /// The note's path under `root`.
    public func url(root: URL) -> URL {
        root
            .appendingPathComponent(folderName, isDirectory: true)
            .appendingPathComponent(Self.fileName)
    }

    /// The user's iCloud Drive folder, or nil when iCloud Drive is off.
    ///
    /// `com~apple~CloudDocs` under Mobile Documents IS iCloud Drive, the
    /// folder Finder shows in the sidebar. Deliberately not a ubiquity
    /// container (`FileManager.url(forUbiquityContainerIdentifier:)`), which is
    /// the API this looks like it should use and cannot: a container needs an
    /// iCloud entitlement, which needs a provisioning profile from a paid
    /// developer account, and Jot is ad-hoc signed (jot/scripts/build-app.sh).
    /// A container would also put the note somewhere Finder shows only under
    /// the app's own name, when the point is a folder the user can open.
    ///
    /// EXISTENCE is the test, and it is the right one: the folder is created
    /// by macOS when iCloud Drive is switched on and is absent when it is off,
    /// so its presence answers "can this machine sync" without asking iCloud
    /// anything or waiting for a network.
    public static func iCloudDriveRoot(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileManager: FileManager = .default
    ) -> URL? {
        let root = home
            .appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs", isDirectory: true)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: root.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { return nil }
        return root
    }

    /// Which home is in force, given the setting and whether iCloud is there.
    ///
    /// The setting alone cannot decide it: `storeInICloud` defaults to ON, and
    /// a machine with iCloud Drive switched off has nowhere to put the file, so
    /// honouring the preference literally would write into a folder that does
    /// not exist and fail on first launch. The fallback is silent by design and
    /// the Settings row says which one it landed on, because a warning about a
    /// service the user has deliberately turned off is not news to them.
    public static func inForce(preferICloud: Bool, iCloudAvailable: Bool) -> ScratchpadLocation {
        preferICloud && iCloudAvailable ? .iCloud : .local
    }
}
