import AppKit
import BirtaWriterCore

/// The app's windows, and everything that belongs to the APP rather than to
/// any one of them.
///
/// A `Coordinator` is a window: a panel, a WKWebView, a writer, a title and one
/// bound file. It was also, for as long as there was exactly one of them, the
/// place four process-wide registrations happened to live. That is invisible
/// while there is one instance and wrong the moment there are two, in a
/// different way each time:
///
/// * `GlobalHotkey` installs a handler on the process-wide Carbon event
///   dispatcher and registers a FIXED `EventHotKeyID`. A second instance
///   installs a second handler, so one press runs both, and its exclusive
///   registration can come back `eventHotKeyExistsErr`, which the app would
///   report as "another app may own it": misdiagnosing itself.
/// * The measurement signals are one `SIGUSR1` and one `SIGURG` per process,
///   and the message file they read is one fixed path. N handlers would run
///   every probe N times, against one file, which does not make the harness
///   noisy so much as unable to say which window it measured.
/// * `NSEvent.addLocalMonitorForEvents` is app-wide, so N monitors run on
///   every keystroke in the app. The double-Escape guard would still act only
///   for the key window, so this is a cost rather than a bug, until windows
///   start closing: nothing removes the monitor, so each closed window leaves
///   one behind for the life of the process.
/// * `previousApp` is a fact about the APP, not a window. It is captured only
///   when the frontmost application is not us, so a second window summoned
///   while the app is already frontmost captures nothing, and dismissing that
///   window would fall through to `NSApp.hide` and take the other windows with
///   it.
///
/// So they live here, once. What stays in `Coordinator` is everything that is
/// genuinely about one window, which is nearly all of it.
///
/// ## Summon shows and hides the whole set
///
/// Decided rather than inherited: the hotkey brings up every window and
/// dismisses every window, as one workspace. That is why the overlay manners
/// stay on all of them, and it is also what keeps this file simple, because
/// the alternative (summon the most recent) makes `NSApp.hide` and the
/// return-to-previous-app step a per-window arbitration with no good answer.
@MainActor
final class WindowSet {
    /// The windows, in the order they were made.
    private(set) var windows: [Coordinator] = []

    /// THE summon key: one Carbon registration for the process.
    let hotkey = GlobalHotkey()

    /// What was frontmost when the app was last summoned over it, so dismissal
    /// puts the user back rather than dropping them on the desktop.
    ///
    /// Captured through `Coordinator.onWillShow` rather than only in
    /// `summonAll`, because a window can come forward without the hotkey: Open
    /// With from the Finder is exactly that, and returning to the Finder
    /// afterwards is the behaviour worth keeping.
    private var previousApp: NSRunningApplication?

    private var escMonitor: Any?
    private var tabChordMonitor: Any?
    private var lastEscape: TimeInterval = 0
    private var debugSignals: [DispatchSourceSignal] = []

    /// Whether a Space change is still the last window-forward's to answer.
    /// `BirtaWriterCore.SummonActivation` is the rule and says why one is owed.
    private var summonActivation = SummonActivation()

    /// The Space observer's token, held rather than discarded because
    /// `NotificationCenter` retains a block observer for the life of the
    /// process and this is the only handle on it. Nothing gives it back: it is
    /// one registration for the app, alongside the hotkey and the Escape
    /// monitor, and it outlives every window the way they do.
    private var spaceObserver: NSObjectProtocol?

    /// The Settings window is the app's, not a window's, so it is dismissed
    /// when the whole set goes rather than when any one window does.
    var openPreferences: (() -> Void)?
    var hidePreferences: (() -> Void)?

    /// The window a command should act on.
    ///
    /// The key window when there is one, and the most recently fronted
    /// otherwise. The fallback is not a detail: an accessory app is regularly
    /// asked to do something while none of its windows holds the keyboard, from
    /// its menu-bar item, from a Dock click, or while it is not frontmost at
    /// all. `windows` is kept in that order, oldest first, so the answer is the
    /// last one.
    ///
    /// It used to be `windows.first`, which is the OLDEST window and was
    /// indistinguishable from correct while there was one. `measure.sh` found
    /// it immediately: it opened a second window and typed, and the keystrokes
    /// went to the first, because a shell-driven accessory app frequently
    /// cannot take activation and so nothing was key at all.
    var key: Coordinator? {
        windows.first(where: \.isKey) ?? windows.last
    }

    var isAnyVisible: Bool { windows.contains(where: \.isVisible) }

    /// A recents menu that knows which window is asking.
    ///
    /// Built here rather than by whoever raises it, because the facts it needs
    /// are the SET's and not any window's: which file the window in front is
    /// on and which folder it is rooted at, so neither row is offered back to
    /// somebody already there, and which files the other windows hold, so
    /// those become the group at the top. Three surfaces raise this menu (the
    /// File menu's submenu, the titlebar's clock button, and the missing-file
    /// card), and a menu built three times from three answers is three menus
    /// that agree today.
    ///
    /// Read through closures rather than captured, because a menu rebuilds
    /// itself every time it opens and the answer changes as windows come and
    /// go: a list captured here would be the windows as they stood when the
    /// menu bar was created. That is the same reason `RecentsMenu` reads its
    /// file list lazily, stated one level up.
    ///
    /// Most recently fronted first: `windows` is kept oldest-first, so the
    /// window somebody was last in is the one at the end, and it is the likeliest
    /// place they mean to go back to.
    func recentsMenu(leadsWithOpen: Bool = false) -> RecentsMenu {
        RecentsMenu(leadsWithOpen: leadsWithOpen,
                    current: { [weak self] in self?.key?.boundFile },
                    currentRoot: { [weak self] in self?.key?.explorerRoot },
                    openElsewhere: { [weak self] in
                        guard let self else { return [] }
                        let here = self.key
                        return self.windows.reversed()
                            .filter { $0 !== here }
                            .map(\.boundFile)
                    })
    }

    // MARK: making windows

    /// Adopt a window and give it the hooks that reach back to the app.
    ///
    /// The two hooks that need to say WHICH window take it weakly, and that is
    /// not defensive: the coordinator owns these closures, so capturing it
    /// strongly is a cycle, and nothing would ever deallocate. It cost nothing
    /// while a window lived as long as the app and costs a whole WKWebView per
    /// closed window now, which is the one resource this feature multiplies.
    @discardableResult
    func adopt(_ coordinator: Coordinator) -> Coordinator {
        coordinator.openPreferences = { [weak self] in self?.openPreferences?() }
        coordinator.onWillShow = { [weak self] in self?.windowWillShow() }
        coordinator.onCloseRequest = { [weak self, weak coordinator] in
            guard let coordinator else { return }
            self?.close(coordinator)
        }
        coordinator.onHotkeyChanged = { [weak self] in self?.registerHotkey() ?? -1 }
        coordinator.refusedSummonCombo = { [weak self] in self?.refusedSummonCombo }
        coordinator.onNewWindowRequest = { [weak self] in self?.newNote() }
        coordinator.onNewTabRequest = { [weak self, weak coordinator] in
            guard let coordinator else { return }
            self?.newTab(in: coordinator)
        }
        coordinator.onOpenProjectFile = { [weak self, weak coordinator] url, newTab in
            guard let coordinator else { return }
            self?.openFromExplorer(url, from: coordinator, inNewTab: newTab)
        }
        coordinator.onNewNoteInFolder = { [weak self, weak coordinator] folder in
            guard let coordinator else { return }
            self?.newNote(in: folder, beside: coordinator)
        }
        coordinator.onShowHiddenChanged = { [weak self] shown in self?.setShowHiddenFiles(shown) }
        coordinator.onFormattingRowChanged = { [weak self] expanded in self?.setFormattingRowExpanded(expanded) }
        coordinator.onOpenDirectoryRequest = { [weak self] url in self?.openDirectory(at: url) }
        coordinator.makeRecentsMenu = { [weak self] in self?.recentsMenu() ?? RecentsMenu() }
        coordinator.onOpenRequest = { [weak self] url in
            self?.openDocument(at: url)
            return self?.windows.count ?? 0
        }
        coordinator.onBindingChanged = { [weak self] in self?.recordOpenSetSoon() }
        coordinator.onFrameChanged = { [weak self] in self?.recordOpenSetSoon() }
        coordinator.onReloadEverywhereRequest = { [weak self] in self?.preferencesChangedEverywhere() }
        coordinator.onOpenSetRequest = { [weak self] in self?.describeOpenSet() ?? "" }
        coordinator.onPaletteRequest = { [weak self] query, mode in
            self?.paletteProbe?(query, mode) ?? "unavailable"
        }
        coordinator.onBecameKey = { [weak self, weak coordinator] in
            guard let coordinator else { return }
            self?.moveToFront(coordinator)
        }
        windows.append(coordinator)
        recordOpenSetSoon()
        return coordinator
    }

