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
        coordinator.onOpenProjectFile = { [weak self, weak coordinator] url, newTab, line in
            guard let coordinator else { return }
            self?.openFromExplorer(url, from: coordinator, inNewTab: newTab, revealing: line)
        }
        coordinator.onNewNoteInFolder = { [weak self, weak coordinator] folder in
            guard let coordinator else { return }
            self?.newNote(in: folder, beside: coordinator)
        }
        coordinator.onFolderDefault = { [weak self] root in self?.folderDefault(in: root) }
        coordinator.heldNames = { [weak self] in self?.boundByAWindow() ?? { _ in false } }
        coordinator.onTrashFolder = { [weak self, weak coordinator] folder in
            guard let coordinator else { return }
            self?.trashFolder(folder, from: coordinator)
        }
        coordinator.onOpenDocumentPanel = { [weak self] in self?.openDocumentPanel() }
        coordinator.onNewNoteHere = { [weak self, weak coordinator] in
            guard let coordinator else { return }
            self?.newNote(replacing: coordinator)
        }
        coordinator.onNewNote = { [weak self] in self?.newNote() }
        coordinator.onOpenRecent = { [weak self] url in self?.openDocument(at: url) }
        coordinator.onFolderIndexRequest = { [weak self, weak coordinator] in
            guard let coordinator else { return }
            self?.folderIndexRequested(by: coordinator)
        }
        coordinator.onShowHiddenChanged = { [weak self] shown in self?.setShowHiddenFiles(shown) }
        coordinator.onFormattingRowChanged = { [weak self] on in self?.setFormattingRowExpanded(on) }
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
                frame: showing.windowFrame.map(NSStringFromRect),
                hadUnwrittenTab: members.contains(where: \.awaitsFirstText) ? true : nil))
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
        // Rule 0 of the plan: the windows come back unless the last quit
        // closed them (`Prefs.takeQuitClosedWindows` says why the mark records
        // the close rather than the keep).
        let restores = !Prefs.takeQuitClosedWindows()
        // A document slot left over from windows the quit closed names a file
        // no window is on, and it outranks every note wherever the settings
        // are asked for the active file; the window that held it is gone, so
        // the slot goes too, as it would have on that window's close. Before
        // the plan's inputs are read, so they and every later reader of the
        // active file agree.
        if !restores { Prefs.documentURL = nil }
        let quickNote = Prefs.binding(enteringAt: .currentNote).url
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
            restoresWindows: restores,
            quickNote: quickNote.standardizedFileURL.path,
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
            // A folder group with no tab left to restore (its only tab was a
            // note never written) is still the folder: it opens on the
            // folder's own choice of file, as opening the folder does.
            var tabs = group.tabs
            var restoredUnwritten = false
            if tabs.isEmpty, let root {
                let choice = folderDefault(in: root)
                tabs = [choice.url.path]
                restoredUnwritten = choice.unwritten
            }
            for path in tabs {
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
            if restoredUnwritten { made.first?.awaitFirstText(openingOnOverview: false) }
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
    /// Whitespace counts as nothing.
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
                let target = try Coordinator.makeNoteFile(in: root, alsoTaken: boundByAWindow())
                open(makeWindow(on: target, slot: nil, inGroupOf: here, explorerRoot: root))
                return
            }
            let target = try Coordinator.makeNoteFile(alsoTaken: boundByAWindow())
            Prefs.currentNoteURL = target
            open(makeWindow(on: target, slot: .currentNote))
        } catch {
            NSLog("Birta Writer: could not make a new note: \(error)")
            key?.flashStatus("Could not make a new note.")
        }
    }

    /// Shift+Cmd+N: a window with no file in it, in the empty state (the
    /// page's start view: New Note, Open, the recent files), for somebody who
    /// wants a window before they know which file or folder it is for.
    ///
    /// Nothing is made on disk. The window is bound to a free name in the
    /// notes folder and marked missing, so it can write nothing and counts as
    /// vacant: a file opened from it, through Open, a recent file or Cmd+O,
    /// takes it over (`openDocument`'s `vacantFront`), and a folder opened
    /// from it replaces it (`openDirectory`). It takes no slot, because it
    /// holds no note to be the app's current one.
    func newEmptyWindow() {
        let target = Coordinator.unusedNoteURL(in: Prefs.notesDirectory, alsoTaken: boundByAWindow())
        let made = makeWindow(on: target, slot: nil)
        made.openEmpty()
        open(made, asSeparateWindow: true)
    }

    /// The start view's New Note in a window holding no file: Cmd+N's note,
    /// made where Cmd+N makes it and given the current-note slot as Cmd+N
    /// gives it, but opened IN the empty window rather than beside it. The
    /// window held nothing, so a new one would leave it behind empty.
    ///
    /// Through `replaceFile`, as a file opened from the empty window is
    /// (`openDocument`'s `vacantFront`), so the takeover is the one every
    /// other way out of the empty state already uses; when that takeover is
    /// abandoned the note opens in a window of its own instead.
    func newNote(replacing here: Coordinator) {
        do {
            let target = try Coordinator.makeNoteFile(alsoTaken: boundByAWindow())
            Prefs.currentNoteURL = target
            releaseSlot(.currentNote, except: here)
            here.replaceFile(with: target, revealing: nil, slot: .currentNote) { [weak self] url in
                guard let self else { return }
                self.open(self.makeWindow(on: url, slot: .currentNote), asSeparateWindow: true)
            }
        } catch {
            NSLog("Birta Writer: could not make a new note: \(error)")
            here.flashStatus("Could not make a new note.")
        }
    }

    /// Cmd+T, the tab bar's `+`, and the system's New Tab rows: a new note,
    /// as a tab beside the one in `spawn`'s window (MAR-393).
    ///
    /// A tab is a window, so this is `newNote` with the window placed into
    /// `spawn`'s tab group instead of cascaded off it. Elsewhere than a
    /// directory window the note takes the current-note slot exactly as
    /// Cmd+N's does; the two gestures differ in where the window goes and in
    /// nothing else.
    ///
    /// In a directory window the tab shares the root and opens on the Folder
    /// Overview, over a note in the root that is NOT written yet (MAR-488).
    /// A tab opened there is as often a way to go somewhere in the folder as
    /// a place to write, and a dot or a recent file moves the tab to that
    /// note; a file made up front would be an empty Untitled note left in
    /// the folder for every tab used that way. So the tab is bound to a free
    /// name and the first write with text in it makes the file
    /// (`UnwrittenNote`); Escape leaves the blank note to type into. It takes
    /// no slot, because a note in somebody's project is not the app's
    /// current note.
    func newTab(in spawn: Coordinator) {
        do {
            if let root = spawn.explorerRoot {
                let target = Coordinator.unusedNoteURL(in: root, alsoTaken: boundByAWindow())
                let tab = makeWindow(on: target, slot: nil, inGroupOf: spawn, explorerRoot: root)
                tab.awaitFirstText(openingOnOverview: true)
                open(tab)
            } else {
                let target = try Coordinator.makeNoteFile(alsoTaken: boundByAWindow())
                Prefs.currentNoteURL = target
                open(makeWindow(on: target, slot: .currentNote, inGroupOf: spawn))
            }
        } catch {
            NSLog("Birta Writer: could not make a new note: \(error)")
            spawn.flashStatus("Could not make a new note.")
        }
    }

    /// Whether an open window is bound to `url`, file or no file. A new note
    /// asks this as well as the disk, because a new tab of a folder window is
    /// bound to a name before anything is written there (`newTab`), and a
    /// second note given that name would be a second buffer over its path.
    ///
    /// Built once per question and asked of many paths, so naming a note does
    /// not cost an identity check per window per candidate name
    /// (`FileIdentity.matcher`).
    private func boundByAWindow() -> (URL) -> Bool {
        FileIdentity.matcher(for: windows.map(\.boundFile))
    }

    /// The explorer's New Note in a folder: a note made in `folder`, as a tab
    /// beside `spawn`. `newTab(in:)` with the folder chosen rather than the
    /// root, and the same reasoning about the slot.
    func newNote(in folder: URL, beside spawn: Coordinator) {
        do {
            let target = try Coordinator.makeNoteFile(in: folder, alsoTaken: boundByAWindow())
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
    /// another tab of this window fronts that tab, and one open in some other
    /// window fronts that window rather than opening a second buffer over one
    /// path. `OpenRouting.explorerDestination`'s header has the argument.
    ///
    /// `line` is the document line a backlink asked to land
    /// on, nil for a row and for Go to File. The routing does not read it,
    /// because it changes nothing about WHERE the file lands; every arm
    /// hands it to the page that ends up showing the file, through
    /// `Coordinator.reveal(line:)` or the reload's own `revealing:`, so the
    /// note opens at the reference on each route rather than where it was
    /// left (MAR-486).
    func openFromExplorer(_ url: URL, from here: Coordinator, inNewTab: Bool, revealing line: Int? = nil) {
        let target = url.standardizedFileURL
        guard let hereIndex = windows.firstIndex(where: { $0 === here }) else { return }
        let routed = OpenRouting.explorerDestination(
            for: target.path,
            windows: routingWindows(),
            here: hereIndex,
            inNewTab: inNewTab,
            // A window on a missing file is replaced, never tabbed beside:
            // it keeps its text in a recovered file as it goes (`isVacant`).
            hereHoldsUnsavedText: here.hasUnwrittenBytes && !Prefs.autosave && !here.isVacant,
            sameFile: Self.sameFile)
        let tabHere: (URL) -> Void = { [weak self, weak here] file in
            guard let self, let here else { return }
            let made = self.makeWindow(on: file, slot: nil, inGroupOf: here, explorerRoot: here.explorerRoot)
            // Before the tab is shown, so the page it builds is cold when
            // asked and its first `init` carries the line.
            if let line { made.reveal(line: line) }
            self.open(made)
        }
        switch routed {
        case let .existing(index):
            let open = windows[index]
            open.selectTab()
            open.show()
            // No fresh page is coming for a file already on screen, so the
            // page that has it is told directly.
            if let line { open.reveal(line: line) }
        case .tabHere:
            tabHere(target)
        case .replaceHere:
            here.replaceFile(with: target, revealing: line, orTab: tabHere)
        }
    }

    /// One watcher per open root, shared by every window rooted there, keyed
    /// by the root's standardized path. A change under a root reaches every
    /// tab of the group, because each tab's page has its own tree.
    private var roots: [String: DirectoryWatcher] = [:]

    /// Per tab in front, the newest tab held back behind it while its page
    /// builds (`open`). Identities rather than references, so a held tab
    /// closed before it is ready is not kept alive by being waited on.
    private var newestHeldTab: [ObjectIdentifier: ObjectIdentifier] = [:]

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
            self?.folderChanged(root, folders: folders)
        }
        watcher.start()
        roots[key] = watcher
    }

    private func releaseUnwatchedRoots() {
        for (key, watcher) in roots where windows(rootedAt: watcher.root).isEmpty {
            watcher.stop()
            roots.removeValue(forKey: key)
            fileIndexes.removeValue(forKey: key)
            folderIndexers.removeValue(forKey: key)
            folderIndexes.removeValue(forKey: key)
            folderIndexStale.remove(key)
        }
    }

    // MARK: the folder edge index (MAR-480)

    /// One indexer per open root, holding what its last build read so the
    /// next build reads only what changed, and the index it last built. Both
    /// go with the root's watcher (`releaseUnwatchedRoots`).
    private var folderIndexers: [String: FolderIndexer] = [:]
    private var folderIndexes: [String: FolderIndex] = [:]
    /// Roots with a build in flight, and those whose tree moved during one:
    /// at most one build per root runs, and a change in the middle of it buys
    /// exactly one more once it lands.
    private var folderIndexBuilding: Set<String> = []
    private var folderIndexStale: Set<String> = []
    /// Serial, so one indexer is never asked twice at once; utility, because
    /// nobody is waiting on a frame for it.
    private let folderIndexQueue = DispatchQueue(label: "com.birtalabs.birta-writer.folder-index", qos: .utility)

    /// A page asked for its root's index: answered now from the last build
    /// when there is one, and the root is built when there is none. Built on
    /// the first ask rather than when the window opens, because the page asks
    /// only once somebody opens the review sidebar, and a cold build is a
    /// walk of the whole tree.
    func folderIndexRequested(by coordinator: Coordinator) {
        guard let root = coordinator.explorerRoot else {
            coordinator.sendFolderIndex(nil)
            return
        }
        let key = root.standardizedFileURL.path
        if let index = folderIndexes[key] {
            coordinator.sendFolderIndex(index)
        } else if !folderIndexBuilding.contains(key) {
            buildFolderIndex(root)
        }
    }

    /// The tree under `root` moved. A root some page is subscribed to, or
    /// one mid-build (whose result would describe the tree before this), is
    /// built again and every subscribed page is sent the result; a root
    /// nobody is subscribed to forgets its index, and the next ask builds it.
    ///
    /// A change only inside hidden folders is not a change to the index,
    /// because the walk never enters them: that is `.git` on every commit and
    /// every status refresh, and an editor's settings folder.
    private func folderChanged(_ root: URL, folders: [URL]) {
        let key = root.standardizedFileURL.path
        let visible = folders.contains { folder in
            guard let rel = DirectoryListing.relativePath(of: folder, in: root) else { return true }
            return !rel.split(separator: "/").contains { $0.hasPrefix(".") }
        }
        guard visible else { return }
        if folderIndexBuilding.contains(key) || windows(rootedAt: root).contains(where: \.folderIndexSubscribed) {
            buildFolderIndex(root)
        } else {
            folderIndexes.removeValue(forKey: key)
        }
    }

    private func buildFolderIndex(_ root: URL) {
        let key = root.standardizedFileURL.path
        guard folderIndexBuilding.insert(key).inserted else {
            folderIndexStale.insert(key)
            return
        }
        let indexer = folderIndexers[key] ?? FolderIndexer(root: root)
        folderIndexers[key] = indexer
        folderIndexQueue.async {
            let built = indexer.build()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.folderIndexBuilding.remove(key)
                // The last window on the root closed while this ran.
                guard self.roots[key] != nil else { return }
                // Most rebuilds follow an autosave that changed no reference.
                // Every page subscribed already holds that index, and a
                // re-send would redraw its Backlinks and Graph tabs (dropping
                // a focused node) for nothing; the VS Code host skips the same.
                // A page that asked since was answered from `folderIndexes`.
                let changed = self.folderIndexes[key] != built
                self.folderIndexes[key] = built
                if changed { self.windows(rootedAt: root).forEach { $0.sendFolderIndex(built) } }
                if self.folderIndexStale.remove(key) != nil { self.buildFolderIndex(root) }
            }
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
        // Never a failure: a folder with nothing to open opens on a note
        // that is not written yet, which is a window like any other.
        let choice = folderDefault(in: root)
        let file = choice.url
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
        // A folder chosen from a window in the empty state is what that
        // window was for, so the folder's window replaces it rather than
        // opening beside a window with nothing in it. The empty window holds
        // no text and can write nothing, so closing it costs nothing.
        let emptied = atLaunch ? nil : key.flatMap { $0.isEmptyState ? $0 : nil }
        let made = makeWindow(on: file, slot: slot(for: file), explorerRoot: root)
        if choice.unwritten { made.awaitFirstText(openingOnOverview: false) }
        if !atLaunch { open(made) }
        // Once the folder's window is up, so the screen never goes blank in
        // between, and only while it is still empty: a file opened into it
        // meanwhile made it a window somebody is using.
        if let emptied {
            made.whenFirstScreen { [weak self, weak emptied] in
                guard let self, let emptied, emptied.isEmptyState else { return }
                self.retire([emptied])
            }
        }
        return made
    }

    /// What a folder's window opens on. `unwritten` is a note bound to a free
    /// name in the folder with no file made for it yet (`UnwrittenNote`):
    /// whoever binds a window to it says so with `awaitFirstText`.
    struct FolderDefault {
        let url: URL
        let unwritten: Bool
    }

    /// The file a folder's window opens on: `DirectoryListing.firstToOpen`'s
    /// rule, else a new note in the folder that is not written until it is
    /// typed in. The same answer for opening the folder, for a window whose
    /// file was just trashed from it, and for a folder window coming back at
    /// launch with no tab left, so none of them leaves an empty Untitled note
    /// in a folder nobody wrote in.
    ///
    /// A file open in another window already is not a candidate: a window is
    /// one buffer, and a second one over the same path is the hazard
    /// `openDocument` guards against for every other route in. The window
    /// opens on the next candidate, or on a new note when the open file was
    /// the only one.
    func folderDefault(in root: URL) -> FolderDefault {
        let openElsewhere = boundByAWindow()
        if let found = DirectoryListing.firstToOpen(in: root, recents: Prefs.recentDocuments,
                                                    accepts: { DocumentTypes.accepts($0) && !openElsewhere($0) }) {
            return FolderDefault(url: found, unwritten: false)
        }
        return FolderDefault(url: Coordinator.unusedNoteURL(in: root, alsoTaken: openElsewhere), unwritten: true)
    }

    /// Move a folder of `origin`'s explorer to the Trash, and move on every
    /// tab of `origin`'s group that was on a file inside it, as trashing the
    /// file a tab is on does (`Coordinator.moveToTrash`): each tab opens the
    /// folder window's own choice of file (`folderDefault`).
    ///
    /// Every affected tab is settled before the one trash, so a write
    /// autosave owes lands in the folder before it goes rather than
    /// recreating it afterwards. A tab whose buffer is still ahead of its
    /// file stays where it is, and its missing-file card offers Restore.
    ///
    /// Only this group moves on, because it is the window the reader acted
    /// in. A tab of another window on a file inside the folder hears about
    /// it the way it hears about a Finder trash, through its watcher: the card
    /// saying the file is in the Trash, with Restore.
    func trashFolder(_ folder: URL, from origin: Coordinator) {
        guard let root = origin.explorerRoot else {
            origin.trash(folder)
            return
        }
        let affected = windows(rootedAt: root).filter { DirectoryListing.isInside($0.boundFile, root: folder) }
        guard !affected.isEmpty else {
            origin.trash(folder)
            return
        }
        var mayLeave: [ObjectIdentifier: Bool] = [:]
        let settled = DispatchGroup()
        for tab in affected {
            settled.enter()
            tab.settleBeforeTrash { leave in
                mayLeave[ObjectIdentifier(tab)] = leave
                settled.leave()
            }
        }
        settled.notify(queue: .main) { [weak self, weak origin] in
            guard let self, let origin, origin.trash(folder) else { return }
            // Trash and rebind in one turn, as the single-file path does, so
            // no watcher's report of the trash reaches a tab that moved on.
            // One at a time through `folderDefault`, which skips a file open
            // in any window, so two tabs never land on the same file.
            for tab in affected where mayLeave[ObjectIdentifier(tab)] == true {
                tab.openFolderDefault(self.folderDefault(in: root))
            }
            // `openInPlace` shows each tab it rebinds; the reader's own tab
            // is the one left in front.
            if affected.count > 1 || !affected.contains(where: { $0 === origin }) { origin.show() }
        }
    }

    /// The hidden-files setting, flipped from a menu row or a page, applied
    /// to the store and to every rooted window's page and menu mirror.
    func setShowHiddenFiles(_ shown: Bool) {
        Prefs.explorerShowsHidden = shown
        windows.forEach { $0.applyShowHiddenFiles(shown) }
    }

    /// The formatting row was switched on or off: the app's one answer moves,
    /// and every window's page follows it, including any that already agree
    /// (the page treats a push that changes nothing as nothing).
    ///
    /// Two callers, and the page is one of them: the gear menu carries a
    /// switch beside the Settings window's. What the page posts is a REQUEST
    /// (`setFormattingRowExpanded`, handed up by `Coordinator`), so the page
    /// that asked hears the answer on the way back exactly as its siblings do
    /// and cannot get ahead of the stored setting.
    func setFormattingRowExpanded(_ expanded: Bool) {
        Prefs.formattingRowExpanded = expanded
        windows.forEach { $0.applyFormattingRowExpanded(expanded) }
    }

    /// View > Line Numbers: the app's one setting, and every window's page.
    func setLineNumbers(_ enabled: Bool) {
        Prefs.lineNumbers = enabled
        windows.forEach { $0.applyLineNumbers(enabled) }
    }

    /// View > Show Path Bar: the app's one setting, and every window's page.
    func setPathBar(_ shown: Bool) {
        Prefs.pathBar = shown
        windows.forEach { $0.applyPathBar(shown) }
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
                   mode: { Prefs.appearance.mode },
                   kind: { [weak self] in self?.appearance.kind ?? .light })
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
    /// `isVacant` is the whole of the test. A window with text on screen is
    /// taken over too: it keeps that text in a recovered file as it goes, and
    /// the coordinator states when that copy is made.
    func openDocument(at url: URL) {
        let target = url.standardizedFileURL
        if DocumentTypes.isDirectory(target) {
            openDirectory(at: target)
            return
        }
        // The allowlist, widened by exactly the file a shell has declared it
        // is waiting on: `bwr --wait` admits an extensionless file because the
        // caller chose it (`git commit` names `COMMIT_EDITMSG`), and it
        // registers the wait before the open so this end can tell that file
        // from a stray `Makefile`. `CliInvocation.target(for:)` is the other
        // half and says why the class is safe to admit.
        // The line a `bwr --at` sent ahead of this open, spent here whether
        // or not the file is admitted, so a refused open leaves nothing
        // behind for a later one. Every arm below hands it to the page that
        // ends up showing the file, as `openFromExplorer` does a backlink's.
        let reveal = reveals.take(target.path, now: Date())
        let line = reveal?.line
        guard DocumentTypes.accepts(target) || waits.isWaiting(on: target.path) else {
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
        // A file a shell is blocked on is a passing edit (git's message
        // file, which git deletes once the wait ends), so it lands as a tab
        // of the front window and takes no app-wide slot: closing that tab
        // ends the wait and leaves the window on the note it held, where an
        // open in place would have left the note window, and the document
        // setting, bound to a file that is about to be gone (MAR-466). A
        // file already open is fronted as any other.
        if waits.isWaiting(on: target.path), let host = key {
            if case .existing = routed {} else {
                open(revealing(makeWindow(on: target, slot: nil, inGroupOf: host, explorerRoot: host.explorerRoot), line))
                return
            }
        }
        switch routed {
        case let .existing(index):
            let open = windows[index]
            open.selectTab()
            open.show()
            // No fresh page is coming for a file already on screen, so the
            // page that has it is told directly. Its buffer may be ahead of
            // the disk the line was read from, so a heading is found again
            // in what the window holds.
            if let reveal { open.reveal(reveal) }
        case let .tabIn(index):
            // A file under an open folder joins that folder's window as a
            // tab with the same root, so its row is selected in the explorer
            // by the tab's own load; it takes no app-wide slot, because a
            // file in somebody's project is not the app's document.
            let host = windows[index]
            open(revealing(makeWindow(on: target, slot: nil, inGroupOf: host, explorerRoot: host.explorerRoot), line))
        case .vacantFront:
            guard let here = key else { return }
            // A file under this tab's own folder is a file of the folder, and
            // a rooted tab holds no slot (`replaceFile` says why), so it is
            // opened in place and no setting is written.
            //
            // Through `replaceFile`, never straight to `openInPlace`: the
            // vacancy was read off the host's copy of the buffer, and the page
            // can hold keystrokes whose sync has not landed yet (a new tab
            // typed into a moment ago). The flush brings them across first;
            // a tab that turns out to hold text is then written on the hiding
            // rule, or, with autosave off, left alone while the file opens
            // beside it, so no keystroke can be dropped by the takeover.
            //
            // Both branches go through that one takeover. A loose vacant
            // window is one whose file went missing, and what was typed into
            // it since its last sync is what its recovered copy has to hold.
            if let root = here.explorerRoot, DirectoryListing.isInside(target, root: root) {
                here.replaceFile(with: target, revealing: line) { [weak self, weak here] url in
                    guard let self, let here else { return }
                    self.open(self.revealing(self.makeWindow(on: url, slot: nil, inGroupOf: here, explorerRoot: root), line))
                }
                return
            }
            Prefs.documentURL = target
            // The same release every spawn does, and needed for the same
            // reason: only one window may hold a slot, or two would both write
            // a rename back to one setting.
            releaseSlot(.document, except: here)
            here.replaceFile(with: target, revealing: line, slot: .document) { [weak self] url in
                guard let self else { return }
                self.open(self.revealing(self.makeWindow(on: url, slot: .document), line), asSeparateWindow: true)
            }
        case let .tabBeside(index):
            // A loose file as a tab of the window in front, on the "Open
            // files in" setting. The tab is a loose window like any other
            // (no root, so no explorer of its own), and it takes the
            // document slot exactly as a window of its own would.
            Prefs.documentURL = target
            open(revealing(makeWindow(on: target, slot: .document, inGroupOf: windows[index]), line))
        case .newWindow:
            Prefs.documentURL = target
            // The setting asked for a window, so the system's Prefer tabs
            // preference is not given the chance to make it a tab; with no
            // window open the answer is a window either way.
            open(revealing(makeWindow(on: target, slot: .document), line), asSeparateWindow: Prefs.openFilesIn == .window)
        }
    }

    /// `coordinator`, told the line its first page opens on when there is
    /// one. Asked before the window is opened, so the page it builds is cold
    /// when asked and its first `init` carries the line.
    private func revealing(_ coordinator: Coordinator, _ line: Int?) -> Coordinator {
        if let line { coordinator.reveal(line: line) }
        return coordinator
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
        SandboxAccess.remember(url)
        openDocument(at: url)
    }

    /// The close button and Cmd+W.
    ///
    /// A window that closes is gone: it is not put back by the next summon,
    /// a Dock click, or a launch. That includes the last one, which closes
    /// for real and leaves the quick note behind it, hidden and mounted
    /// (`leaveQuickNote`), so the summon still has something instant to bring
    /// up and it is a note rather than the document somebody just closed.
    /// The quick note itself, alone as the last window, hides instead: it is
    /// what the summon is for, and tearing its WKWebView down would make the
    /// next summon a cold start. `TabGroupPolicy.whatCloseDoes` is the rule.
    ///
    /// Every real close goes through the same question a quit asks: with
    /// autosave off and unwritten bytes it asks, and Cancel leaves the window
    /// where it is.
    func close(_ coordinator: Coordinator) {
        // Asked only of a last window: the answer is a filesystem question,
        // and every other close would pay it for nothing.
        let quick = windows.count <= 1 && isQuickNote(coordinator)
        switch TabGroupPolicy.whatCloseDoes(windows: windows.count, lastIsQuickNote: quick) {
        case .hideAll:
            closeLastWindow(coordinator)
        case .closeTab, .closeWindow, .closeToQuickNote:
            retire([coordinator])
        }
    }

    /// Shift+Cmd+W: every tab in `coordinator`'s window, through the same
    /// question a quit asks of each, serially, one Cancel refusing the rest.
    /// A window holding every window the app has closes to the quick note,
    /// or hides when it is the quick note
    /// (`TabGroupPolicy.whatCloseWindowDoes`).
    func closeWindow(_ coordinator: Coordinator) {
        let members = tabs(of: coordinator)
        let quick = members.count >= windows.count && isQuickNote(coordinator)
        switch TabGroupPolicy.whatCloseWindowDoes(tabsInWindow: members.count, windows: windows.count,
                                                  lastIsQuickNote: quick) {
        case .hideAll:
            closeLastWindow(coordinator)
        case .closeTab, .closeWindow, .closeToQuickNote:
            retire(members)
        }
    }

    /// Close `members` for real, one at a time, each through
    /// `prepareToClose`, stopping at the first Cancel. When that leaves the
    /// app with no window, the quick note takes the empty place.
    private func retire(_ members: [Coordinator]) {
        var remaining = members
        func next() {
            guard !remaining.isEmpty else {
                if windows.isEmpty { leaveQuickNote() }
                return
            }
            let tab = remaining.removeFirst()
            // Closed already, by another close made while an earlier tab's
            // sheet was up. Its page is torn down and would never answer, so
            // asking it would stall the chain before the quick note is left.
            guard windows.contains(where: { $0 === tab }) else {
                next()
                return
            }
            let file = tab.boundFile
            let failuresBefore = tab.writeFailures
            tab.prepareToClose { [weak self] proceed in
                guard proceed, let self else { return }
                // The bytes the close decided on have landed: `prepareToClose`
                // waits for its write. A shell blocked on this file hears now.
                self.documentClosed(tab, file: file, failuresBefore: failuresBefore)
                // The file this window was on joins the recents list, and
                // closing is the second of the only two ways a file stops being
                // on screen. `Coordinator.boundURL`'s `didSet` records the
                // other, a rebind; a window that opens a file and closes never
                // rebinds, so without this the file it was showing is one Open
                // Recent has never heard of.
                Prefs.rememberRecent(tab.boundFile)
                // The document slot goes with the window that held it. The slot
                // is the setting a rename writes back to, and with the window
                // gone there is nothing to write back for. It must not outlive
                // the window: a document setting left standing is a file the
                // app would open in preference to every note, on a launch with
                // nothing recorded and on Back to My Notes.
                if tab.bindingSlot == .document { Prefs.documentURL = nil }
                self.windows.removeAll { $0 === tab }
                tab.tearDown()
                // The tab that went may have been the second-to-last of its
                // bar, which then disappears and hands its row back to the page.
                self.windows.forEach { $0.tabsChanged() }
                self.releaseUnwatchedRoots()
                self.recordOpenSetSoon()
                next()
            }
        }
        next()
    }

    /// Whether `coordinator` is on the quick note: the scratchpad or the note
    /// New Note last made, in a window that is not rooted at a folder. Whether
    /// it is ALONE is the policy's question (`TabGroupPolicy`), so the rule
    /// that a note sharing a tab bar closes like any document lives once.
    private func isQuickNote(_ coordinator: Coordinator) -> Bool {
        guard coordinator.explorerRoot == nil else { return false }
        let file = coordinator.boundFile
        return FileIdentity.sameFile(file, Prefs.scratchpadURL)
            || Prefs.currentNoteURL.map { FileIdentity.sameFile(file, $0) } == true
    }

    /// The last window has closed. Put the quick note in its place, mounted
    /// and hidden, which is the state a launch leaves the app in.
    ///
    /// There is always a window: the summon key, the menu-bar item, the Dock
    /// icon and every command that acts on "the window in front" ask this set
    /// for one, and an app with none would answer each of them with nothing.
    ///
    /// What happens to the focus follows the Dock setting, which is the
    /// reader saying what kind of program this is (`WindowPolicy`). With a
    /// Dock icon the app stays active with no window, as any document app
    /// does when its last window closes. Without one the app has nothing left
    /// on screen to be active for, so the reader goes back to what they were
    /// in, as a dismissal does.
    private func leaveQuickNote() {
        let binding = Prefs.binding(enteringAt: .currentNote)
        makeWindow(on: binding.url, slot: binding.slot).start()
        summonActivation.disarm()
        guard !Prefs.showInDock else { return }
        hidePreferences?()
        returnToPreviousApp()
    }

    /// Cmd+W on the quick note when it is the last window, which hides rather
    /// than closes.
    ///
    /// For a file a shell is blocked on in `bwr --wait` the hide is not
    /// enough: a hide writes only with autosave on, and the shell is about to
    /// read the file. So the buffer is first settled the way a close settles
    /// it, sheet included (`Coordinator.settleForWaitingShell`), and the
    /// window hides afterwards exactly as it otherwise would; Cancel on that
    /// sheet leaves it up. Every other last window hides as it always did.
    private func closeLastWindow(_ coordinator: Coordinator) {
        let file = coordinator.boundFile
        guard waits.isWaiting(on: file.path) else {
            hideQuickNote()
            return
        }
        let failuresBefore = coordinator.writeFailures
        coordinator.settleForWaitingShell { [weak self] answer in
            guard let self, answer != .cancel else { return }
            self.hideQuickNote()
            self.documentClosed(coordinator, file: file, failuresBefore: failuresBefore)
        }
    }

    /// The quick note hiding as the last window. Where the focus goes follows
    /// the Dock setting, for the reason `leaveQuickNote` gives: a last window
    /// closing is one gesture whatever it held. Without a Dock icon it is a
    /// dismissal, back to what the reader was in.
    private func hideQuickNote() {
        guard Prefs.showInDock else {
            dismissAll()
            return
        }
        summonActivation.disarm()
        windows.forEach { $0.hide() }
    }

    // MARK: a shell waiting on a document

    /// The shells blocked in `bwr --wait`, by the file each waits on.
    ///
    /// `ControlSocket.Waits` is the rule for what ends a wait and with what
    /// answer. What is here is which gesture is which exit: a tab closing
    /// (`close`), a window closing (`closeWindow`), the last window's Cmd+W
    /// (`closeLastWindow`), and a quit (`prepareToTerminate`), each answering
    /// only once the bytes that exit decided on have landed. A wait is also
    /// what admits a file the app would otherwise turn away (`openDocument`).
    private(set) var waits = ControlSocket.Waits()

    /// Sends an answer to its shell. The app's `ControlListener` installs it;
    /// without one every answer is dropped and no wait ever ends, which is
    /// what a shell sees when the app could not bind its socket at launch.
    var answerShell: ((ControlSocket.Waits.Answer) -> Void)?

    /// The lines `bwr --at` sent ahead of an open, by file; spent by
    /// `openDocument`. `ControlSocket.Reveals` is the rule for how long one
    /// is held and which of two wins.
    private var reveals = ControlSocket.Reveals()

    /// A shell is about to open `path` and wants it to land on `line`.
    func shellReveals(_ path: String, line: Int, heading: String?) {
        reveals.register(path: path, line: line, heading: heading, now: Date())
    }

    /// A shell has asked to be told when the document at `path` is closed.
    func shellWaits(_ connection: ControlSocket.Waits.Connection, on path: String) {
        answer(waits.register(connection, path: path))
    }

    /// The shell went away first. Its wait is forgotten and nothing changes
    /// for the document.
    func shellWentAway(_ connection: ControlSocket.Waits.Connection) {
        waits.forget(connection)
    }

    private func answer(_ answers: [ControlSocket.Waits.Answer]) {
        answers.forEach { answerShell?($0) }
    }

    /// A document a shell may be waiting on has closed and its close has
    /// settled the file, for better or worse.
    ///
    /// `failuresBefore` is `coordinator.writeFailures` read before the
    /// gesture began: a count that moved means the close's own write threw,
    /// and the shell is told so rather than told the document closed.
    private func documentClosed(_ coordinator: Coordinator, file: URL, failuresBefore: Int) {
        guard waits.isWaiting(on: file.path) else { return }
        let outcome: ControlSocket.CloseOutcome = coordinator.writeFailures > failuresBefore
            ? .writeFailed(coordinator.lastWriteFailure ?? "the write failed")
            : .written
        answer(waits.documentClosed(file.path, outcome: outcome))
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
        // A tab added behind the one in front (`makeWindow`) comes forward
        // when its page says its first screen is up, so the reader goes
        // from the note they were in to the finished new one, and never sees
        // the page assemble in between. It is in the bar from the start,
        // which is the answer to the click, and it can be picked from there
        // before it is finished.
        if let showing = coordinator.tabShowingInstead {
            let from = ObjectIdentifier(showing)
            let held = ObjectIdentifier(coordinator)
            newestHeldTab[from] = held
            coordinator.whenFirstScreen { [weak self, weak coordinator, weak showing] in
                guard let self, let coordinator else { return }
                // Only the newest tab asked for from this tab comes forward:
                // two links followed in quick succession end on the second,
                // and the first waits in the bar.
                guard self.newestHeldTab[from] == held else { return }
                self.newestHeldTab[from] = nil
                // And only while the reader is still where they asked from.
                // A tab they picked themselves meanwhile, this one included,
                // is where they meant to be.
                guard let showing, coordinator.tabShowingInstead === showing else { return }
                if NSApp.isActive {
                    coordinator.show()
                } else {
                    // The reader has gone to another app: the tab changes
                    // under them, where they left it, and nothing is brought
                    // in front of what they went to.
                    coordinator.selectTab()
                }
            }
            return
        }
        // Anything else comes on screen by itself, and the same rule holds:
        // it comes when its page is finished rather than as paper first. The
        // page builds hidden, as a launch's prewarm does; the bound in
        // `whenFirstScreen` is what keeps a page that never answers from
        // keeping its window away.
        coordinator.whenFirstScreen { [weak coordinator] in
            // Already up: something else showed it meanwhile (a summon of
            // every window), and showing it again would take the keyboard
            // a second time.
            guard let coordinator, !coordinator.isVisible else { return }
            if asSeparateWindow {
                coordinator.withAutomaticTabbingSuspended { coordinator.show() }
            } else {
                coordinator.show()
            }
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
                // A quit the person made closes the windows when macOS says
                // quitting does; one nobody made (an update, an installer, the
                // session ending) keeps them (`OpenSet.launchPlan`, rule 0).
                if OpenSet.quitClosesWindows(unattended: quitIsUnattended, sessionEnding: sessionIsEnding,
                                             systemKeepsWindows: Prefs.systemQuitKeepsWindows) {
                    Prefs.setQuitClosedWindows()
                }
                releaseHotkey()
                // Every window has written what it is going to. A shell still
                // waiting on any of them is told the app quit, which is not a
                // close: git treats an editor that went away as an
                // interrupted edit, and so does this.
                answer(waits.quitting())
                done(true)
                return
            }
            let next = remaining.removeFirst()
            next.prepareToClose { [weak self] proceed in
                guard let self else { done(proceed); return }
                guard proceed else {
                    self.windows.forEach { $0.forgetQuitDecision() }
                    // A Cancel here ends a log out too, and the session goes
                    // on: the next quit is the person's own again, and has to
                    // be told apart from the system's as if no log out had
                    // begun. Left set, every later quit would keep the windows.
                    self.sessionIsEnding = false
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
        quitIsUnattended = true
        windows.forEach { $0.quitIsUnattended = true }
    }

    /// Whether the quit under way is one nobody made, which the next launch
    /// reads as a reason to put the windows back.
    private var quitIsUnattended = false

    /// Whether the session is ending (log out, restart, shut down). That quit
    /// is the system's, and macOS's own Reopen windows when logging back in
    /// is what decides whether the app comes back at all; when it does, it
    /// comes back with its windows, as every restoring app does.
    private var sessionIsEnding = false
    private var powerOffObserver: NSObjectProtocol?

    /// Every window dims and says what the update is doing, because the
    /// restart that ends this takes all of them, not only the one the offer
    /// was answered on.
    func showUpdateProgress(_ title: String, detail: String) {
        windows.forEach { $0.showUpdateProgress(title, detail: detail) }
    }

    /// Whether an update cover is up, which is what decides where the
    /// updater's status lines go.
    var isShowingUpdateProgress: Bool { windows.contains { $0.isShowingUpdateProgress } }

    func hideUpdateProgress() {
        windows.forEach { $0.hideUpdateProgress() }
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

    /// `activating: false` puts the windows back on screen without taking
    /// the front, for the relaunch after an unattended swap.
    func summonAll(activating: Bool = true) {
        windows.forEach { $0.show(activating: activating) }
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
        // Posted before the terminate a log out, restart or shut down sends,
        // which is the only thing that tells that quit from the person's own.
        powerOffObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.sessionIsEnding = true }
        }
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
