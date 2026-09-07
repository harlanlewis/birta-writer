import AppKit
import BirtaWriterCore
import CryptoKit

/// Keeps the release build up to date with the newest one published.
///
/// The app is on no app store and cannot be, so without this the only way to
/// get a fix is to notice a release happened and run a shell script, which is
/// a thing nobody does.
///
/// What it sends: a GET to the project's own release host asking what the
/// newest release is, and then the archive itself. Nothing about the document,
/// nothing about the machine, and no identifier this app invents. It is a rung
/// of its own in `docs/NETWORK_POSTURE.md`, separate from the editor's
/// `networkEnabled` switch, because the two are different consents: one is
/// about what happens to what you type, and this is about the app replacing
/// itself.
///
/// The RELEASE build only, and only under a real user's defaults. The flavour
/// guard is because a development build that replaced itself would delete the
/// change somebody installed it to look at; the defaults guard is because a
/// scripted run gets a throwaway domain where this would otherwise be on, and
/// an app being driven by synthesized events cannot answer a modal.
///
/// ## Three steps, and only the last one is ever in front of anybody
///
/// CHECK asks what the newest release is. STAGE fetches it, verifies the
/// published checksum, unpacks it and leaves it in the temporary directory.
/// ARM hands a swap to a script that runs once this process is gone.
///
/// With automatic updates on, check and stage both happen on their own, and
/// the download starts the moment a check finds something rather than waiting
/// for an answer to a sheet. Not over a connection somebody pays for by the
/// byte: that is the one thing here that spends money unasked, and
/// `NetworkPath` holds why the offer is not held to the same rule. That is what makes the two ways in cheap: the
/// offer, when somebody is here to answer it, restarts into bytes that have
/// already arrived, and `App.applyStagedUpdateIfUnattended` puts the same
/// bytes in with nobody asked when `UpdatePolicy.isUnattended` can prove there
/// is nobody to interrupt.
///
/// Nothing is staged for a version somebody declined, and declining discards
/// what was staged. A no is an answer about the version, and it is honoured by
/// both ways in.
@MainActor
final class Updater {
    /// What a check found. Every outcome is named, so a caller cannot mistake
    /// a failure for an answer: a check that could not reach the host is not
    /// the same as one that found nothing, and saying "up to date" for both is
    /// a false statement about the thing the user pressed a button to learn.
    enum CheckResult: Equatable {
        case found(String)
        case upToDate
        case failed
        /// Not attempted: a build that does not update itself, a throwaway
        /// defaults domain, or a check already in flight. Separate from
        /// `failed` because "could not check" about a check that never
        /// happened is the same false statement this type exists to remove.
        case refused
    }

    /// An update that has arrived, been checked and been unpacked, waiting for
    /// a moment to go in.
    ///
    /// It lives in the temporary directory, which is the right place for it:
    /// nothing here survives a restart of the machine, and nothing should. A
    /// staged update that is a week old is a version the app would find again
    /// in one request.
    struct Staged: Equatable {
        /// The release it came from, as the offer and the notice both name it.
        let tag: String
        /// The unpacked `.app`, ready to be moved into place.
        let bundle: URL
        /// The directory holding it, removed when the swap runs or the version
        /// is declined.
        let work: URL
    }

    /// How the app comes back after the swap.
    ///
    /// A swap somebody asked for reopens in front of them, which is where
    /// they were looking. A swap that went in because nobody was there must
    /// not take the front from whatever they left running, so it reopens
    /// without activating: the whole claim of the unattended path is that a
    /// person who walks away and comes back finds their machine as they left
    /// it. And a swap they asked to have happen AFTER THEY QUIT does not
    /// reopen at all: the next launch is theirs, and an app that came back on
    /// its own after being quit is an app that did not quit.
    enum Reopen: Equatable {
        case front, background, none

        /// The word the swap script is handed, and reads back by name.
        var argument: String {
            switch self {
            case .front: return "front"
            case .background: return "background"
            case .none: return "none"
            }
        }
    }

