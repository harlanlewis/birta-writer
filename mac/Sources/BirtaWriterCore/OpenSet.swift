import Foundation

/// The windows the app had open, as a launch puts them back.
///
/// A window is the unit of everything in this app (one buffer, one bound file,
/// one title), and a launch restores the windows rather than deriving one from
/// the three app-wide file settings. Those settings answer a different
/// question: which setting a rename writes back to. They say nothing about
/// which file a person was WORKING in, and the document slot among them
/// persists until it is released, so a launch that read it would land on a
/// file opened once, long ago, over everything worked in since. What a launch
/// restores is what was on screen, in the order it was on screen, with the
/// window the person last had the keyboard in at the front.
///
/// So this is a recording of the windows: one `Group` per window (per window
/// GROUP once tabs exist: a tab is a window, and a group of tabs shares one
/// frame), back to front, so the last group is the one that was in front.
/// Membership is by path, compared through the `sameFile` predicate the caller
/// supplies, so two spellings of one file (a symlinked folder, a
/// case-insensitive volume) are one file here as they are everywhere else in
/// the app; this type does no filesystem work of its own, which is what lets
/// the launch rules be checked with no window server and no disk.
///
/// ## What a launch decides, and in what order
///
/// `launchPlan` answers three questions, in this order because each outranks
/// the next.
///
/// 1. A file this launch was ASKED to open (Open With in the Finder, a Dock
///    drop, `open -a`) is in front, whatever else comes back. If it was already
///    among the open windows its group is fronted and its tab selected; if not
///    it gets a group of its own at the front. Nothing else is added: a person
///    who double-clicked a file did not ask for a blank note beside it.
/// 2. "New windows open with: New file" is honoured by putting a blank note in
///    front of the restored set, not instead of it. The setting is about what a
///    person wants to be TYPING INTO when the app comes up; throwing away the
///    arrangement they had is a different thing wearing similar words, and it
///    is the loss MAR-421 was filed about. An untouched blank note already in
///    the set is fronted rather than joined by a second one, or a person who
///    quits and relaunches a few times accumulates empty notes.
/// 3. With nothing recorded there is nothing to restore, and the single window
///    opens on the most recently used file that still exists, then on whatever
///    the settings name. The recents list is ordered by use (a file joins it
///    when it leaves the screen), which is the closest thing to "what you were
///    working in" a launch with no recording can reach.
///
/// Tabs whose file is gone are dropped before any of that, and a group left
/// with none is dropped too: a note deleted in the Finder while the app was
/// quit must not come back as a window standing on a missing file.
public struct OpenSet: Codable, Equatable, Sendable {
    /// One window, or one group of tabs sharing a frame.
    public struct Group: Codable, Equatable, Sendable {
        /// The directory a window is rooted at, for a window with a file
        /// explorer. Nil for an ordinary file window.
        public var root: String?
        /// The files open as tabs, in bar order; one entry for a window with
        /// no tab bar.
        public var tabs: [String]
        /// Which tab was showing.
        public var selected: Int
        /// The window's frame, as `NSStringFromRect` spells it, or nil for a
        /// window that never reported one. The app layer converts; this type
        /// carries it so a launch can put each window back where it was.
        public var frame: String?

        public init(root: String? = nil, tabs: [String], selected: Int = 0, frame: String? = nil) {
            self.root = root
            self.tabs = tabs
            self.selected = selected
            self.frame = frame
        }

        /// The tab that was showing, clamped into the list: a recording made
        /// with three tabs and pruned to two still names a real tab.
        public var selectedTab: String? {
            guard !tabs.isEmpty else { return nil }
            return tabs[min(max(selected, 0), tabs.count - 1)]
        }
    }

    /// Back to front: the last group is the one that was in front.
    public var groups: [Group]

    public init(groups: [Group] = []) {
        self.groups = groups
    }

    public var isEmpty: Bool { groups.isEmpty }

    /// Every path the set holds, front group last.
    public var paths: [String] { groups.flatMap(\.tabs) }

    // MARK: storage

    /// The bytes a defaults store keeps. JSON rather than a property list of
    /// our own shape, so the stored form and the in-memory one are one type.
    public func encoded() throws -> Data {
        try JSONEncoder().encode(self)
    }

