import Foundation

/// WHEN the app asks about a new version, and what the offer says when it does.
///
/// Its own type, and in Core, because every rule here is a decision about
/// somebody's attention rather than about AppKit: how often is too often, what
/// a no means and how long it lasts, and which of two sentences is the true
/// one. All of that is decidable from values, so all of it is testable, and
/// the window code is left with nothing but drawing.
///
/// The shape the whole thing is built around: swapping the app somebody is
/// TYPING INTO is not a thing to do behind them. That is a rule about the
/// person at the keyboard rather than about the swap, so what it forbids is an
/// install that interrupts, not an install that is automatic. The check is
/// automatic, the download is automatic, and the swap goes in on its own only
/// where `isUnattended` below can prove there is nobody to interrupt.
///
/// `mayInstallUnattended` is therefore the one function here that returns "go
/// ahead". It asks `isUnattended` about the person and asks four more things
/// about the app, and every one of them refuses on doubt.
public enum UpdatePolicy {
    /// How long between asking the release host.
    ///
    /// Two hours. The check is periodic at all because this is a menu-bar
    /// scratchpad that stays running for weeks, so a launch-only check stops
    /// happening for exactly the people who use it most. What the number
    /// itself sets is how long a shipped fix sits unnoticed on a machine that
    /// is already running the app, and the only thing pushing back on it is
    /// the cost of asking: one unauthenticated GET carrying nothing of the
    /// user's, so the pacing answers to how soon a fix should arrive rather
    /// than to the request.
    ///
    /// It does not set how often anybody is INTERRUPTED, which is why it can
    /// be short. A check that finds nothing says nothing, a version already
    /// declined is not raised again by `shouldOffer`, and with automatic
    /// updates on it is `pollInterval` and `unattendedIdle` that pace the
    /// swap. So shortening this buys a fix FOUND within a couple of hours of
    /// shipping rather than on the following day, and buys nobody a second
    /// prompt.
    public static let recheckInterval: TimeInterval = 2 * 60 * 60

    /// How often the app asks itself whether anything is due.
    ///
    /// A minute. It paces two questions, neither of which costs a request:
    /// whether a check is due, which is a date comparison, and whether a
    /// downloaded update can go in, which is three booleans and one read of
    /// how long the machine has been untouched. The interval is a minute
    /// rather than an hour because the second question is about a window of
    /// time that opens and closes as somebody walks away and comes back, and
    /// an hourly poll would miss most of them.
    public static let pollInterval: TimeInterval = 60

    /// How long the machine must have gone untouched before a downloaded
    /// update is allowed to go in with nobody asked.
    ///
    /// Five minutes, and the number is doing one job: telling somebody who
    /// paused mid-sentence apart from somebody who has left. It is not a
    /// safety margin, because nothing here is unsafe at one minute; the buffer
    /// is written on the way out and the swap keeps the old copy until the new
    /// one is in place. What it buys is that the app is never replaced out
    /// from under a person who was about to keep typing, which is the
    /// interruption this whole path exists not to be.
    public static let unattendedIdle: TimeInterval = 5 * 60

    /// What the app can see about whether anybody is there.
    ///
    /// Three facts, and every one of them has to say no. They are separate
    /// because they fail separately: a hidden panel with unwritten bytes is
    /// somebody who typed and stepped away mid-thought, and an idle machine
    /// with a window up is somebody reading. Only all three together describe
    /// a moment where replacing the app is something nobody is present for.
    public struct Attendance: Equatable, Sendable {
        /// Any window of this app on screen: a panel, Settings, About. Not
        /// only the panel, because a person reading the About window is as
        /// present as a person typing.
        public var anyWindowVisible: Bool
        /// Any window holding bytes the file does not have yet.
        ///
        /// Quitting flushes, so this is not the difference between keeping
        /// somebody's words and losing them. It is a proxy for a sentence in
        /// progress, and it is the right proxy: unwritten bytes with autosave
        /// off mean the person was typing and has not finished.
        public var hasUnwrittenBytes: Bool
        /// How long since the machine last saw any input at all, from the
        /// window server rather than from this app. The app is a menu-bar
        /// scratchpad that spends most of its life hidden, so its own idea of
        /// idleness would report every session as unattended.
        public var idle: TimeInterval

        public init(anyWindowVisible: Bool, hasUnwrittenBytes: Bool, idle: TimeInterval) {
            self.anyWindowVisible = anyWindowVisible
            self.hasUnwrittenBytes = hasUnwrittenBytes
            self.idle = idle
        }
    }

    /// Whether anybody is at the app, from what it can see of them.
    ///
    /// Written to refuse on anything it cannot read: a negative idle time,
    /// which is what a clock that moved backwards produces, is not an idle
    /// machine. This is presence alone; `mayInstallUnattended` is what decides
    /// whether a swap may go in, and presence is one of the things it asks.
    public static func isUnattended(_ attendance: Attendance) -> Bool {
        guard !attendance.anyWindowVisible, !attendance.hasUnwrittenBytes else { return false }
        return attendance.idle >= unattendedIdle
    }