    /// Something newer exists, with the tag to name it. Raised by the checks
    /// the app makes on its own, never by one somebody pressed a button for:
    /// that one answers the button instead.
    var onUpdateAvailable: ((String) -> Void)?
    /// Progress and outcome, for the status line.
    var onStatus: ((String) -> Void)?

    private(set) var available: ReleaseFeed.Release?
    /// The update that has been fetched and checked, if there is one.
    private(set) var staged: Staged?
    /// A swap script is running and this process is about to go.
    ///
    /// The app stays responsive through a download, so without this a second
    /// trip through Settings arms a second script, and the two wake on the
    /// same pid and race each other over one destination. That is the hazard
    /// `install-app.sh` flavours its staging paths to avoid, one layer up.
    private(set) var armed = false

    private var checking = false
    /// A fetch-verify-unpack run is in flight.
    private var staging = false
    /// Why the last staging run staged nothing, for a caller that has to put
    /// the reason in front of somebody. Cleared by the next run that succeeds.
    ///
    /// The status line already carries it, and that is the problem: a person
    /// who pressed Install on Next Launch in the About window is looking at
    /// the About window, and the panel's status line is behind it or hidden.
    private(set) var lastFailure: String?
    /// Callers waiting on that run. More than one, because the offer can be
    /// confirmed while the background staging it did not start is still going.
    private var waiting: [(Staged?) -> Void] = []
    /// Whether the run in flight is one somebody is watching for an answer to.
    ///
    /// Owned entirely by `install`, which sets it before staging and clears it
    /// in the completion, so every path out restores it. A background run says
    /// nothing: it was not asked for, and a person who did nothing cannot act
    /// on "could not download the update".
    private var announcing = false

    /// The repository releases are fetched from, which must be the one the
    /// About window sends bug reports to: `AboutInfo.repository` is that one
    /// string, and an app that updated from one repository and filed issues
    /// against another would be wrong in a way nobody would notice.
    private let repo = ProcessInfo.processInfo.environment["BIRTA_MAC_REPO"] ?? AboutInfo.repository

    /// Everything the work below needs that is not this type's own state.
    ///
    /// A seam, and it exists because the two gates below both read TRUE in an
    /// xctest process: `AppFlavor.forBundle` answers `.release` for any bundle
    /// id that is not the development one, and nothing sets a throwaway
    /// defaults suite. So calling `check(force:)` from a test reached
    /// api.github.com for real, which meant every `CheckResult` other than
    /// `.refused` was untestable and the status strings behind them were
    /// unasserted. Injecting the gate and the transport makes the whole
    /// outcome table reachable without a network.
    ///
    /// Staging is behind the same seam and for a sharper reason than
    /// testability: a check that finds something now DOWNLOADS on its own, so
    /// a test that did not inject `download` would reach the release host for
    /// real without ever calling the method that does it.
    struct Environment {
        var mayCheck: () -> Bool = { AppFlavor.current.updatesItself && Prefs.isUserStore }
        var autoUpdate: () -> Bool = { Prefs.autoUpdate }
        /// The version already answered no to, which is neither offered nor
        /// staged. Read here rather than only at the offer, because the
        /// bandwidth is spent before the offer is built.
        var declined: () -> String? = { Prefs.updateDeclinedTag }
        var now: () -> Date = Date.init
        var lastCheck: () -> Date? = { Prefs.lastUpdateCheck }
        var recordCheck: (Date) -> Void = { Prefs.lastUpdateCheck = $0 }
        var currentVersion: () -> String = {
            Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
                ?? AboutInfo.unstampedVersion
        }
        /// Answers with the body and the HTTP status, 0 for a transport
        /// failure. One closure rather than a URLSession subclass: what a test
        /// needs to vary is the answer, not the machinery that fetched it.
        var fetch: (URL, @escaping (Data?, Int) -> Void) -> Void = { url, done in
            var request = URLRequest(url: url)
            request.timeoutInterval = 15
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            URLSession.shared.dataTask(with: request) { data, response, _ in
                done(data, (response as? HTTPURLResponse)?.statusCode ?? 0)
            }.resume()
        }
        /// The archive and the checksum beside it. Separate from `fetch`,
        /// which reports a status code because a check has to tell a 500 from
        /// a 200; a download either arrived or it did not, and a body that
        /// came with an error status is not an archive.
        var download: (URL, @escaping (Data?) -> Void) -> Void = { url, done in
            URLSession.shared.dataTask(with: url) { data, response, error in
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                done(error == nil && (200..<300).contains(code) ? data : nil)
            }.resume()
        }
        /// Whether the only network this Mac has is one somebody pays for by
        /// the byte, or has asked macOS to go easy on. `NetworkPath` is where
        /// the argument lives, including why the offer is not gated on it.
        var onMeteredNetwork: () -> Bool = { NetworkPath.shared.isMetered }
        /// Whether this Mac can launch the bundle that was downloaded.
        ///
        /// The two defaults below are `nonisolated` statics. `Environment` is
        /// a nested type and so inherits none of this class's isolation, and a
        /// main-actor function stored in one of its plain closure fields is an
        /// error under the Swift 6 language mode. Neither reaches any state
        /// that needs the actor: one reads a downloaded bundle, the other
        /// spawns a process.
        var compatibility: (URL) -> SystemRequirements.Verdict = Updater.compatibility(of:)
        /// Hand the swap to a process that outlives this one, and say whether
        /// it started. Injected because the real one waits for this pid: run
        /// from a test it would wait for the test process and then move a
        /// bundle nobody asked it to.
        var armSwap: (Staged, Reopen) -> Bool = Updater.runSwap
    }