    /// Nil for anything that does not decode, which a launch reads as "nothing
    /// recorded" and falls through to the single-window rule: an install
    /// upgrading across a change to this shape forgets one arrangement rather
    /// than failing to launch.
    public static func decoded(_ data: Data) -> OpenSet? {
        try? JSONDecoder().decode(OpenSet.self, from: data)
    }

    // MARK: editing

    /// The set with every tab that `exists` refuses dropped, each group's
    /// selection clamped, and every group left empty removed.
    public func pruned(exists: (String) -> Bool) -> OpenSet {
        OpenSet(groups: groups.compactMap { group in
            var kept = group
            kept.tabs = group.tabs.filter(exists)
            guard !kept.tabs.isEmpty else { return nil }
            kept.selected = min(max(group.selected, 0), kept.tabs.count - 1)
            if let showing = group.selectedTab, let index = kept.tabs.firstIndex(of: showing) {
                kept.selected = index
            }
            return kept
        })
    }

    /// The set with the group holding `path` moved to the front and that tab
    /// selected, or nil when no group holds it. `sameFile` decides what holding
    /// means; the default is spelling equality.
    public func fronting(_ path: String,
                         sameFile: (String, String) -> Bool = { $0 == $1 }) -> OpenSet? {
        guard let index = groups.firstIndex(where: { $0.tabs.contains { sameFile($0, path) } }) else {
            return nil
        }
        var moved = groups
        var group = moved.remove(at: index)
        group.selected = group.tabs.firstIndex { sameFile($0, path) } ?? group.selected
        moved.append(group)
        return OpenSet(groups: moved)
    }

    // MARK: launch

    /// What a launch builds.
    public struct LaunchPlan: Equatable, Sendable {
        /// The groups to restore, back to front. Every tab in every group
        /// exists, and the caller may build them in this order and end up
        /// with the right one in front.
        public var groups: [Group]
        /// Whether a fresh blank note goes in front of them all. The caller
        /// makes the file, because making a file is not this type's to do.
        public var opensBlankNote: Bool

        public init(groups: [Group], opensBlankNote: Bool) {
            self.groups = groups
            self.opensBlankNote = opensBlankNote
        }
    }

    /// The windows a launch opens. The header states the three rules and
    /// their order; this is them.
    ///
    /// - Parameters:
    ///   - stored: the set as last recorded, possibly empty.
    ///   - exists: whether a path is still on disk.
    ///   - isBlank: whether a path names a note with nothing in it, so the
    ///     blank-note setting can front one that is already open.
    ///   - recents: the recents list, most recently used first.
    ///   - fallback: what the settings name, for a launch with nothing else to
    ///     go on. Always opened when nothing else is; never nil.
    ///   - openToBlankNote: the "New windows open with" setting, on its "New
    ///     file" answer.
    ///   - launchedWith: the file this launch was asked to open, if any.
    ///   - sameFile: whether two paths name one file. The default is spelling
    ///     equality, which is right for a test and not for a disk.
    public static func launchPlan(stored: OpenSet,
                                  exists: (String) -> Bool,
                                  isBlank: (String) -> Bool,
                                  recents: [String],
                                  fallback: String,
                                  openToBlankNote: Bool,
                                  launchedWith: String?,
                                  sameFile: (String, String) -> Bool = { $0 == $1 }) -> LaunchPlan {
        var set = stored.pruned(exists: exists)

        if let asked = launchedWith {
            if let fronted = set.fronting(asked, sameFile: sameFile) {
                set = fronted
            } else {
                set.groups.append(Group(tabs: [asked]))
            }
            return LaunchPlan(groups: set.groups, opensBlankNote: false)
        }

        if openToBlankNote {
            if let blank = set.paths.last(where: isBlank), let fronted = set.fronting(blank, sameFile: sameFile) {
                return LaunchPlan(groups: fronted.groups, opensBlankNote: false)
            }
            return LaunchPlan(groups: set.groups, opensBlankNote: true)
        }

        if set.isEmpty {
            let single = recents.first(where: exists) ?? fallback
            return LaunchPlan(groups: [Group(tabs: [single])], opensBlankNote: false)
        }
        return LaunchPlan(groups: set.groups, opensBlankNote: false)
    }
}
