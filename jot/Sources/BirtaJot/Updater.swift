import AppKit
import BirtaJotCore
import CryptoKit

/// Keeps the release build up to date with the newest one published.
///
/// Jot is on no app store and cannot be, so without this the only way to get a
/// fix is to notice a release happened and run a shell script, which is a
/// thing nobody does.
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
/// It never installs on its own. The check is automatic and the replacement is
/// a click, because swapping the app somebody is typing into is not something
/// to do behind them.
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

    /// Something newer exists, with the tag to name it.
    var onUpdateAvailable: ((String) -> Void)?
    /// Progress and outcome, for the status line.
    var onStatus: ((String) -> Void)?

    private(set) var available: ReleaseFeed.Release?
    private var checking = false
    /// A swap is being fetched or is already armed.
    ///
    /// The app stays responsive through a download, so without this a second
    /// trip through Settings arms a second script, and the two wake on the
    /// same pid and race each other over one destination. That is the hazard
    /// `install-app.sh` flavours its staging paths to avoid, one layer up.
    private var installing = false

    private let repo = ProcessInfo.processInfo.environment["BIRTA_JOT_REPO"] ?? "harlanlewis/birta-writer"

    /// Everything `check` needs that is not this type's own state.
    ///
    /// A seam, and it exists because the two gates below both read TRUE in an
    /// xctest process: `AppFlavor.forBundle` answers `.release` for any bundle
    /// id that is not the development one, and nothing sets a throwaway
    /// defaults suite. So calling `check(force:)` from a test reached
    /// api.github.com for real, which meant every `CheckResult` other than
    /// `.refused` was untestable and the status strings behind them were
    /// unasserted. Injecting the gate and the transport makes the whole
    /// outcome table reachable without a network.
    struct Environment {
        var mayCheck: () -> Bool = { AppFlavor.current.updatesItself && Prefs.isUserStore }
        var autoUpdate: () -> Bool = { Prefs.autoUpdate }
        var now: () -> Date = Date.init
        var lastCheck: () -> Date? = { Prefs.lastUpdateCheck }
        var recordCheck: (Date) -> Void = { Prefs.lastUpdateCheck = $0 }
        var currentVersion: () -> String = {
            Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
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
    /// scripted run would reach the network and then raise a modal into an app
    /// being driven by synthesized keystrokes, which blocks the run loop and
    /// fails every check in a way that looks like an editor bug.
    private var mayCheck: Bool { environment.mayCheck() }

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
        // how often Jot reaches for the network, and it reached.
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
                self.onUpdateAvailable?(release.tag)
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
    /// and this should ask only when it is due. Jot stays running for weeks,
    /// so without this the launch check is the only one that ever happens and
    /// somebody who never quits is somebody who never gets a fix.
    func checkIfDue() {
        guard UpdatePolicy.shouldCheck(now: environment.now(),
                                       lastCheck: environment.lastCheck()) else { return }
        check()
    }

    /// The button in Settings, which says what happened either way.
    func checkNow() {
        guard AppFlavor.current.updatesItself else {
            onStatus?("A development build does not replace itself.")
            return
        }
        // Pressing the button is asking to be told, so a version this person
        // declined earlier stops being suppressed. Without this, Check Now on
        // a release you already said no to reports nothing and looks broken:
        // the check succeeds, finds the update, and the offer is swallowed by
        // the once-per-version rule that exists to stop the TIMER nagging.
        Prefs.updateDeclinedTag = nil
        onStatus?("Checking for updates…")
        check(force: true) { [weak self] result in
            switch result {
            case .found: break                      // the offer says it
            case .upToDate: self?.onStatus?("\(AppFlavor.current.displayName) is up to date.")
            case .failed: self?.onStatus?("Could not check for updates.")
            // A refusal is the flavour gate or a check already running. The
            // button must still say something: the status line above it reads
            // "Checking for updates…" until it is replaced, so falling through
            // silently leaves the row claiming a check that is not happening.
            case .refused: self?.onStatus?("Nothing to check right now.")
            }
        }
    }

    /// Download the release, check it, and stage the swap.
    ///
    /// The steps and their reasons are `jot/scripts/update-jot.sh`'s, done here
    /// so somebody with no checkout can take an update: fetch, verify the
    /// published checksum, unpack, clear the download quarantine, then hand a
    /// swap to a script that runs after this process is gone.
    ///
    /// `done(true)` means the swap is armed, NOT that it has happened. The
    /// caller has to quit for it to run.
    func install(_ release: ReleaseFeed.Release, then done: @escaping (Bool) -> Void) {
        guard !installing else { return done(false) }
        installing = true
        onStatus?("Downloading \(release.tag)…")
        // A release with no checksum is REFUSED rather than installed
        // unverified. The checksum proves the archive arrived intact and
        // nothing about who built it, since both files come from the same
        // place; refusing without it is what makes the claim in
        // `docs/NETWORK_POSTURE.md` true as written. The release job attaches
        // it in a step that can fail on its own, so this state is reachable.
        guard let checksumURL = release.checksumURL else {
            onStatus?("That release published no checksum, so it was not installed.")
            installing = false
            return done(false)
        }
        let session = URLSession.shared
        session.dataTask(with: release.appURL) { [weak self] data, _, error in
            Task { @MainActor in
                guard let self else { return }
                guard let data, error == nil else {
                    self.onStatus?("Could not download the update.")
                    self.installing = false
                    return done(false)
                }
                session.dataTask(with: checksumURL) { sumData, _, _ in
                    Task { @MainActor in
                        let expected = (String(data: sumData ?? Data(), encoding: .utf8) ?? "")
                            .split(separator: " ").first.map(String.init) ?? ""
                        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                        guard !expected.isEmpty, expected == actual else {
                            // Nothing is written. A mismatch is a download that
                            // did not arrive whole, and installing it anyway is
                            // the one failure worth refusing loudly.
                            self.onStatus?("The update did not arrive intact. Nothing was installed.")
                            self.installing = false
                            return done(false)
                        }
                        self.stageSwap(archive: data, release: release, then: done)
                    }
                }.resume()
            }
        }.resume()
    }

    private func stageSwap(archive: Data, release: ReleaseFeed.Release, then done: @escaping (Bool) -> Void) {
        do {
            let work = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("jot-update-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            let zip = work.appendingPathComponent("jot.zip")
            try archive.write(to: zip)
            let unpacked = work.appendingPathComponent("unpacked")
            try shell("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path])

            let name = "\(AppFlavor.current.displayName).app"
            let staged = unpacked.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: staged.path) else {
                onStatus?("The update did not contain \(name).")
                installing = false
                return done(false)
            }
            // Ad-hoc signed, so Gatekeeper cannot attribute it to anyone and
            // would refuse to open it at all. Same trade `update-jot.sh` makes,
            // and its header is where the argument lives.
            _ = try? shell("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged.path])

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
            staged="$1"; dest="$2"; work="$3"
            # Refuse rather than build a path out of nothing. Every `rm -rf`
            # below is rooted at "$dest", so an empty one turns them into
            # relative deletes in whatever directory this happens to inherit.
            [ -n "$staged" ] && [ -n "$dest" ] && [ -n "$work" ] || exit 1
            [ -d "$staged" ] || exit 1
            # Every failure below puts the app back on screen and takes its
            # own litter with it. This runs AFTER the app has quit, so a bare
            # exit leaves the user with no Jot, no message, and a part-written
            # bundle beside the one that should be there.
            give_up() {
                rm -rf "$dest.incoming" "$work"
                [ -d "$dest" ] || { [ -d "$dest.previous" ] && mv "$dest.previous" "$dest"; }
                rm -rf "$dest.previous"
                [ -d "$dest" ] && /usr/bin/open "$dest"
                exit 1
            }
            rm -rf "$dest.incoming" "$dest.previous"
            /usr/bin/ditto "$staged" "$dest.incoming" || give_up
            if [ -d "$dest" ]; then mv "$dest" "$dest.previous" || give_up; fi
            mv "$dest.incoming" "$dest" || give_up
            rm -rf "$dest.previous" "$work"
            /usr/bin/open "$dest"
            """
            let swap = Process()
            swap.executableURL = URL(fileURLWithPath: "/bin/sh")
            swap.arguments = ["-c", script, "--", staged.path, Bundle.main.bundleURL.path, work.path]
            try swap.run()
            onStatus?("Installing \(release.tag)…")
            done(true)
        } catch {
            NSLog("Birta Writer: update failed: \(error)")
            onStatus?("Could not install the update.")
            installing = false
            done(false)
        }
    }

    @discardableResult
    private func shell(_ tool: String, _ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
}