    var environment = Environment()

    /// This build's version, as `Info.plist` carries it. A checkout build says
    /// `0.0.0`, which every real release is newer than; the flavour guard is
    /// what stops that mattering.
    private var currentVersion: String { environment.currentVersion() }

    /// Whether this process may check at all.
    ///
    /// `isUserStore` is the same predicate the panel's frame autosave uses,
    /// and it is here for a sharper reason: `measure.sh` drives the RELEASE
    /// bundle under a throwaway domain, where `autoUpdate` defaults on and the
    /// checkout's `0.0.0` is older than every release. Without this, every
    /// scripted run would reach the network, download a release and replace
    /// the app being measured.
    private var mayCheck: Bool { environment.mayCheck() }

    // MARK: checking

    /// Ask, and say what came back.
    ///
    /// `force` is the user pressing a button, which happens whatever the
    /// automatic setting says. It does NOT write the setting: doing that and
    /// putting it back a statement later leaves auto-update permanently on for
    /// somebody who turned it off, if anything goes wrong in between.
    func check(force: Bool = false, then done: ((CheckResult) -> Void)? = nil) {
        guard mayCheck, force || environment.autoUpdate(), !checking else {
            done?(.refused)
            return
        }
        guard let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else {
            done?(.failed)
            return
        }
        checking = true
        // Stamped when the request GOES OUT, not when it comes back, and that
        // is deliberate: a machine that is offline fails every check, and a
        // stamp written only on success would mean a laptop on a plane retried
        // on every timer tick for the whole flight. The question this paces is
        // how often the app reaches for the network, and it reached.
        environment.recordCheck(environment.now())
        environment.fetch(url) { [weak self] data, code in
            Task { @MainActor in
                guard let self else { return }
                self.checking = false
                guard code == 200, let data, let release = ReleaseFeed.parse(data) else {
                    done?(.failed)
                    return
                }
                guard ReleaseFeed.isNewer(release.tag, than: self.currentVersion) else {
                    done?(.upToDate)
                    return
                }
                self.available = release
                // Fetched before anybody is asked, which is the whole of what
                // the automatic setting now buys: by the time the offer is
                // answered, or the machine goes quiet, there is nothing left
                // to wait for. Not for a version already declined, which would
                // be spending somebody's bandwidth on an answer they gave.
                if self.environment.autoUpdate(),
                   !self.environment.onMeteredNetwork(),
                   UpdatePolicy.shouldOffer(tag: release.tag, declined: self.environment.declined()) {
                    self.stage(release)
                }
                // The offer is for a check nobody asked for. A forced check
                // is a button, and the button's own completion carries the
                // answer; raising the offer as well would put two sheets
                // about one release on the same window. And not while a swap
                // is armed: that swap runs at the next quit whatever is
                // offered, so a Restart button here would reach `install`,
                // be refused, and do nothing. The quit installs what was
                // armed and the launch after it finds this release again.
                if !force, !self.armed { self.onUpdateAvailable?(release.tag) }
                done?(.found(release.tag))
            }
        }
    }

