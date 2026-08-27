import Foundation

/// Whether a notes folder wears the app's mark, and how the mark sits on it.
///
/// The Finder shows a custom icon for a folder when the folder contains a file
/// named `Icon\r`, with its own custom-icon flag set. That is the mechanism
/// every app whose folder is marked in iCloud Drive uses, and it is worth
/// naming here because it decides two things this type answers.
///
/// First, the mark is a FILE inside the user's folder. It syncs, it shows up in
/// a directory listing that ignores the hidden flag, and it is the user's to
/// delete: removing it puts the plain folder back and nothing here fights that.
/// So the decision is made once, on a folder that does not already have one,
/// rather than reasserted on every launch.
///
/// Second, the geometry is a composition rather than a replacement. Handing the
/// Finder the app icon alone gives a folder that no longer reads as a folder,
/// which is the thing that makes a badged folder legible: it says "a folder,
/// and this app's". So the app's mark is drawn INTO the system's own folder
/// picture, at the proportions below.
///
/// The AppKit half is `BirtaJot/FolderIcon.swift`. Everything decidable without
/// a drawing context is here, so it can be checked without one.
public enum FolderIcon {
    /// What the Finder looks for. `\r` and not `\n`, which is not a typo and
    /// is the whole of why this constant exists rather than being spelled at
    /// the two call sites: the name ends in a carriage return, which is
    /// invisible in every listing that shows it and impossible to notice as a
    /// mistake.
    public static let markerName = "Icon\r"

    /// How much of the folder's width the app's mark takes.
    ///
    /// Measured off what the Finder itself does for the folders that carry one:
    /// the badge is a little over half the width, sitting on the folder's front
    /// face rather than filling it, because the tab along the top edge is what
    /// says "folder" and covering it takes that away.
    public static let markScale: CGFloat = 0.56

    /// Where the mark's centre sits, as a fraction of the folder's height
    /// measured from the bottom.
    ///
    /// Below the middle, and deliberately. A folder icon is not vertically
    /// symmetric: the tab occupies the top, so the front face's own centre is
    /// lower than the image's, and a mark centred on the image reads as
    /// floating high.
    public static let markCentreFromBottom: CGFloat = 0.44

    /// Whether `folder` already carries a custom icon.
    ///
    /// Asked of the marker file rather than of the icon the Finder reports,
    /// because the question is whether somebody (this app, on an earlier
    /// launch, or the user with their own picture) has already decided. An app
    /// that re-badged a folder the user had deliberately given a photo to would
    /// be taking a choice away on every launch.
    public static func isMarked(_ folder: URL,
                                exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> Bool {
        exists(folder.appendingPathComponent(markerName))
    }

    /// The rect the mark is drawn into, given the folder image's size.
    ///
    /// Square, because the app's icon is, and centred horizontally: the only
    /// interesting number is the vertical one, and it is stated above.
    public static func markRect(in size: CGSize) -> CGRect {
        let side = size.width * markScale
        return CGRect(x: (size.width - side) / 2,
                      y: size.height * markCentreFromBottom - side / 2,
                      width: side,
                      height: side)
    }

    /// Whether this folder should be marked now.
    ///
    /// It has to exist, because badging a folder would otherwise create it, and
    /// the folders this app names are ones it may only be about to use: the
    /// location a person is still choosing on the first-run screen is exactly
    /// the folder that must not be brought into being by a decoration.
    public static func shouldMark(_ folder: URL,
                                  isDirectory: (URL) -> Bool = {
                                      var directory: ObjCBool = false
                                      let there = FileManager.default.fileExists(atPath: $0.path,
                                                                                 isDirectory: &directory)
                                      return there && directory.boolValue
                                  },
                                  exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> Bool {
        isDirectory(folder) && !isMarked(folder, exists: exists)
    }
}