    /// Everything that has to be true before a staged swap goes in unasked.
    ///
    /// One struct rather than five arguments at a call site, because this is
    /// the decision that QUITS somebody's app and it should be checkable in
    /// one place. A clause missing from a chain of guards is invisible to
    /// every green run; a field missing from here fails to compile, and
    /// `UpdatePolicyTests` flips each one in turn against a state that
    /// otherwise says go ahead, so a clause that stopped being consulted goes
    /// red rather than going unnoticed.
    public struct UnattendedInstall: Equatable, Sendable {
        /// An update fetched, verified and unpacked, waiting for a moment.
        public var isStaged: Bool
        /// The setting. Off means nothing was fetched either, so this is
        /// belt and braces, and it is the belt that somebody can see.
        public var autoUpdate: Bool
        /// This exact version was answered no to. A no is an answer about the
        /// version rather than about the sheet, so it stops this path as
        /// surely as it stops the offer.
        public var wasDeclined: Bool
        /// The offer is on screen. That is somebody being there in the one
        /// form the window checks cannot see: the sheet is attached to a
        /// window this would answer by quitting underneath it.
        public var offerOnScreen: Bool
        /// The app is in the middle of something it was asked to do, such as
        /// an `/ai` run still going. Presence and WORK are different
        /// questions: a hidden panel on an untouched machine with an agent
        /// still thinking is not nobody being there.
        public var workInFlight: Bool
        /// Whether anybody is at the app.
        public var attendance: Attendance

        public init(isStaged: Bool, autoUpdate: Bool, wasDeclined: Bool,
                    offerOnScreen: Bool, workInFlight: Bool, attendance: Attendance) {
            self.isStaged = isStaged
            self.autoUpdate = autoUpdate
            self.wasDeclined = wasDeclined
            self.offerOnScreen = offerOnScreen
            self.workInFlight = workInFlight
            self.attendance = attendance
        }
    }

    /// The one "go ahead" in this type.
    ///
    /// Every arm is an AND and every one of them refuses on doubt, so a new
    /// fact worth waiting on is one more field above rather than a second
    /// predicate somewhere else. What a refusal costs is nothing: the update
    /// stays staged, and the next poll asks again.
    public static func mayInstallUnattended(_ state: UnattendedInstall) -> Bool {
        guard state.isStaged, state.autoUpdate else { return false }
        guard !state.wasDeclined, !state.offerOnScreen, !state.workInFlight else { return false }
        return isUnattended(state.attendance)
    }

    /// How long the buttons in the offer stay dead after it appears.
    ///
    /// The offer can arrive mid-sentence, and both of its buttons do something
    /// somebody typing did not ask for: one restarts the app, the other spends
    /// the only chance to mention this version. Three seconds is long enough
    /// that a keystroke already in flight cannot land on either, and short
    /// enough that somebody who came to read it is not kept waiting.
    public static let armingDelay: TimeInterval = 3

    /// The seconds a countdown counts through, largest first.
    ///
    /// A dead button with nothing to say about it reads as a broken dialog,
    /// and the reading is reasonable: from the outside there is no difference
    /// between a control that is not ready and one that does not work. The
    /// count is what turns the wait into something with a visible end, and
    /// `armingNote` is what says why there is a wait at all.
    ///
    /// Rounded UP, so the last number shown is never a lie in the direction
    /// that costs: a button reading (1) with a fraction of a second still to
    /// go is a moment's wait, and one reading (0) that cannot be clicked is
    /// the broken dialog this exists to avoid. Empty for a delay of nothing,
    /// which is the case where there is no wait to explain.
    public static func countdownSteps(for delay: TimeInterval) -> [Int] {
        guard delay > 0 else { return [] }
        return Array((1...max(1, Int(delay.rounded(.up)))).reversed())
    }

    /// Why the buttons are not live yet.
    ///
    /// Says what is happening and whose side it is on, in one line. It names
    /// the keystroke rather than the delay because the delay is the mechanism
    /// and the keystroke is the reason: somebody mid-sentence needs to know
    /// this was not answered for them, and the count on the button below is
    /// already saying how long.
    ///
    /// Worded as a rule the sheet keeps rather than as a state it is in, so it
    /// is still true once the wait is over. The sheet cannot take a line away
    /// after it is laid out without leaving the gap where the line was.
    public static let armingNote =
        "Its buttons wait a moment before they work, so a keystroke already on its way to "
            + "your note cannot answer for you."