    // MARK: the open set

    /// Record the windows as they stand, so the next launch can put them back.
    ///
    /// Settled rather than written on the spot, because the gestures that
    /// change the set arrive in runs: a launch adopts every restored window
    /// in one pass, and a titlebar drag posts a move per frame for as long as
    /// the mouse is down. One write once the run has gone quiet is the same
    /// recording with none of the churn on the defaults store.
    ///
    /// NEVER the first preference this install writes. `Prefs.isFirstLaunch`
    /// is the absence of every key, and `Prefs.applyOnboardingDefaults` reads
    /// it on the way to the first-run screen; a set recorded before then would
    /// turn a first launch into an existing one and the onboarding defaults
    /// would silently stop applying. `Coordinator.boundURL`'s `didSet` names
    /// the same trap for the recents list and waits for the same reason. The
    /// first-run screen writes its own key the moment it is answered, and
    /// every recording after that goes through.
    private var openSetRecording: DispatchWorkItem?

    private func recordOpenSetSoon() {
        openSetRecording?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.openSetRecording = nil
            self.recordOpenSet()
        }
        openSetRecording = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    /// The recording itself, now. `prepareToTerminate` calls this directly,
    /// because a quit does not wait for a settle.
    private func recordOpenSet() {
        openSetRecording?.cancel()
        openSetRecording = nil
        guard !Prefs.isFirstLaunch else { return }
        Prefs.openSet = snapshotOpenSet()
    }

    /// The windows as `OpenSet` spells them: one group per tab bar, tabs in
    /// bar order, groups back to front.
    ///
    /// A group's place in the order is its most recently fronted tab's, so the
    /// groups are collected front to back (the first tab met for a group is
    /// its most recent) and the list is then turned round. Its frame is the
    /// showing tab's, and its `selected` is that tab's place in the bar.
    ///
    /// A window's frame is recorded only once it HAS one. A restored window
    /// that has not been shown yet is still at its construction placeholder,
    /// and carries the frame it was handed instead (`Coordinator.windowFrame`),
    /// so a launch followed by a quit with nothing summoned records the same
    /// arrangement it restored rather than a row of placeholders.
    private func snapshotOpenSet() -> OpenSet {
        var groups: [OpenSet.Group] = []
        var seen: Set<ObjectIdentifier> = []
        for front in windows.reversed() {
            let identity = front.tabGroupIdentity ?? ObjectIdentifier(front)
            guard seen.insert(identity).inserted else { continue }
            let members = tabs(of: front)
            let showing = members.first(where: \.isSelectedTab) ?? front
            groups.append(OpenSet.Group(
                root: front.explorerRoot?.standardizedFileURL.path,
                tabs: members.map { $0.boundFile.standardizedFileURL.path },
                selected: members.firstIndex { $0 === showing } ?? 0,
                frame: showing.windowFrame.map(NSStringFromRect)))
        }
        return OpenSet(groups: groups.reversed())
    }

    /// One line a checking run can read: how many groups, and which file is
    /// in front. `mac/scripts/measure.sh` compares it against what a relaunch
    /// restores.
    private func describeOpenSet() -> String {
        let set = snapshotOpenSet()
        let front = set.groups.last?.selectedTab.map { URL(fileURLWithPath: $0).lastPathComponent } ?? ""
        return "count=\(set.groups.count) front=\(front)"
    }

    /// Where the next spawned window goes, carried between spawns so a third
    /// window steps off the second rather than back onto the first.
    private var cascadePoint: NSPoint?

    /// The windows, at launch: the ones that were open when the app last
    /// quit, back where they were, with the one the person was last in at the
    /// front. `BirtaWriterCore.OpenSet.launchPlan` is the rule; this builds
    /// what it decides. Answers the window in front, which is the one a
    /// launch shows anything on.
    ///
    /// Decided here rather than inside a window because it is a rule about
    /// LAUNCHING: a window opened later by New Note or Open must not consult
    /// the blank-note setting, and none of them restores anything. It runs
    /// before any page loads, so each editor mounts against the file it will
    /// actually edit rather than mounting one and swapping it out.
    ///
    /// - Parameter launchedWith: the file this launch was asked to open, from
    ///   Open With, a Dock drop or `open -a`. It takes the document slot, as
    ///   Open does, so a rename from its window writes back to that setting.
    @discardableResult
    func openAtLaunch(launchedWith: URL?) -> Coordinator {
        // A folder the launch was asked to open is a directory window, made
        // after the set comes back so it lands in front of it; the plan below
        // is about files.
        let askedFolder = launchedWith.flatMap { DocumentTypes.isDirectory($0) ? $0.standardizedFileURL : nil }
        let asked = askedFolder == nil ? launchedWith?.standardizedFileURL : nil
        let scratchpad = Prefs.scratchpadURL!
        let currentNote = Prefs.currentNoteURL
        let plan = OpenSet.launchPlan(
            stored: Prefs.openSet,
            // A scratchpad that has never been written does not exist yet,
            // and a window on it is a legitimate state the coordinator opens
            // as an empty note (`NoteRead.absent`); pruning it would drop that
            // window with nothing to say so.
            exists: { path in
                FileManager.default.fileExists(atPath: path)
                    || FileIdentity.sameFile(URL(fileURLWithPath: path), scratchpad)
            },
            // Only the note New Note last made counts as the blank note to
            // front, and only while it is still empty. Any other empty file,
            // a document opened from the Finder included, is somebody's file
            // and not a place to start typing a new note into.
            isBlank: { path in
                guard let currentNote,
                      FileIdentity.sameFile(URL(fileURLWithPath: path), currentNote) else { return false }
                return Self.isBlankNote(atPath: path)
            },
            recents: Prefs.recentDocuments.map(\.standardizedFileURL.path),
            fallback: Prefs.activeURL.standardizedFileURL.path,
            openToBlankNote: Prefs.openToBlankNote,
            launchedWith: asked?.path,
            // The same file spelled two ways is one file, through a symlinked
            // folder or on a case-insensitive volume, and two windows over it
            // are the hazard `openDocument` refuses; the plan has to refuse it
            // the same way.
            sameFile: { FileIdentity.sameFile(URL(fileURLWithPath: $0), URL(fileURLWithPath: $1)) })
        if let asked { Prefs.documentURL = asked }
        for group in plan.groups {
            // A directory group comes back rooted where it was, if the folder
            // is still there; a folder that has gone leaves its tabs to come
            // back as loose files rather than as a window over nothing.
            let root = group.root.map { URL(fileURLWithPath: $0, isDirectory: true) }
                .flatMap { DocumentTypes.isDirectory($0) ? $0 : nil }
            // The first tab takes the group's frame; the rest join its bar in
            // recorded order, and the tab that was showing is selected last,
            // after every tab exists to be selected among.
            var made: [Coordinator] = []
            for path in group.tabs {
                let url = URL(fileURLWithPath: path)
                let frame = group.frame.map(NSRectFromString)
                // Each tab joins after the one made before it, because
                // `addTabbedWindow` inserts beside the window it is asked
                // of: joining every tab beside the FIRST would put them in
                // the bar in reverse.
                if let previous = made.last {
                    made.append(makeWindow(on: url, slot: slot(for: url), inGroupOf: previous, explorerRoot: root))
                } else {
                    made.append(makeWindow(on: url, slot: slot(for: url),
                                           frame: frame.flatMap { $0.isEmpty ? nil : $0 }, explorerRoot: root))
                }
            }
            if made.indices.contains(group.selected) {
                made[group.selected].selectTab()
                // The set is kept most-recently-fronted last, and the tab that
                // was showing is the one this group was last in.
                moveToFront(made[group.selected])
            }
        }
        // A launch asked to open a folder gets the folder in front and no
        // blank note beside it, the rule `OpenSet.launchPlan` applies to a
        // file it was asked for; the folder is not a tab, so the plan cannot
        // see it and the rule is applied here.
        let opensBlankNote = plan.opensBlankNote && askedFolder == nil
        if opensBlankNote, let note = Self.startBlankNote() {
            makeWindow(on: note, slot: .currentNote, frame: nil)
        }
        if let askedFolder { openDirectory(at: askedFolder, atLaunch: true) }
        // Nothing restored and no note could be made: the settings' own
        // answer, which is never empty. The scratchpad is a good fallback for
        // a blank note that failed, because the setting says where to START,
        // not that the old note may be lost.
        if windows.isEmpty {
            makeWindow(on: Prefs.activeURL, slot: Prefs.activeSlot, frame: nil)
        }
        Measure.trace("windows restored=\(windows.count) groups=\(plan.groups.count + (opensBlankNote ? 1 : 0))"
                      + " front=\(windows.last?.boundFile.lastPathComponent ?? "")")
        return windows.last!
    }