    /// The launch check. Silent unless there is something: a check that failed
    /// because the machine is offline is not news, and an app that says so on
    /// every launch is an app people turn off.
    func checkInBackground() {
        check()
    }

    /// The check a running app makes on its own, paced by the clock.
    ///
    /// Separate from `checkInBackground` because a launch should always ask
    /// and this should ask only when it is due. The app stays running for weeks,
    /// so without this the launch check is the only one that ever happens and
    /// somebody who never quits is somebody who never gets a fix.
    func checkIfDue() {
        guard UpdatePolicy.shouldCheck(now: environment.now(),
                                       lastCheck: environment.lastCheck()) else { return }
        check()
    }

    /// A check somebody asked for: the menu row, or the button in Settings.
    ///
    /// Answers through `done`, and every outcome reaches it, because a press
    /// that hears nothing back is a button that looks broken. What it says on
    /// the status line is only that the check has started: the answer is the
    /// caller's to put in front of the person, on the window they pressed
    /// from, which the panel's status line may well be hidden behind.
    func checkNow(then done: @escaping (CheckResult) -> Void) {
        guard AppFlavor.current.updatesItself else {
            done(.refused)
            return
        }
        // Pressing the button is asking to be told, so a version this person
        // declined earlier stops being suppressed. Without this, Check Now on
        // a release you already said no to reports nothing and looks broken:
        // the check succeeds, finds the update, and the offer is swallowed by
        // the once-per-version rule that exists to stop the TIMER nagging.
        Prefs.updateDeclinedTag = nil
        onStatus?("Checking for updates…")
        check(force: true, then: done)
    }

    // MARK: staging

    /// Download the release, check it, and unpack it. Nothing is replaced.
    ///
    /// The steps and their reasons are `mac/scripts/update.sh`'s, done here so
    /// somebody with no checkout can take an update: fetch, verify the
    /// published checksum, unpack, ask whether this Mac can launch what
    /// arrived, then clear the download quarantine.
    ///
    /// Callers pile up rather than starting a second run: a background stage
    /// and a confirmed offer are two callers wanting the same bytes, and two
    /// downloads of the same archive would be the ordinary case rather than
    /// the rare one.
    func stage(_ release: ReleaseFeed.Release, then done: ((Staged?) -> Void)? = nil) {
        if let ready = staged, ready.tag == release.tag {
            done?(ready)
            return
        }
        // Answered rather than queued. A completion appended to `waiting` when
        // nothing will ever fire it is a caller that hangs: `install` would
        // leave its status line owned and never arm or report. Nothing can
        // reach this today, because every caller checks `armed` first and the
        // path between is synchronous, but the shape is a trap rather than a
        // bug and it is cheaper to close than to keep true.
        guard !armed else {
            done?(nil)
            return
        }
        if let done { waiting.append(done) }
        guard !staging else { return }
        staging = true
        // A release with no checksum is REFUSED rather than installed
        // unverified. The checksum proves the archive arrived intact and
        // nothing about who built it, since both files come from the same
        // place; refusing without it is what makes the claim in
        // `docs/NETWORK_POSTURE.md` true as written. The release job attaches
        // it in a step that can fail on its own, so this state is reachable.
        guard let checksumURL = release.checksumURL else {
            finish(nil, saying: "That release published no checksum, so it was not installed.")
            return
        }
        say(UpdatePolicy.downloadingNotice(tag: release.tag))
        environment.download(release.appURL) { [weak self] archive in
            Task { @MainActor in
                guard let self else { return }
                guard let archive else {
                    self.finish(nil, saying: "Could not download the update.")
                    return
                }
                self.environment.download(checksumURL) { sums in
                    Task { @MainActor in
                        let expected = (String(data: sums ?? Data(), encoding: .utf8) ?? "")
                            .split(separator: " ").first.map(String.init) ?? ""
                        let actual = SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined()
                        guard !expected.isEmpty, expected == actual else {
                            // Nothing is written. A mismatch is a download that
                            // did not arrive whole, and installing it anyway is
                            // the one failure worth refusing loudly.
                            self.finish(nil, saying: "The update did not arrive intact. Nothing was installed.")
                            return
                        }
                        self.unpack(archive, release: release)
                    }
                }
            }
        }
    }