    /// Whether enough time has passed to ask again.
    ///
    /// Never asked before means yes: a first launch should find out.
    public static func shouldCheck(now: Date, lastCheck: Date?) -> Bool {
        guard let lastCheck else { return true }
        // A last-checked stamp in the FUTURE is a clock that moved backwards,
        // not a check that has not come round yet. Treated as due, because the
        // alternative is an app that silently stops checking until the date
        // it recorded comes back around.
        guard lastCheck <= now else { return true }
        return now.timeIntervalSince(lastCheck) >= recheckInterval
    }

    /// Whether a version somebody has already declined should be raised again.
    ///
    /// One offer per version. Without this the re-check interval becomes a
    /// nag: a person who says no is asked again at the next check and at
    /// every one after it, which teaches people to switch updates off rather
    /// than to take one. A DIFFERENT tag is different news and asks.
    public static func shouldOffer(tag: String, declined: String?) -> Bool {
        guard let declined else { return true }
        return tag != declined
    }

    /// What the confirming button says.
    ///
    /// The unwritten-bytes arm is the honest half of a thing that is easy to
    /// get wrong: the app writes on the way out whatever this says, because
    /// quitting flushes, so neither of these is the difference between keeping
    /// and losing the work. Naming the save is worth doing anyway, since it
    /// tells somebody looking at unwritten bytes what is about to happen to
    /// them; implying that the OTHER button is what protects them would not
    /// be.
    public static func confirmTitle(hasUnwrittenBytes: Bool) -> String {
        hasUnwrittenBytes ? "Save and Restart Birta Writer" : "Restart Birta Writer"
    }

    /// The same title with the wait still to go in parentheses after it.
    ///
    /// On the confirming button rather than beside the pair, because that is
    /// the button somebody reaches for and a count anywhere else is a count
    /// they have to go looking for. Zero, and anything under it, is the armed
    /// title unchanged: there is nothing left to say once the button works.
    ///
    /// The count is a SUFFIX, and the widest form is the one the offer opens
    /// with, so the button is laid out for the longest string it will ever
    /// hold and every later title fits the frame it was given.
    public static func confirmTitle(hasUnwrittenBytes: Bool, secondsRemaining: Int) -> String {
        let armed = confirmTitle(hasUnwrittenBytes: hasUnwrittenBytes)
        guard secondsRemaining > 0 else { return armed }
        return "\(armed) (\(secondsRemaining))"
    }

    /// The sentence under the offer.
    ///
    /// `staged` is read at the moment the sheet is BUILT rather than promised
    /// ahead of time, because with automatic updates on the download starts
    /// the instant a check finds something and may finish while the sheet is
    /// on screen. Both arms are true when they are written: one says a
    /// download is still to come, and a restart does wait for it; the other
    /// says the bytes are already here and checked.
    public static func detail(hasUnwrittenBytes: Bool, staged: Bool) -> String {
        let common = staged
            ? "Birta Writer has already downloaded the update and checked it. Restarting replaces "
                + "this copy and reopens this note."
            : "Birta Writer will download the update, check it, replace itself and reopen this note."
        return hasUnwrittenBytes
            ? common + " Your unsaved changes are written to disk first."
            : common
    }

    /// The offer's title.
    public static func title(appName: String, tag: String) -> String {
        "\(appName) \(tag) is available."
    }

    /// What the panel says after a swap that happened on its own.
    ///
    /// It names the version, because "updated" with no version is news
    /// somebody cannot check, and it says IN THE BACKGROUND, because the one
    /// thing worth explaining is that nobody was asked. A person who reads
    /// this and wants it not to happen again has a switch in Settings, and the
    /// sentence is what sends them looking for it.
    ///
    /// Past tense throughout: by the time this is on screen the swap is done,
    /// the app in front of the reader is the new one, and there is nothing
    /// pending and nothing to wait for.
    public static func installedNotice(appName: String, tag: String) -> String {
        "\(appName) updated to \(tag) in the background."
    }

    // MARK: the check somebody asked for

    /// What a check that somebody PRESSED A BUTTON FOR found.
    ///
    /// Distinct from `Updater.CheckResult`, which is what the network said:
    /// this is what the person is told, and the two differ where the answer
    /// depends on facts the network never sees. A refusal is "not this build"
    /// when the build cannot replace itself and "busy" when it can, and a find
    /// carries whether the bytes are already here, because the sheet says so.
    public enum CheckAnswer: Equatable, Sendable {
        /// Something newer, by tag, and whether its bytes have already arrived.
        case found(latest: String, staged: Bool)
        case upToDate
        /// The release host could not be reached or did not answer.
        case unreachable
        /// A check is already running.
        case busy
        /// A build that does not replace itself: the development flavour.
        case notThisBuild
        /// A swap already armed to run after the next quit, by tag. Answered
        /// without a request, because the question is no longer what is
        /// newest but whether to take it now.
        case armed(latest: String)
        /// An install somebody asked for staged nothing, with the updater's
        /// own reason: the download did not arrive, did not match its
        /// checksum, or is a build this Mac cannot run.
        case couldNotInstall(reason: String)
    }

