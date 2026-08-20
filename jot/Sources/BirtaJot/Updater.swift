import AppKit
import BirtaJotCore
import CryptoKit

/// Keeps the release build up to date with the newest one published.
///
/// Jot is not on an app store and cannot be, so without this the only way to
/// get a fix is to notice a release happened and run a shell script. That is a
/// thing nobody does, which means a fix nobody gets.
///
/// What it sends: a GET to the project's own release host asking what the
/// newest release is, and then the archive itself. Nothing about the document,
/// nothing about the machine, and no identifier this app invents. It is a
/// rung of its own in `docs/NETWORK_POSTURE.md`, separate from the editor's
/// `networkEnabled` switch, because the two are different consents: one is
/// about what happens to what you type, and this is about the app replacing
/// itself. Riding the editor's switch would mean a person who wants no link
/// previews also gets no fixes.
///
/// The RELEASE build only (`AppFlavor.updatesItself`). A development build
/// that replaced itself with the newest release would delete the change
/// somebody installed it to look at.
///
/// It never installs on its own. The check is automatic and the replacement is
/// a click, because swapping the app somebody is typing into is not something
/// to do behind them.
@MainActor
final class Updater {
    /// Something newer exists, with the tag to name it.
    var onUpdateAvailable: ((String) -> Void)?
    /// Progress and outcome, for the status line.
    var onStatus: ((String) -> Void)?

    private(set) var available: ReleaseFeed.Release?
    private var checking = false

    private let repo = ProcessInfo.processInfo.environment["BIRTA_JOT_REPO"] ?? "harlanlewis/birta-writer"

    /// This build's version, as `Info.plist` carries it. A checkout build says
    /// `0.0.0`, which every real release is newer than; `AppFlavor` is what
    /// stops that mattering.
    private var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    /// Ask, if this build is allowed to and the user has left it on.
    ///
    /// Silent about everything except finding something: a check that failed
    /// because the machine is offline is not news, and an app that says so on
    /// every launch is an app people turn off.
    func checkInBackground() {
        guard AppFlavor.current.updatesItself, Prefs.autoUpdate, !checking else { return }
        checking = true
        let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest")
        guard let url else { checking = false; return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            Task { @MainActor in
                defer { self?.checking = false }
                guard let self, let data, let release = ReleaseFeed.parse(data) else { return }
                guard ReleaseFeed.isNewer(release.tag, than: self.currentVersion) else { return }
                self.available = release
                self.onUpdateAvailable?(release.tag)
            }
        }.resume()
    }

    /// Ask now and say what happened either way, for the button in Settings.
    func checkNow() {
        guard AppFlavor.current.updatesItself else {
            onStatus?("A development build does not update itself.")
            return
        }
        onStatus?("Checking for updates…")
        let previous = Prefs.autoUpdate
        // An explicit check is the user asking, so it happens whatever the
        // automatic setting says.
        Prefs.autoUpdate = true
        checking = false
        checkInBackground()
        Prefs.autoUpdate = previous
        // `checkInBackground` is silent when there is nothing; say so here,
        // after a moment, so the button does not look broken.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self, self.available == nil else { return }
            self.onStatus?("Birta Writer Jot is up to date.")
        }
    }

    /// Download the release, check it, and put it in place.
    ///
    /// The steps and their reasons are `jot/scripts/update-jot.sh`'s, done here
    /// so a person who has no checkout can take an update: fetch, verify the
    /// published checksum, unpack, clear the download quarantine, swap, and
    /// relaunch.
    ///
    /// The checksum proves the archive arrived intact and NOT who built it:
    /// both files come from the same place. Jot is ad-hoc signed, so there is
    /// no signature to check, which is exactly why it is not offered to anybody
    /// who does not already own the source.
    func install(_ release: ReleaseFeed.Release, then done: @escaping (Bool) -> Void) {
        onStatus?("Downloading \(release.tag)…")
        let session = URLSession.shared
        session.dataTask(with: release.appURL) { [weak self] data, _, error in
            Task { @MainActor in
                guard let self else { return }
                guard let data, error == nil else {
                    self.onStatus?("Could not download the update.")
                    return done(false)
                }
                guard let checksumURL = release.checksumURL else {
                    self.finish(archive: data, release: release, then: done)
                    return
                }
                session.dataTask(with: checksumURL) { sumData, _, _ in
                    Task { @MainActor in
                        let expected = (String(data: sumData ?? Data(), encoding: .utf8) ?? "")
                            .split(separator: " ").first.map(String.init) ?? ""
                        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                        guard !expected.isEmpty, expected == actual else {
                            // Nothing is written. A mismatch is a download that
                            // did not arrive whole, and installing it anyway
                            // would be the one failure worth refusing loudly.
                            self.onStatus?("The update did not arrive intact. Nothing was installed.")
                            return done(false)
                        }
                        self.finish(archive: data, release: release, then: done)
                    }
                }.resume()
            }
        }.resume()
    }

    private func finish(archive: Data, release: ReleaseFeed.Release, then done: @escaping (Bool) -> Void) {
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
            // would refuse to open it at all. Same trade the update script
            // makes, and its header is where the argument lives.
            try? shell("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged.path])

            let destination = Bundle.main.bundleURL
            // The swap happens AFTER this process is gone: an app cannot
            // reliably replace the bundle it is executing out of. A small
            // shell waits for the pid, moves the new bundle in, and opens it.
            let script = """
            while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done
            /usr/bin/ditto "\(staged.path)" "\(destination.path).new" || exit 1
            /bin/rm -rf "\(destination.path)"
            /bin/mv "\(destination.path).new" "\(destination.path)" || exit 1
            /bin/rm -rf "\(work.path)"
            /usr/bin/open "\(destination.path)"
            """
            let swap = Process()
            swap.executableURL = URL(fileURLWithPath: "/bin/sh")
            swap.arguments = ["-c", script]
            try swap.run()
            onStatus?("Installing \(release.tag). Birta Writer Jot will restart.")
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