    /// Throw away a staged update, and its bytes with it.
    ///
    /// Called when the version is declined. A no is an answer about that
    /// version, so holding its unpacked bundle in the temporary directory is
    /// keeping tens of megabytes against a question that has been settled.
    func discardStaged() {
        guard let spent = staged, !armed else { return }
        staged = nil
        try? FileManager.default.removeItem(at: spent.work)
    }

    /// Unpack the verified archive and take what is in it, or nothing.
    ///
    /// `ditto` and `xattr` are run WITHOUT waiting on the thread that called
    /// this. Blocking was tolerable when the whole path only ran after
    /// somebody had pressed Restart and the app was about to quit anyway;
    /// staging now happens on its own while a person may be typing, and an
    /// unpack that holds the main thread is a freeze they did not ask for.
    private func unpack(_ archive: Data, release: ReleaseFeed.Release) {
        let work = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mac-update-\(UUID().uuidString)")
        let zip = work.appendingPathComponent("update.zip")
        let unpacked = work.appendingPathComponent("unpacked")
        do {
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            try archive.write(to: zip)
        } catch {
            NSLog("Birta Writer: could not write the downloaded update: \(error)")
            try? FileManager.default.removeItem(at: work)
            finish(nil, saying: "Could not install the update.")
            return
        }
        run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path]) { [weak self] _ in
            guard let self else { return }
            let name = "\(AppFlavor.current.displayName).app"
            let bundle = unpacked.appendingPathComponent(name)
            // The exit status of `ditto` is not what is asked: what matters is
            // whether the thing being installed is there, and an archive that
            // unpacked cleanly without it is the same refusal as one that did
            // not unpack.
            guard FileManager.default.fileExists(atPath: bundle.path) else {
                self.abandon(work, saying: "The update did not contain \(name).")
                return
            }
            // Ask the downloaded bundle whether this Mac can launch it, before
            // anything replaces the copy that is running. The swap is built so
            // a failure never leaves somebody with no app; an update the
            // machine refuses defeats that from outside, because the move
            // succeeds and macOS only says no afterwards, with the working
            // copy already gone. This is the one place the question can be
            // asked, and the bundle is what answers it, so a release that
            // raises the floor is judged against its own number.
            let verdict = self.environment.compatibility(bundle)
            if let refusal = SystemRequirements.refusal(
                verdict, productName: AppFlavor.current.displayName) {
                self.abandon(work, saying: refusal)
                return
            }
            // Ad-hoc signed, so Gatekeeper cannot attribute it to anyone and
            // would refuse to open it at all. Same trade `update.sh` makes,
            // and its header is where the argument lives.
            self.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", bundle.path]) { _ in
                self.finish(Staged(tag: release.tag, bundle: bundle, work: work), saying: nil)
            }
        }
    }

    /// Give up on a staging run and take its litter with it.
    private func abandon(_ work: URL, saying message: String) {
        try? FileManager.default.removeItem(at: work)
        finish(nil, saying: message)
    }

    /// End the run in flight and answer everybody waiting on it.
    ///
    /// A run REPLACES whatever was staged before it, and takes the superseded
    /// bundle's bytes with it. Without that, a release that lands while an
    /// older one is staged leaves the older one unpacked in the temporary
    /// directory with nothing pointing at it, and a run that fails after one
    /// succeeded does the same. It never runs after the swap is armed, because
    /// nothing can start a run then: the staged bundle is what the script
    /// waiting on this pid is about to move.
    private func finish(_ result: Staged?, saying message: String?) {
        staging = false
        if let previous = staged, previous != result {
            try? FileManager.default.removeItem(at: previous.work)
        }
        staged = result
        lastFailure = result == nil ? message : nil
        if let message { say(message) }
        let waiters = waiting
        waiting = []
        waiters.forEach { $0(result) }
    }

    /// Say something, but only where somebody is watching for it.
    ///
    /// The log is not a lesser channel here, it is the right one: a background
    /// run was not asked for, and its failures are for whoever is reading a
    /// log rather than for a person who did nothing and can do nothing about
    /// it. The same run announces the moment somebody confirms the offer,
    /// because then every line of it is the answer to a button they pressed.
    private func say(_ message: String) {
        guard announcing else {
            NSLog("Birta Writer: \(message)")
            return
        }
        onStatus?(message)
    }

    // MARK: installing

    /// Stage if it is not staged already, then arm the swap.
    ///
    /// `done(true)` means the swap is armed, NOT that it has happened. The
    /// caller has to quit for it to run.
    func install(_ release: ReleaseFeed.Release, then done: @escaping (Bool) -> Void) {
        guard !armed else { return done(false) }
        // Somebody pressed a button, so the status line is theirs to be
        // answered on, including for a background run that was already going
        // when they pressed it. Cleared on every way out of the completion
        // below, which is the only place that can restore it: a run started
        // here may finish long after this method has returned.
        announcing = true
        stage(release) { [weak self] staged in
            guard let self else { return done(false) }
            defer { self.announcing = false }
            guard staged != nil else { return done(false) }
            done(self.armStagedSwap(reopen: .front))
        }
    }

    /// Stage if it is not staged already, then arm a swap that runs after
    /// the next quit and reopens nothing.
    ///
    /// The other answer to the asked-for check. `done(true)` means the swap is
    /// armed and will run whenever this process next goes; nothing quits here,
    /// and nothing will reopen when it does, because the quit that triggers it
    /// is the person's own. Between now and then the app goes on running the
    /// copy it is, and the unattended path finds the swap already armed and
    /// leaves it be.
    func installOnQuit(_ release: ReleaseFeed.Release, then done: @escaping (Bool) -> Void) {
        guard !armed else { return done(false) }
        announcing = true
        stage(release) { [weak self] staged in
            guard let self else { return done(false) }
            defer { self.announcing = false }
            guard staged != nil else { return done(false) }
            done(self.armStagedSwap(reopen: .none))
        }
    }

    /// Hand the staged swap to a process that outlives this one.
    ///
    /// Answers whether the script STARTED, never whether the swap worked: it
    /// waits for this process to go, so by the time it does anything there is
    /// nobody here to be told. What the caller owes a true is a quit.
    ///
    /// `reopen` is how the app comes back afterwards; `Reopen` says why each
    /// answer exists. Only a swap somebody is waiting on announces itself:
    /// the front one because they are about to watch the app restart, the
    /// quit-time one because they need to know nothing happens until then.
    @discardableResult
    func armStagedSwap(reopen: Reopen) -> Bool {
        guard !armed, let staged else { return false }
        guard environment.armSwap(staged, reopen) else {
            say("Could not install the update.")
            return false
        }
        armed = true
        switch reopen {
        case .front: onStatus?(UpdatePolicy.installingNotice(tag: staged.tag))
        case .none:
            onStatus?(UpdatePolicy.installOnQuitNotice(appName: AppFlavor.current.displayName,
                                                       tag: staged.tag))
        case .background: break
        }
        return true
    }

    /// The file that turns an armed quit-time swap into a restart.
    ///
    /// The script is already running by the time anybody changes their mind,
    /// and its reopen argument was fixed when it was armed, so the change
    /// reaches it as a file beside the staged bundle: the script looks for
    /// it the moment this process is gone, before it removes that directory.
    nonisolated static let reopenMark = "reopen-front"

    /// Ask an armed quit-time swap to reopen the app in front after all.
    /// Answers whether the mark was written; false when nothing is armed.
    @discardableResult
    func reopenAfterArmedSwap() -> Bool {
        guard armed, let staged else { return false }
        return FileManager.default.createFile(
            atPath: staged.work.appendingPathComponent(Self.reopenMark).path, contents: nil)
    }

    /// The swap itself: a script that waits for this pid, then replaces the
    /// bundle this process is running out of.
    ///
    /// A static rather than a method because it is the injectable half of
    /// `Environment.armSwap` and reaches none of this type's state.
    private nonisolated static func runSwap(_ staged: Staged, reopen: Reopen) -> Bool {
        // The swap happens AFTER this process is gone: an app cannot
        // reliably replace the bundle it is executing out of. A small
        // script waits for the pid, then does the move `install-app.sh`
        // argues for: stage beside the destination, keep the old one until
        // the new one is in place, and put it back if the move fails.
        // Deleting first leaves a window where a failure means no app at
        // all, which is worse than either version of it.
        //
        // The paths are ARGUMENTS, not interpolated text. A bundle is
        // user-renameable, and `$(…)` still expands inside double quotes
        // in a `sh -c` string.
        let script = """
        while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done
        staged="$1"; dest="$2"; work="$3"; reopen="$4"
        # A change of mind after arming: Restart Now on a swap that was
        # armed for the next quit. Read here, after the wait and before the
        # work directory goes, which is the only window it can be read in.
        [ -f "$work/\(reopenMark)" ] && reopen=front
        # Refuse rather than build a path out of nothing. Every `rm -rf`
        # below is rooted at "$dest", so an empty one turns them into
        # relative deletes in whatever directory this happens to inherit.
        [ -n "$staged" ] && [ -n "$dest" ] && [ -n "$work" ] || exit 1
        [ -d "$staged" ] || exit 1
        # An unattended swap reopens WITHOUT taking the front. The person is
        # somewhere else, or away from the machine entirely, and an app that
        # activates itself while nobody asked is exactly the interruption the
        # unattended path exists not to be. A swap armed to run after the
        # person's own quit reopens nothing: they quit, and the next launch
        # is theirs.
        reopen() {
            [ -d "$dest" ] || return 0
            case "$reopen" in
                background) /usr/bin/open -g "$dest" ;;
                front) /usr/bin/open "$dest" ;;
                *) ;;
            esac
        }
        # Every failure below puts the app back on screen and takes its
        # own litter with it. This runs AFTER the app has quit, so a bare
        # exit leaves the user with no app, no message, and a part-written
        # bundle beside the one that should be there.
        give_up() {
            rm -rf "$dest.incoming" "$work"
            [ -d "$dest" ] || { [ -d "$dest.previous" ] && mv "$dest.previous" "$dest"; }
            rm -rf "$dest.previous"
            reopen
            exit 1
        }
        rm -rf "$dest.incoming" "$dest.previous"
        /usr/bin/ditto "$staged" "$dest.incoming" || give_up
        if [ -d "$dest" ]; then mv "$dest" "$dest.previous" || give_up; fi
        mv "$dest.incoming" "$dest" || give_up
        rm -rf "$dest.previous" "$work"
        reopen
        """
        let swap = Process()
        swap.executableURL = URL(fileURLWithPath: "/bin/sh")
        swap.arguments = ["-c", script, "--",
                          staged.bundle.path,
                          Bundle.main.bundleURL.path,
                          staged.work.path,
                          reopen.argument]
        do {
            try swap.run()
            return true
        } catch {
            NSLog("Birta Writer: could not arm the update swap: \(error)")
            return false
        }
    }

    // MARK: reading the machine

    /// How long since this Mac last saw any input at all.
    ///
    /// Asked of the window server rather than of this app, and that is the
    /// whole point: the app is a menu-bar scratchpad that spends most of its
    /// life hidden, so its own idea of idleness would report nearly every
    /// session as unattended. `combinedSessionState` counts the login
    /// session's own events, so a second person on a fast-user-switched
    /// account is not idleness here.
    ///
    /// Answers zero when the source cannot be read, which reads as "somebody
    /// just touched it" and refuses the swap. Every unreadable answer on this
    /// path is biased the same way: a refusal costs a day, and a wrong go
    /// ahead costs somebody the app they were typing into.
    static func systemIdleSeconds() -> TimeInterval {
        guard let any = anyInputEvent else { return 0 }
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
        return idle.isFinite && idle > 0 ? idle : 0
    }

    /// The event type the read above asks about: `kCGAnyInputEventType`, which
    /// is a key, a click, a scroll or the pointer moving at all.
    ///
    /// Its own constant because the whole unattended path hangs on it
    /// resolving and a nil here would be INVISIBLE. `CGEventType` is a C enum,
    /// `init?(rawValue:)` on one answers nil for a value it does not declare,
    /// and this value is deliberately outside the declared set. Were it to
    /// answer nil, `systemIdleSeconds` would report zero forever, no swap
    /// would ever go in, and every test in the suite would stay green.
    /// `UpdaterTests` asserts it resolves, which is the only thing that can
    /// tell that state from a machine somebody is using.
    static let anyInputEvent = CGEventType(rawValue: ~0)

    /// What a downloaded bundle says about the machines it can run on.
    ///
    /// Both facts come off the bundle: the floor from its `Info.plist`, and
    /// the architectures from its executable's Mach-O header. Only a header's
    /// worth of that binary is read, because the answer is in the first bytes
    /// and the file runs to tens of megabytes.
    ///
    /// A bundle whose executable cannot be found or read reads as
    /// `.unreadable`, which refuses. That is the same bias as the rest of this
    /// path: a refusal costs a version, and an install that will not open
    /// costs the app.
    private nonisolated static func compatibility(of bundle: URL) -> SystemRequirements.Verdict {
        let plist = bundle.appendingPathComponent("Contents/Info.plist")
        var declaredMinimum: String?
        var executable: String?
        if let data = try? Data(contentsOf: plist),
           let root = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] {
            declaredMinimum = root["LSMinimumSystemVersion"] as? String
            executable = root["CFBundleExecutable"] as? String
        }
        var built: Set<SystemRequirements.Architecture> = []
        if let executable {
            let binary = bundle.appendingPathComponent("Contents/MacOS/\(executable)")
            if let handle = try? FileHandle(forReadingFrom: binary) {
                defer { try? handle.close() }
                // Enough for a fat header naming a generous number of slices,
                // and far short of the binary itself.
                let header = (try? handle.read(upToCount: 4096)) ?? Data()
                built = SystemRequirements.architectures(machO: header)
            }
        }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let running = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        return SystemRequirements.verdict(
            declaredMinimum: declaredMinimum,
            builtFor: built,
            running: running,
            machine: machineName())
    }

    /// What this Mac calls its own architecture, as `uname -m` reports it.
    ///
    /// Read as bytes up to the first NUL rather than through `String(cString:)`
    /// over a rebound pointer: `machine` is a fixed 256-byte tuple, and
    /// rebinding it while also asking its size is two accesses to the same
    /// storage in one expression.
    private nonisolated static func machineName() -> String {
        var info = utsname()
        guard uname(&info) == 0 else { return "" }
        let bytes = withUnsafeBytes(of: &info.machine) { raw in
            Array(raw.prefix(while: { $0 != 0 }))
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// Run a tool and call back when it exits, without holding the thread.
    ///
    /// The callback lands on the main actor, which is where every caller here
    /// lives; `terminationHandler` fires on a queue of Foundation's choosing.
    private func run(_ tool: String, _ arguments: [String],
                     then done: @escaping (Bool) -> Void) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.terminationHandler = { finished in
            let ok = finished.terminationStatus == 0
            Task { @MainActor in done(ok) }
        }
        do {
            try process.run()
        } catch {
            NSLog("Birta Writer: could not run \(tool): \(error)")
            done(false)
        }
    }
}