    /// What the answer sheet draws: a title, the sentence under it, and the
    /// buttons in order. The first button is the default, the last dismisses.
    public struct CheckReport: Equatable, Sendable {
        public let title: String
        public let detail: String
        public let buttons: [String]
    }

    public static let installNowTitle = "Install Now"
    public static let installOnQuitTitle = "Install on Next Launch"
    public static let notNowTitle = "Not Now"
    public static let restartNowTitle = "Restart Now"

    /// The sheet for `answer`, worded for the person who asked.
    ///
    /// Every outcome is a sentence, including the ones that are not news,
    /// because a check somebody asked for and heard nothing back from is a
    /// button that looks broken. Unlike the unasked offer, nothing here is
    /// dead on arrival: the person is at the keyboard and pressed for this,
    /// so a keystroke in flight is not the hazard it is there.
    public static func checkReport(_ answer: CheckAnswer, appName: String,
                                   current: String) -> CheckReport {
        switch answer {
        case let .found(latest, staged):
            let arrived = staged
                ? "It has already been downloaded and checked."
                : "Installing it downloads it first and checks it against its published checksum."
            let ways = "\(installNowTitle) writes your note, restarts \(appName) as the new version "
                + "and reopens this note. \(installOnQuitTitle) puts it in after you quit, so the "
                + "next time you open \(appName) it is the new one."
            let gap = newerBy(current: current, latest: latest).map { $0 + " " } ?? ""
            // Its own title rather than the unasked offer's, so the version
            // is spelled the way the About window and the sentence under it
            // spell it, without the tag's `v`.
            return CheckReport(
                title: "\(appName) \(plain(latest)) is available.",
                detail: gap + arrived + " " + ways,
                buttons: [installNowTitle, installOnQuitTitle, notNowTitle])
        case .upToDate:
            return CheckReport(
                title: "\(appName) is up to date.",
                detail: "You have \(plain(current)), which is the newest version.",
                buttons: ["OK"])
        case .unreachable:
            return CheckReport(
                title: "Could not check for updates.",
                detail: "\(appName) could not reach its release page. Check your connection and try again.",
                buttons: ["OK"])
        case .busy:
            return CheckReport(
                title: "Checking for updates…",
                detail: "A check is already running. Try again in a moment.",
                buttons: ["OK"])
        case .notThisBuild:
            return CheckReport(
                title: "A development build does not replace itself.",
                detail: "The copy in Applications checks for updates and installs them; this build is here to be looked at.",
                buttons: ["OK"])
        case let .armed(latest):
            return CheckReport(
                title: "\(plain(latest)) is ready to install.",
                detail: "It has been downloaded and checked, and goes in after you next quit \(appName). "
                    + "\(restartNowTitle) puts it in now: it writes your note, restarts \(appName) as "
                    + "the new version and reopens this note.",
                buttons: [restartNowTitle, "OK"])
        case let .couldNotInstall(reason):
            return CheckReport(
                title: "Could not install the update.",
                detail: reason + " \(appName) is still the version you had.",
                buttons: ["OK"])
        }
    }

    /// How far behind `current` is, as a sentence, or nil when either version
    /// carries no date.
    ///
    /// "Newer" is answered in days rather than in releases, because the days
    /// are in the two versions and the releases between them are not: the
    /// feed answers with the newest release alone, and counting the rest
    /// would be a second request spent on a number nobody acts on. The day is
    /// what tells somebody whether they are a night behind or a month.
    public static func newerBy(current: String, latest: String) -> String? {
        guard let from = ReleaseFeed.releaseDay(of: current),
              let to = ReleaseFeed.releaseDay(of: latest) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let days = calendar.dateComponents([.day], from: from, to: to).day ?? 0
        let sameYear = calendar.component(.year, from: from) == calendar.component(.year, from: to)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = sameYear ? "MMMM d" : "MMMM d, yyyy"
        let gap: String
        switch days {
        case ..<1: gap = "cut the same day"
        case 1: gap = "a day newer"
        default: gap = "\(days) days newer"
        }
        return "You have \(plain(current)), from \(formatter.string(from: from)). "
            + "\(plain(latest)) is from \(formatter.string(from: to)), \(gap)."
    }

    /// What the panel says once a swap is armed to run after the next quit.
    public static func installOnQuitNotice(appName: String, tag: String) -> String {
        "\(plain(tag)) goes in after you next quit \(appName)."
    }

    /// A version as a person reads it: the tag's leading `v` is the
    /// repository's convention, and a bundle version never carries one.
    private static func plain(_ version: String) -> String {
        version.hasPrefix("v") ? String(version.dropFirst()) : version
    }
}
