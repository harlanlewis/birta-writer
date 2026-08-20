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
    }

    /// Something newer exists, with the tag to name it.
    var onUpdateAvailable: ((String) -> Void)?
    /// Progress and outcome, for the status line.
    var onStatus: ((String) -> Void)?

    private(set) var available: ReleaseFeed.Release?
    private var checking = false

    private let repo = ProcessInfo.processInfo.environment["BIRTA_JOT_REPO"] ?? "harlanlewis/birta-writer"

    /// This build's version, as `Info.plist` carries it. A checkout build says
    /// `0.0.0`, which every real release is newer than; the flavour guard is
    /// what stops that mattering.
    private var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    /// Whether this process may check at all.
    ///
    /// `isUserStore` is the same predicate the panel's frame autosave uses,
    /// and it is here for a sharper reason: `measure.sh` drives the RELEASE
    /// bundle under a throwaway domain, where `autoUpdate` defaults on and the
    /// checkout's `0.0.0` is older than every release. Without this, every
    /// scripted run would reach the network and then raise a modal into an app
    /// being driven by synthesized keystrokes, which blocks the run loop and
    /// fails every check in a way that looks like an editor bug.
    private var mayCheck: Bool {
        AppFlavor.current.updatesItself && Prefs.isUserStore
    }

    /// Ask, and say what came back.
    ///
    /// `force` is the user pressing a button, which happens whatever the
    /// automatic setting says. It does NOT write the setting: doing that and
    /// putting it back a statement later leaves auto-update permanently on for
    /// somebody who turned it off, if anything goes wrong in between.
    func check(force: Bool = false, then done: ((CheckResult) -> Void)? = nil) {
        guard mayCheck, force || Prefs.autoUpdate, !checking else {
            done?(.failed)
            return
        }
        guard let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else {
            done?(.failed)
            return
        }
        checking = true
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            Task { @MainActor in
                guard let self else { return }
                self.checking = false
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
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
        }.resume()
    }

    /// The launch check. Silent unless there is something: a check that failed
    /// because the machine is offline is not news, and an app that says so on
    /// every launch is an app people turn off.
    func checkInBackground() {
        check()
    }

    /// The button in Settings, which says what happened either way.
    func checkNow() {
        guard AppFlavor.current.updatesItself else {
            onStatus?("A development build does not replace itself.")
            return
        }
        onStatus?("Checking for updates…")
        check(force: true) { [weak self] result in
            switch result {
            case .found: break                      // the offer says it
            case .upToDate: self?.onStatus?("\(AppFlavor.current.displayName) is up to date.")
            case .failed: self?.onStatus?("Could not check for updates.")
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
        onStatus?("Downloading \(release.tag)…")
        // A release with no checksum is REFUSED rather than installed
        // unverified. The checksum proves the archive arrived intact and
        // nothing about who built it, since both files come from the same
        // place; refusing without it is what makes the claim in
        // `docs/NETWORK_POSTURE.md` true as written. The release job attaches
        // it in a step that can fail on its own, so this state is reachable.
        guard let checksumURL = release.checksumURL else {
            onStatus?("That release published no checksum, so it was not installed.")
            return done(false)
        }
        let session = URLSession.shared
        session.dataTask(with: release.appURL) { [weak self] data, _, error in
            Task { @MainActor in
                guard let self else { return }
                guard let data, error == nil else {
                    self.onStatus?("Could not download the update.")
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
            rm -rf "$dest.incoming" "$dest.previous"
            /usr/bin/ditto "$staged" "$dest.incoming" || exit 1
            if [ -d "$dest" ]; then mv "$dest" "$dest.previous" || exit 1; fi
            if ! mv "$dest.incoming" "$dest"; then
                [ -d "$dest.previous" ] && mv "$dest.previous" "$dest"
                exit 1
            fi
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
            NSLog("Birta Writer Jot: update failed: \(error)")
            onStatus?("Could not install the update.")
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