    /// WHICH app-wide setting names a file being put back, so a rename from
    /// its window writes to the right one. `Prefs.slot(holding:)` matches the
    /// stored strings, and the default scratchpad location is stored nowhere,
    /// so it is asked for separately: a window on it is bound through
    /// `.scratchpad`, exactly as the first window always was.
    private func slot(for url: URL) -> ActiveBinding.Slot? {
        if let named = Prefs.slot(holding: url) { return named }
        return FileIdentity.sameFile(url, Prefs.scratchpadURL) ? .scratchpad : nil
    }

    /// Whether a note has nothing in it, for the blank-note rule: a launch
    /// fronts an empty note that is already open rather than making another.
    /// Whitespace counts as nothing, as `Coordinator.isVacant` counts it.
    private static func isBlankNote(atPath path: String) -> Bool {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return false }
        return text.isBlank
    }

    /// Mount every window's page, hidden. A launch prewarms them all, which is
    /// what makes the first summon of each instant rather than a cold start.
    func startAll() {
        windows.forEach { $0.start() }
    }

    /// The launch half of New Note: a fresh file, chosen before anything has
    /// loaded, so there is no buffer to flush and nothing to write first.
    private static func startBlankNote() -> URL? {
        do {
            let note = try Coordinator.makeNoteFile()
            Prefs.currentNoteURL = note
            return note
        } catch {
            NSLog("Birta Writer: could not start a blank note: \(error)")
            return nil
        }
    }

    /// Cmd+N: a new note, in a new window.
    ///
    /// Nothing is flushed or written first, which is the difference from what
    /// this gesture used to do. It used to replace the buffer, so the note
    /// being left had to be put beyond doubt before it went; now it is not
    /// being left at all, and the window it is in keeps it.
    func newNote() {
        do {
            // In a directory window the note goes in the folder, as a tab of
            // that window, so it appears in the explorer beside the rest:
            // New Note in a folder window is a note in the folder.
            if let here = key, let root = here.explorerRoot {
                let target = try Coordinator.makeNoteFile(in: root)
                open(makeWindow(on: target, slot: nil, inGroupOf: here, explorerRoot: root))
                return
            }
            let target = try Coordinator.makeNoteFile()
            Prefs.currentNoteURL = target
            open(makeWindow(on: target, slot: .currentNote))
        } catch {
            NSLog("Birta Writer: could not make a new note: \(error)")
            key?.flashStatus("Could not make a new note.")
        }
    }

    /// Cmd+T, the tab bar's `+`, and the system's New Tab rows: a new note,
    /// as a tab beside the one in `spawn`'s window (MAR-393).
    ///
    /// A tab is a window, so this is `newNote` with the window placed into
    /// `spawn`'s tab group instead of cascaded off it. In a directory window
    /// the note is made in the root and the tab shares the root, so it shows
    /// up in the explorer beside the rest; the current-note slot stays with
    /// the notes folder, because a note in somebody's project is not the
    /// app's current note. Elsewhere the note takes the slot exactly as
    /// Cmd+N's does; the two gestures differ in where the window goes and in
    /// nothing else.
    func newTab(in spawn: Coordinator) {
        do {
            if let root = spawn.explorerRoot {
                let target = try Coordinator.makeNoteFile(in: root)
                open(makeWindow(on: target, slot: nil, inGroupOf: spawn, explorerRoot: root))
            } else {
                let target = try Coordinator.makeNoteFile()
                Prefs.currentNoteURL = target
                open(makeWindow(on: target, slot: .currentNote, inGroupOf: spawn))
            }
        } catch {
            NSLog("Birta Writer: could not make a new note: \(error)")
            spawn.flashStatus("Could not make a new note.")
        }
    }

    /// The explorer's New Note in a folder: a note made in `folder`, as a tab
    /// beside `spawn`. `newTab(in:)` with the folder chosen rather than the
    /// root, and the same reasoning about the slot.
    func newNote(in folder: URL, beside spawn: Coordinator) {
        do {
            let target = try Coordinator.makeNoteFile(in: folder)
            open(makeWindow(on: target, slot: nil, inGroupOf: spawn, explorerRoot: spawn.explorerRoot))
        } catch {
            NSLog("Birta Writer: could not make a new note: \(error)")
            spawn.flashStatus("Could not make a new note in \(folder.lastPathComponent).")
        }
    }

    // MARK: directory windows (MAR-457)

    /// A row of `here`'s explorer, or Go to File picked over a rooted window:
    /// the file lands where `OpenRouting.explorerDestination` says. A plain
    /// pick moves this tab to the file; a pick asking for a new tab, or a
    /// tab holding text that is not on disk, opens it beside; a file open as
    /// another tab of this window fronts that tab. Never another window.
    func openFromExplorer(_ url: URL, from here: Coordinator, inNewTab: Bool) {
        let target = url.standardizedFileURL
        guard let hereIndex = windows.firstIndex(where: { $0 === here }) else { return }
        let routed = OpenRouting.explorerDestination(
            for: target.path,
            windows: routingWindows(),
            here: hereIndex,
            inNewTab: inNewTab,
            hereHoldsUnsavedText: here.hasUnwrittenBytes && !Prefs.autosave,
            sameFile: Self.sameFile)
        let tabHere: (URL) -> Void = { [weak self, weak here] file in
            guard let self, let here else { return }
            self.open(self.makeWindow(on: file, slot: nil, inGroupOf: here, explorerRoot: here.explorerRoot))
        }
        switch routed {
        case let .existing(index):
            let open = windows[index]
            open.selectTab()
            open.show()
        case .tabHere:
            tabHere(target)
        case .replaceHere:
            here.replaceFile(with: target, orTab: tabHere)
        }
    }

    /// One watcher per open root, shared by every window rooted there, keyed
    /// by the root's standardized path. A change under a root reaches every
    /// tab of the group, because each tab's page has its own tree.
    private var roots: [String: DirectoryWatcher] = [:]

    /// The windows rooted at `root`, in the set's order.
    private func windows(rootedAt root: URL) -> [Coordinator] {
        windows.filter { $0.explorerRoot.map { FileIdentity.sameFile($0, root) } ?? false }
    }

    /// Watch `root` if nothing does yet, and hand its events to every window
    /// rooted there. The watcher outlives no window: `releaseUnwatchedRoots`
    /// drops it once the last one closes.
    private func watch(_ root: URL) {
        let key = root.standardizedFileURL.path
        guard roots[key] == nil else { return }
        let watcher = DirectoryWatcher(root: root)
        watcher.onChange = { [weak self] folders in
            self?.windows(rootedAt: root).forEach { $0.directoryChanged(folders) }
            // The Go to File index is a picture of the tree, and the tree
            // moved; the next palette open rebuilds it.
            self?.fileIndexes.removeValue(forKey: key)
        }
        watcher.start()
        roots[key] = watcher
    }

    private func releaseUnwatchedRoots() {
        for (key, watcher) in roots where windows(rootedAt: watcher.root).isEmpty {
            watcher.stop()
            roots.removeValue(forKey: key)
            fileIndexes.removeValue(forKey: key)
        }
    }

    // MARK: the palette's file index

    /// The Go to File index per folder, built off the main thread on first
    /// ask and kept until the folder's watcher reports a change (a root) or
    /// the next palette open (the notes folder, which has no watcher).
    private var fileIndexes: [String: FileIndex] = [:]
    private var indexing: Set<String> = []

    /// Where the app answers a `__birtaPalette` probe (`AppDelegate` sets it).
    var paletteProbe: ((_ query: String, _ mode: String) -> String)?

    /// The index of `folder`, or nil while it is being built, in which case
    /// `whenBuilt` runs on the main thread once it is.
    func fileIndex(for folder: URL, whenBuilt: @escaping () -> Void) -> FileIndex? {
        let key = folder.standardizedFileURL.path
        if let index = fileIndexes[key] { return index }
        guard indexing.insert(key).inserted else { return nil }
        DispatchQueue.global(qos: .userInitiated).async {
            let built = FileIndex.build(root: folder, accepts: DocumentTypes.accepts)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.indexing.remove(key)
                self.fileIndexes[key] = built
                whenBuilt()
            }
        }
        return nil
    }

    /// Forget the notes folder's index, so the next ask walks the folder
    /// again. Nothing watches that folder for the palette, so this is what
    /// keeps a note made a minute ago findable.
    func invalidateNotesIndex() {
        fileIndexes.removeValue(forKey: Prefs.notesDirectory.standardizedFileURL.path)
    }

    /// Open a folder as a directory window: the file the folder's own history
    /// suggests, with the explorer over the folder. A folder already open
    /// somewhere fronts that window rather than opening a second one over the
    /// same tree.
    ///
    /// Which file the window opens on is `DirectoryListing.firstToOpen`'s
    /// rule; a folder with nothing openable gets a new note made in it,
    /// because a window is always one buffer and an empty folder somebody
    /// opened in a notes app is a folder they are about to write in.
    ///
    /// - Parameter atLaunch: build the window without mounting or showing it,
    ///   because launch mounts every window at once afterwards.
    @discardableResult
    func openDirectory(at folder: URL, atLaunch: Bool = false) -> Coordinator? {
        let root = folder.standardizedFileURL
        if let open = windows(rootedAt: root).last {
            // The folder joins the recents list on this path too: fronting a
            // folder's window is a visit, and a row that did not move up
            // would sink under files opened since.
            Prefs.rememberRecent(root)
            if !atLaunch { open.show() }
            return open
        }
        // A file in the folder that is open as a loose window already is not
        // a candidate: a window is one buffer, and a second one over the same
        // path is the hazard `openDocument` guards against for every other
        // route in. The folder's window opens on the next candidate, or on a
        // new note when the open file was the only one.
        let openElsewhere: (URL) -> Bool = { [windows] candidate in
            windows.contains { FileIdentity.sameFile($0.boundFile, candidate) }
        }
        let file: URL
        if let found = DirectoryListing.firstToOpen(in: root, recents: Prefs.recentDocuments,
                                                    accepts: { DocumentTypes.accepts($0) && !openElsewhere($0) }) {
            file = found
        } else {
            do {
                file = try Coordinator.makeNoteFile(in: root)
            } catch {
                NSLog("Birta Writer: could not make a note in \(root.path): \(error)")
                key?.flashStatus("Could not open \(root.lastPathComponent).")
                return nil
            }
        }
        // The folder joins the recents list, as the file a window is bound to
        // does (`Coordinator.boundURL`, `close`). Here rather than at the
        // gestures that open one, because there are several of them (the
        // Finder, Open…, a row of this very menu, the palette) and this is
        // the one place they all arrive at; a directory window's root never
        // rebinds, so opening is the only moment it has.
        //
        // After the failures above and not before them, so a folder the app
        // could not open does not leave a row that will fail the same way
        // next time.
        Prefs.rememberRecent(root)
        let made = makeWindow(on: file, slot: slot(for: file), explorerRoot: root)
        if !atLaunch { open(made) }
        return made
    }

    /// The hidden-files setting, flipped from a menu row or a page, applied
    /// to the store and to every rooted window's page and menu mirror.
    func setShowHiddenFiles(_ shown: Bool) {
        Prefs.explorerShowsHidden = shown
        windows.forEach { $0.applyShowHiddenFiles(shown) }
    }

    /// The formatting row was opened or shut in one window: the app's one
    /// answer moves, and every window's page follows it, the one that asked
    /// included (its row is already there, and the page treats a push that
    /// changes nothing as nothing).
    func setFormattingRowExpanded(_ expanded: Bool) {
        Prefs.formattingRowExpanded = expanded
        windows.forEach { $0.applyFormattingRowExpanded(expanded) }
    }

    /// View > Line Numbers: the app's one setting, and every window's page.
    func setLineNumbers(_ enabled: Bool) {
        Prefs.lineNumbers = enabled
        windows.forEach { $0.applyLineNumbers(enabled) }
    }

    // MARK: appearance

    /// The themes the app has been given, and what the page looks like
    /// right now (`Appearance.swift`).
    ///
    /// One store and one answer for the process, because a theme is what the
    /// app looks like rather than what a window shows: View > Theme, the
    /// Appearance pane and the palette all read `Prefs.appearance` and all
    /// move every window. Resolved against the store and the system's
    /// appearance rather than trusted, so a slot naming a theme whose file
    /// has gone reads as the system's, and the slot in force is the one for
    /// the mode macOS is in.
    let themeStore = ThemeStore.installed
    private(set) lazy var appearance: ResolvedAppearance = resolveAppearance()
    private var appearanceObservation: NSKeyValueObservation?

    /// Whether macOS is dark right now: the application's own effective
    /// appearance, which follows the system while nothing forces the
    /// app's. A window's cannot answer this, because a window wearing a
    /// dark theme is held dark whatever the system does.
    static var systemIsDark: Bool {
        NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }

    private func resolveAppearance() -> ResolvedAppearance {
        let store = themeStore
        return Appearance.resolve(Prefs.appearance, systemIsDark: Self.systemIsDark) { store.theme(id: $0) }
    }

    /// Store `settings` and put the answer on every window.
    func setAppearance(_ settings: AppearanceSettings) {
        Prefs.appearance = settings
        appearanceChanged()
    }

    /// Something under the answer moved (the system flipped, the store
    /// changed, the settings were reset): resolve again and re-apply.
    func appearanceChanged() {
        appearance = resolveAppearance()
        let mode = Prefs.appearance.mode
        windows.forEach { $0.applyAppearance(appearance, mode: mode) }
    }

    /// A theme picked from the menu bar or the palette goes into the slot
    /// of the mode in force, which is the one the reader is looking at.
    func chooseTheme(id: String?) {
        setAppearance(Prefs.appearance.setting(id, for: appearance.kind))
    }

    func setAppearanceMode(_ mode: AppearanceMode) {
        setAppearance(Prefs.appearance.inMode(mode))
    }

    /// The store's contents changed under the settings (a theme added over
    /// the one in force, or removed).
    func themesChanged() { appearanceChanged() }

    /// Follow the system: a slot for each of light and dark means the
    /// answer changes at dusk with nothing touched, and a window held to a
    /// theme's kind never hears the system flip, so the application is
    /// what is watched.
    func observeSystemAppearance() {
        // Applied in the same turn rather than hopped through a task: the
        // window's own appearance callback runs synchronously with the flip
        // and would draw one frame with the old mod (a dark-tinted paper on a
        // page now light) before a hop caught up.
        appearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.appearanceChanged() }
        }
    }

    /// An editor command in every window: the Appearance pane's typography
    /// rows are the toolbar's own commands, which apply live in the page and
    /// post the setting back, so the pane runs them everywhere rather than
    /// reloading every page.
    ///
    /// In place, never summoned. The caller is the Settings window, and a
    /// summon puts the panel in front of the window whose button was just
    /// pressed, which leaves the reader looking at the change with the
    /// control that made it behind it. A window that is cold takes the
    /// setting from `Prefs` when it next mounts, which is what makes
    /// dropping the command there complete rather than lossy.
    func runEditorCommandEverywhere(_ id: String) {
        windows.forEach { $0.runEditorCommandInPlace(id) }
    }

    /// View > Theme, filled from this store and this answer.
    func themesMenu() -> ThemesMenu {
        ThemesMenu(source: { [weak self] in self?.themeStore.list() ?? [] },
                   current: { [weak self] in self?.appearance.themeId },
                   mode: { Prefs.appearance.mode })
    }

    /// Open a file: the Finder's Open With, a drop on the Dock icon, `open -a`,
    /// Cmd+O, or a row of Open Recent. In a new window, unless the window in
    /// front is standing on a file that has gone.
    ///
    /// A file already open brings ITS window forward instead of opening a
    /// second one. That is a data-loss guard rather than tidiness: two windows
    /// over one path hold two uncoordinated `CoalescingWriter`s, each writing
    /// the whole file, so the later write wins silently, and this app has no
    /// external-change detection anywhere that would notice.
    ///
    /// `FileIdentity.sameFile` rather than comparing paths, because the
    /// question is whether it is the same FILE: two paths through a symlinked
    /// folder, `/tmp` against `/private/tmp`, and a case-insensitive volume are
    /// all the same file spelled differently, and each is a way to end up with
    /// two windows over one note.
    ///
    /// ## Why the window in front, and only that one
    ///
    /// A window whose file has been deleted is showing `MissingFileScreen` and
    /// is editing nothing. Opening a file from it and getting a SECOND window,
    /// with the dead one still sitting behind, is the pile-up this avoids.
    ///
    /// The frontmost window is the only one asked, which is what keeps the rule
    /// to one sentence when several windows are vacant at once. Searching for
    /// any vacant window would open the file somewhere the reader is not
    /// looking, and with more than one candidate there is no answer to "why
    /// that one" that a reader could have predicted. Every gesture that reaches
    /// here points at the window in front: Cmd+O and the titlebar's Open button
    /// act on it, Open Recent is raised from it, and a file arriving from the
    /// Finder lands in the app rather than in any particular window, so the one
    /// in front is the one about to come forward anyway.
    ///
    /// `isVacant` is the whole of the test, and its second half is why a window
    /// with unsaved text is left alone; the coordinator states the reason.
    func openDocument(at url: URL) {
        let target = url.standardizedFileURL
        if DocumentTypes.isDirectory(target) {
            openDirectory(at: target)
            return
        }
        guard DocumentTypes.accepts(target) else {
            summonAll()
            key?.flashStatus("Birta Writer does not open \(target.lastPathComponent).")
            return
        }
        // WHERE the file lands is `OpenRouting`'s, decided over the windows
        // as they stand; each arm below is the app carrying out one answer.
        let routed = OpenRouting.destination(
            for: target.path,
            windows: routingWindows(),
            looseFilesOpenInTab: Prefs.openFilesIn == .tab,
            sameFile: Self.sameFile,
            isInside: { DirectoryListing.isInside(URL(fileURLWithPath: $0), root: URL(fileURLWithPath: $1, isDirectory: true)) })
        switch routed {
        case let .existing(index):
            let open = windows[index]
            open.selectTab()
            open.show()
        case let .tabIn(index):
            // A file under an open folder joins that folder's window as a
            // tab with the same root, so its row is selected in the explorer
            // by the tab's own load; it takes no app-wide slot, because a
            // file in somebody's project is not the app's document.
            let host = windows[index]
            open(makeWindow(on: target, slot: nil, inGroupOf: host, explorerRoot: host.explorerRoot))
        case .vacantFront:
            Prefs.documentURL = target
            guard let here = key else { return }
            // The same release every spawn does, and needed for the same
            // reason: only one window may hold a slot, or two would both write
            // a rename back to one setting.
            releaseSlot(.document, except: here)
            here.openInPlace(target, slot: .document)
        case let .tabBeside(index):
            // A loose file as a tab of the window in front, on the "Open
            // files in" setting. The tab is a loose window like any other
            // (no root, so no explorer of its own), and it takes the
            // document slot exactly as a window of its own would.
            Prefs.documentURL = target
            open(makeWindow(on: target, slot: .document, inGroupOf: windows[index]))
        case .newWindow:
            Prefs.documentURL = target
            // The setting asked for a window, so the system's Prefer tabs
            // preference is not given the chance to make it a tab; with no
            // window open the answer is a window either way.
            open(makeWindow(on: target, slot: .document), asSeparateWindow: Prefs.openFilesIn == .window)
        }
    }

    /// The open windows as `OpenRouting` reads them, in the set's order.
    private func routingWindows() -> [OpenRouting.Window] {
        windows.map {
            OpenRouting.Window(file: $0.boundFile.path,
                               root: $0.explorerRoot?.standardizedFileURL.path,
                               isVacant: $0.isVacant,
                               group: $0.tabGroupIdentity.map { "\($0)" })
        }
    }

    private static func sameFile(_ a: String, _ b: String) -> Bool {
        FileIdentity.sameFile(URL(fileURLWithPath: a), URL(fileURLWithPath: b))
    }

    /// Cmd+O. Ask for a file, then open it the way the Finder's Open With does.
    ///
    /// Everything about opening is `openDocument(at:)`'s, so this is only the
    /// chooser. That is the point of the split: a file arriving from a panel
    /// and a file arriving from the Finder must reach a window by one path, or
    /// the two acquire different answers about what happens to what is open.
    ///
    /// App-modal rather than a sheet on the window it was raised from, which is
    /// what it used to be. The file chosen here does not belong to that window;
    /// it gets one of its own. A sheet would say the opposite, and it would
    /// also be a sheet on a window an accessory app may not have on screen.
    ///
    /// The chooser starts in the folder of the file in front, which is where a
    /// second note usually is. `Prefs.saveAsDirectory` is deliberately not
    /// reused: that is where copies are written OUT to, and starting there
    /// points at a folder of exports rather than at the notes.
    func openDocumentPanel() {
        NSApp.activate(ignoringOtherApps: true)
        let chooser = NSOpenPanel()
        chooser.title = "Open"
        chooser.allowedContentTypes = DocumentTypes.openedContentTypes + [.folder]
        chooser.allowsMultipleSelection = false
        // A folder opens as a directory window (MAR-457). One chooser for
        // both rather than an Open Folder row beside Open, because the Finder
        // hands both over through one gesture too.
        chooser.canChooseDirectories = true
        chooser.canChooseFiles = true
        chooser.directoryURL = (key?.boundFile ?? Prefs.activeURL).deletingLastPathComponent()
        guard chooser.runModal() == .OK, let url = chooser.url else { return }
        openDocument(at: url)
    }

    /// The close button and Cmd+W.
    ///
    /// The LAST window hides rather than closing, and that is load-bearing
    /// rather than a nicety. Hiding keeps the page mounted, which is what makes
    /// the next summon instant; tearing the WKWebView down would turn every
    /// summon after a Cmd+W into a cold start, which is the promise this whole
    /// app is built around. Somebody running one window therefore sees exactly
    /// the behaviour they always did.
    ///
    /// Any other window really closes, through the same question a quit asks of
    /// it: with autosave off and unwritten bytes it asks, and Cancel leaves the
    /// window where it is.
    func close(_ coordinator: Coordinator) {
        guard TabGroupPolicy.whatCloseDoes(windows: windows.count) == .closeTab else {
            dismissAll()
            return
        }
        coordinator.prepareToClose { [weak self] proceed in
            guard proceed, let self else { return }
            // The file this window was on joins the recents list, and closing
            // is the second of the only two ways a file stops being on screen.
            // `Coordinator.boundURL`'s `didSet` records the other, a rebind,
            // and it is the one slot every rebind passes through; a window that
            // opens a file and closes never rebinds, so without this the file
            // it was showing is one Open Recent has never heard of. With one
            // window that could not happen, because the only way to stop
            // looking at a file was to go to another one.
            Prefs.rememberRecent(coordinator.boundFile)
            // The document slot goes with the window that held it. The slot
            // is the setting a rename writes back to, and with the window
            // gone there is nothing to write back for. It must not outlive
            // the window: a document setting left standing is a file the app
            // would open in preference to every note, on a launch with
            // nothing recorded and on Back to My Notes.
            if coordinator.bindingSlot == .document { Prefs.documentURL = nil }
            self.windows.removeAll { $0 === coordinator }
            coordinator.tearDown()
            // The tab that went may have been the second-to-last of its bar,
            // which then disappears and hands its row back to the page.
            self.windows.forEach { $0.tabsChanged() }
            self.releaseUnwatchedRoots()
            self.recordOpenSetSoon()
        }
    }

    /// Shift+Cmd+W: every tab in `coordinator`'s window, through the same
    /// question a quit asks of each, serially, one Cancel refusing the rest.
    /// A window holding every window the app has hides instead, which is the
    /// last-window rule (`TabGroupPolicy.whatCloseWindowDoes`).
    func closeWindow(_ coordinator: Coordinator) {
        let members = tabs(of: coordinator)
        guard TabGroupPolicy.whatCloseWindowDoes(tabsInWindow: members.count, windows: windows.count) == .closeWindow else {
            dismissAll()
            return
        }
        var remaining = members
        func next() {
            guard !remaining.isEmpty else { return }
            let tab = remaining.removeFirst()
            tab.prepareToClose { [weak self] proceed in
                guard proceed, let self else { return }
                Prefs.rememberRecent(tab.boundFile)
                if tab.bindingSlot == .document { Prefs.documentURL = nil }
                self.windows.removeAll { $0 === tab }
                tab.tearDown()
                self.windows.forEach { $0.tabsChanged() }
                self.releaseUnwatchedRoots()
                self.recordOpenSetSoon()
                next()
            }
        }
        next()
    }

    /// The windows sharing `coordinator`'s tab bar, in bar order,
    /// `coordinator` included; just `coordinator` when it is in no group.
    private func tabs(of coordinator: Coordinator) -> [Coordinator] {
        guard let group = coordinator.tabGroupIdentity else { return [coordinator] }
        return windows
            .filter { $0.tabGroupIdentity == group }
            .sorted { ($0.tabIndex ?? 0) < ($1.tabIndex ?? 0) }
    }

    /// Mount a freshly made window's page and put it on screen.
    ///
    /// Separate from `makeWindow` because the FIRST window does neither at the
    /// same moment: launch builds it, then builds the menus and the status
    /// item, then starts it, and shows it only if this launch was asked to
    /// open something. Every window made later is wanted now.
    /// - Parameter asSeparateWindow: keep the system from folding this
    ///   window into a tab as it is shown, for the one gesture whose setting
    ///   said a window (`OpenRouting.Destination.newWindow`).
    private func open(_ coordinator: Coordinator, asSeparateWindow: Bool = false) {
        coordinator.start()
        if asSeparateWindow {
            coordinator.withAutomaticTabbingSuspended { coordinator.show() }
        } else {
            coordinator.show()
        }
    }

    /// Leave the document this window was pointed at and go back to the notes.
    ///
    /// The app's rather than the window's, for the same reason `openDocument`
    /// is: the file it lands on can already be open somewhere else. Clearing
    /// the document slot resolves the binding to the current note or the
    /// scratchpad, and either may be what another window is editing, so a
    /// window doing this alone would make the second buffer over one path that
    /// the rest of this file exists to prevent.
    func backToNotes(_ coordinator: Coordinator) {
        guard coordinator.bindingSlot == .document, Prefs.documentURL != nil else {
            coordinator.flashStatus("Birta Writer is already on your notes.")
            return
        }
        // Where the binding WILL land once the document slot is cleared, asked
        // before clearing it so the answer can be refused.
        let target = ActiveBinding.url(document: nil,
                                       currentNote: Prefs.currentNoteURL,
                                       scratchpad: Prefs.scratchpadURL)
        if let open = windows.first(where: {
            $0 !== coordinator && FileIdentity.sameFile($0.boundFile, target)
        }) {
            open.show()
            coordinator.flashStatus("Your notes are already open in another window.")
            return
        }
        coordinator.leaveDocument { [weak self, weak coordinator] slot in
            guard let coordinator else { return }
            self?.releaseSlot(slot, except: coordinator)
        }
    }

    /// Take a slot away from every window but one.
    ///
    /// A slot is an app-wide setting and only one window may hold it, or two
    /// windows would both believe a rename of their file should be written
    /// there and the second would overwrite what the first had written.
    private func releaseSlot(_ slot: ActiveBinding.Slot?, except owner: Coordinator) {
        guard let slot else { return }
        for window in windows where window !== owner && window.bindingSlot == slot {
            window.bindingSlot = nil
        }
    }

    /// Build a window, hand it its hooks, and place it: where a launch says it
    /// was, or off the one in front.
    ///
    /// - Parameter frame: the recorded frame a launch is putting back, or nil
    ///   for a window made now, which cascades off the window in front.
    /// - Parameter inGroupOf: the window whose tab group the new window joins,
    ///   as its selected tab, instead of taking a frame of its own.
    /// - Parameter explorerRoot: the folder the new window is rooted at, for a
    ///   directory window; the root is watched from here.
    @discardableResult
    private func makeWindow(on url: URL, slot: ActiveBinding.Slot?, frame: NSRect? = nil,
                            inGroupOf group: Coordinator? = nil, explorerRoot: URL? = nil) -> Coordinator {
        // Only one window may hold a slot, so taking it releases whoever had
        // it. Otherwise two windows would both believe a rename of their file
        // should be written to the same setting, and the second would overwrite
        // what the first had written there.
        let spawn = key
        // The FIRST window also keeps the historic autosave name, which is
        // what a panel somebody positioned before the open set was recorded
        // restores from; the set's own frame outranks it once there is one
        // (`AppPanel.restoredFrame`).
        let made = Coordinator(boundTo: url, slot: slot, remembersFrame: windows.isEmpty, frame: frame,
                               explorerRoot: explorerRoot, appearance: appearance, appearanceMode: Prefs.appearance.mode)
        // A tab beside a window on the same root starts with that window's
        // tree open the same way, rather than with only the path to its file.
        if let group, let explorerRoot, let groupRoot = group.explorerRoot,
           FileIdentity.sameFile(groupRoot, explorerRoot) {
            made.explorerExpanded = group.explorerExpanded
        }
        adopt(made)
        releaseSlot(slot, except: made)
        if let explorerRoot { watch(explorerRoot) }
        // Off a window that HAS a place. At launch the window in front is a
        // restored one that has not been shown yet, still at its construction
        // placeholder, and a cascade off that would put the new window one
        // step off the bottom-left corner of the screen and mark it placed;
        // left unplaced instead, it is centred on first show like any window
        // nobody has positioned.
        if let group {
            group.attachTab(made)
            // The bar has appeared or grown, and no layout pass of either
            // window's content notices.
            group.tabsChanged()
            made.tabsChanged()
        } else if frame == nil, let spawn, spawn.isPlaced {
            cascadePoint = made.cascade(after: spawn, from: cascadePoint)
        }
        return made
    }

    /// Every setting is back at its default, and the window in front should be
    /// on the default note, which is what the Reset sheet promises.
    ///
    /// The ordinary settings reload cannot do that on its own any more: a
    /// window bound through no slot stays on its file whatever the settings
    /// say (`Coordinator.rebindFromSettings`, MAR-456), and the window in
    /// front is regularly slotless, because opening a second document releases
    /// the first window's slot. So the reset hands the front window the
    /// scratchpad slot before it reloads, and the reload lands it on the
    /// default note. Unless another window is already there, in which case
    /// that window comes forward instead: two windows over one note is the
    /// thing every other path here refuses.
    func settingsWereReset() {
        // Before the reload, so the page served next carries no theme, and
        // for every window rather than the front one, since the theme was
        // on all of them.
        appearanceChanged()
        guard let front = key else { return }
        if front.bindingSlot == nil {
            let scratchpad = Prefs.scratchpadURL!
            if let open = windows.first(where: { $0 !== front && FileIdentity.sameFile($0.boundFile, scratchpad) }) {
                open.show()
            } else {
                releaseSlot(.scratchpad, except: front)
                front.bindingSlot = .scratchpad
            }
        }
        front.preferencesChanged()
    }

    /// Keep `windows` in most-recently-fronted order, which is what `key`
    /// falls back to when nothing holds the keyboard, and what the open set
    /// records as which window was in front.
    private func moveToFront(_ coordinator: Coordinator) {
        guard windows.last !== coordinator else { return }
        windows.removeAll { $0 === coordinator }
        windows.append(coordinator)
        recordOpenSetSoon()
    }

    // MARK: quitting

    /// Every window's answer, joined into the one reply AppKit accepts.
    ///
    /// Serial rather than concurrent, because each window may put a sheet up
    /// and macOS asks about one document at a time; N sheets at once, on
    /// windows several of which are hidden and would summon themselves to ask,
    /// is not a quit anybody could answer.
    ///
    /// One Cancel refuses the whole quit, and the windows that already answered
    /// have to forget their answers: they are marked decided, which suppresses
    /// their last-chance write, and the quit they decided for is not happening.
    ///
    /// The summon key is given up only once every window has agreed, for the
    /// same reason it is not given up inside a window: releasing it early would
    /// leave the app running with no way to summon it as soon as the third
    /// window said Cancel.
    func prepareToTerminate(_ done: @escaping (Bool) -> Void) {
        var remaining = windows
        func ask() {
            guard !remaining.isEmpty else {
                // Now rather than on the next turn: this is the recording the
                // next launch restores, and there is no next turn.
                recordOpenSet()
                releaseHotkey()
                done(true)
                return
            }
            let next = remaining.removeFirst()
            next.prepareToClose { [weak self] proceed in
                guard let self else { done(proceed); return }
                guard proceed else {
                    self.windows.forEach { $0.forgetQuitDecision() }
                    done(false)
                    return
                }
                ask()
            }
        }
        ask()
    }

    /// The last-chance write, for every window rather than the front one.
    func finalWrite() {
        windows.forEach { $0.finalWrite() }
    }

    /// Take a settings change to EVERY window rather than to the front one.
    ///
    /// The Settings window's ordinary `onChange` reaches `front` alone, which
    /// is right for a setting whose only surface is the window it changes. The
    /// publishing targets are not one of those: the Format menu belongs to the
    /// application and repaints from `Prefs` on every opening, so a change that
    /// reached one window would leave a back window's toolbar and slash menu
    /// offering tools the menu bar above them had already withdrawn. That
    /// disagreement between a row and its chord is the thing the whole gate
    /// exists to stop (`BirtaWriterCore/SyntaxSets.swift`).
    ///
    /// Each window flushes before it reloads, which is `preferencesChanged`'s
    /// own contract, so a background window with unwritten bytes keeps them.
    func preferencesChangedEverywhere() {
        windows.forEach { $0.preferencesChanged() }
    }

    /// Nobody is there to answer a sheet, so every window writes instead of
    /// asking. On all of them: a sheet on the second window would wait just as
    /// forever as one on the first.
    func quitUnattended() {
        windows.forEach { $0.quitIsUnattended = true }
    }

    /// Every window re-reads the Spaces membership the Dock setting implies.
    /// `BirtaWriterCore.WindowPolicy` is the rule and
    /// `AppDelegate.applyActivationPolicy` is the one caller.
    func applyWindowPolicy() {
        windows.forEach { $0.applyWindowPolicy() }
    }

    // MARK: summon and dismiss

    func toggle() {
        if isAnyVisible && NSApp.isActive { dismissAll() } else { summonAll() }
    }

    func summonAll() {
        windows.forEach { $0.show() }
    }

    /// Dismiss first, flush after, which is `Coordinator.hide`'s rule and the
    /// reason it is not a teardown.
    func dismissAll() {
        // Dismissal is the whole reason the arm can be given back, and it is
        // not a tidy-up. `returnToPreviousApp` below activates an application
        // that may well be on another Space, which changes the Space and posts
        // the very notification the arm answers: a dismissal that left the arm
        // standing would pull the app forward again out of its own goodbye.
        //
        // Before the guard rather than after it, because the path that returns
        // early leaves the arm to the reader's own next Space change.
        summonActivation.disarm()
        guard isAnyVisible else { return }
        // Settings belongs to the app, not to a window. Left behind it is a
        // window with no editor to change the settings OF, floating over
        // whatever the user went back to.
        hidePreferences?()
        windows.forEach { $0.hide() }
        returnToPreviousApp()
    }

    /// A window is about to come forward, whatever brought it: the hotkey, New
    /// Note, the menu-bar item, a row of Open Recent, or Open With from the
    /// Finder. Two things follow from that, and neither of them belongs to the
    /// window that is showing.
    private func windowWillShow() {
        capturePreviousApp()
        // Every one of those routes activates the app, and every one of them
        // can be taken from inside another application's full screen, which is
        // the place the activation needs defending. Armed here for the same
        // reason `previousApp` is captured here rather than in `summonAll`:
        // the hotkey is not the only way a window comes forward.
        //
        // Armed on a show that will not switch Space either, which is most of
        // them. That arm answers nothing and expires; `NSWindow.isOnActiveSpace`
        // looks like the way to narrow it and is not, because a window that has
        // been ordered out is on no Space at all and would report the same
        // thing in both cases.
        summonActivation.summoned(at: ProcessInfo.processInfo.systemUptime)
    }

    private func capturePreviousApp() {
        if let front = NSWorkspace.shared.frontmostApplication, front != .current {
            previousApp = front
        }
    }

    private func returnToPreviousApp() {
        if let prev = previousApp, prev.isTerminated == false {
            prev.activate()
        } else {
            NSApp.hide(nil)
        }
        previousApp = nil
    }

    /// The activation again, and nothing else about bringing a window forward.
    ///
    /// Deliberately not a `show`, and the difference is `previousApp`: showing
    /// a window captures whatever application is frontmost, and here that is
    /// the one the Space switch has just put in front, so a re-assertion routed
    /// through `show` would leave dismissal returning the reader to it instead
    /// of to the application they were in when they asked for this window.
    ///
    /// One window is raised rather than all of them, and it is `key`, the same
    /// answer every other command in this file acts on. Activating an
    /// application puts all of its windows back above the other application's,
    /// keeping the order they already had among themselves, so the only thing
    /// left to say is which of ours holds the keyboard. `onBecameKey` keeps
    /// `windows` in most-recently-fronted order, so that is the one that was
    /// coming forward whether a summon showed every window or New Note showed
    /// one.
    ///
    /// Called a runloop turn after the Space change, and never on a timer of
    /// its own: this runs at most once per arm, and the arm is spent by the
    /// change that reached it.
    private func reassertSummon() {
        guard isAnyVisible else { return }
        key?.raise()
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: process-wide registrations

    func start() {
        // The log is for whoever is reading a console, and it is NOT the whole
        // of the handling: `register` keeps the chord it was refused, and the
        // first-run screen and the Settings pane both report it through
        // `RowAvailability.summon` when they open. This log alone was the whole
        // of it, which is what made a dead summon indistinguishable from a
        // broken app (MAR-407).
        let status = registerHotkey()
        if status != noErr {
            NSLog("Birta Writer: hotkey \(Prefs.hotkey.spelling) registration failed (\(status)); another app may own it")
        }
        installEscapeMonitor()
        installTabChordMonitor()
        observeSystemAppearance()
        observeSpaceChanges()
        if Measure.isEnabled { installDebugSignals() }
    }

    /// Cmd+1 through Cmd+9 and Shift+Cmd+] / Shift+Cmd+[ select tabs, the
    /// chords Safari and Terminal give them beside AppKit's own Ctrl+Tab pair.
    ///
    /// A monitor rather than menu rows, because eleven rows for tab selection
    /// is not what a macOS Window menu looks like; AppKit's own tab rows are
    /// inserted into `NSApp.windowsMenu` by the system, and these sit beside
    /// them. ONE monitor for the app, like the Escape one. It takes a key
    /// only from a key window with two or more tabs, so with one tab every
    /// chord reaches the page exactly as before; `TabGroupPolicy.tabSelection`
    /// is the rule and says which chords are left alone (Cmd+Option+digit is a
    /// heading, Cmd+] is indent).
    private func installTabChordMonitor() {
        tabChordMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, let front = self.key, front.isKey, front.tabCount > 1 else { return event }
            let flags = event.modifierFlags
            let chord = TabGroupPolicy.Chord(characters: event.charactersIgnoringModifiers ?? "",
                                             command: flags.contains(.command),
                                             shift: flags.contains(.shift),
                                             option: flags.contains(.option),
                                             control: flags.contains(.control))
            guard let index = TabGroupPolicy.tabSelection(for: chord, count: front.tabCount,
                                                          selected: front.tabIndex ?? 0) else { return event }
            front.selectTab(at: index)
            return nil
        }
    }

    /// Answer the Space switch that bringing a window forward causes, once it
    /// has landed. Installed once, from `start`, like the other process-wide
    /// registrations around it.
    ///
    /// On `NSWorkspace`'s own centre, which is where a workspace notification
    /// is posted; the default centre never sees this one.
    ///
    /// `BirtaWriterCore.SummonActivation` decides whether the change is this
    /// app's, so nothing here is a rule: this is the observer and the
    /// re-assertion, and the reason a re-assertion is owed at all lives with
    /// the type.
    private func observeSpaceChanges() {
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self,
                      self.summonActivation.spaceChanged(
                        at: ProcessInfo.processInfo.systemUptime) else { return }
                // A runloop turn later, for the reason
                // `AppDelegate.applyActivationPolicy` gives about the other
                // window-server transition this app makes: the notification is
                // the head of the change rather than the end of it, and an
                // activation issued in the same turn is undone by the tail of
                // the transition it was meant to survive.
                DispatchQueue.main.async { [weak self] in
                    self?.reassertSummon()
                }
            }
        }
    }

    /// Register or re-register the summon key. The Settings recorder and the
    /// first-run screen both reach this, and both need the status back: an
    /// exclusive registration is the only way a chord another app already owns
    /// is ever reported at all.
    /// The chord macOS refused, or nil while it holds one.
    ///
    /// The surfaces that report it read it from here rather than being handed
    /// the status at launch, because the launch attempt happens before either
    /// of them exists. One registration, one answer, asked for when there is
    /// somewhere to draw it.
    var refusedSummonCombo: HotkeyCombo? { hotkey.refusedCombo }

    @discardableResult
    func registerHotkey() -> OSStatus {
        hotkey.onPress = { [weak self] in
            self?.key?.markHotkeyPressed()
            self?.toggle()
        }
        return hotkey.register(Prefs.hotkey)
    }

    /// Given up only once a quit is certain. Unregistering before the last
    /// window has answered would leave the app running with no summon key for
    /// the rest of the session if any of them said Cancel.
    func releaseHotkey() {
        hotkey.unregister()
    }

    /// Double-Escape dismisses: the first bare Escape belongs to the editor
    /// (block selection, closing a menu); a second within the window dismisses.
    ///
    /// ONE monitor for the app, dispatching to whichever window is key, rather
    /// than one per window each filtering the same keystroke.
    private func installEscapeMonitor() {
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.key?.isKey == true, event.keyCode == 53,
                  event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty else { return event }
            let now = ProcessInfo.processInfo.systemUptime
            if now - self.lastEscape < 0.4 {
                self.lastEscape = 0
                self.dismissAll()
                return nil
            }
            self.lastEscape = now
            return event
        }
    }

    /// Measurement hooks, only under BIRTA_MAC_MEASURE=1: SIGUSR1 summons and
    /// dismisses as the hotkey would (a shell cannot press a global hotkey
    /// without an Accessibility grant); SIGURG posts a message file to the
    /// page. `mac/scripts/measure.sh` drives both, and stages cold recovery
    /// itself by killing the WebContent helper (the private
    /// `_killWebContentProcess` selector does not reach
    /// `webViewWebContentProcessDidTerminate`).
    private func installDebugSignals() {
        let actions: [(Int32, () -> Void)] = [
            (SIGUSR1, { [weak self] in
                self?.key?.markHotkeyPressed()
                self?.toggle()
            }),
            (SIGURG, { [weak self] in self?.key?.postDebugMessageFile() }),
        ]
        for (sig, action) in actions {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler(handler: action)
            source.resume()
            debugSignals.append(source)
        }
        if ProcessInfo.processInfo.environment["BIRTA_MAC_SHOW_ON_LAUNCH"] == "1" {
            DispatchQueue.main.async { [weak self] in self?.summonAll() }
        }
    }
}
