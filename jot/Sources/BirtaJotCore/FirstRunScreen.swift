import Foundation

/// Whether the first-run screen goes up on this launch.
///
/// The screen introduces the app's OWN note and the folder it keeps notes in,
/// and it asks a person to answer for both. That is the right thing to put in
/// front of somebody who launched the app, and the wrong thing to put in front
/// of somebody whose panel is bound to a file they pointed it at.
///
/// The refusal is on whether a document is BOUND, not on how this launch
/// started, and the difference is the whole of what it protects. A launch is
/// one moment; the binding survives quitting, so a gate on the launch defers
/// the screen exactly once and the next ordinary launch shows it over the same
/// document. `Coordinator.finishWelcome` spends `hasSeenWelcome` before it
/// seeds, and `FirstRunNote.shouldWrite` refuses the `document` slot, so that
/// launch would spend the one chance to offer the tour on a note it is not
/// allowed to write. `AppFlavor.showsWelcomeScreen` keeps Show Welcome out of
/// a release build, so there is no route back.
///
/// Deferring costs the questions and keeps the note, which is the right way
/// round: General holds every row this screen asks, in the same order and the
/// same words, so a person who never sees the screen can still answer all of
/// it, and nothing but this screen ever writes the tour.
///
/// What the refusal does NOT undo is `Prefs.isFirstLaunch`, which is the
/// absence of every stored key: binding the document stores one, so a person
/// whose first ever launch came from Open With never meets
/// `Prefs.applyOnboardingDefaults` in its acting arm and is not registered as a
/// login item. That is the conservative outcome and it should stay: the login
/// item is a registration with the system, the screen that offers it draws the
/// live state so the switch reads off and tells the truth, and registering one
/// for somebody who was never shown the offer is reaching into their Mac on
/// the strength of a launch argument.
public enum FirstRunScreen {
    /// `forced` is `BIRTA_JOT_OPEN_WELCOME=1`, which is how the screen is
    /// proven to construct without a person: the ordinary gate deliberately
    /// never fires under a throwaway defaults domain, so nothing else would
    /// ever build it. It outranks every refusal below for that reason, this
    /// one included, or a checking run could not reach the screen by asking.
    public static func shouldShow(forced: Bool,
                                  isUserStore: Bool,
                                  hasSeenWelcome: Bool,
                                  documentBound: Bool) -> Bool {
        if forced { return true }
        guard isUserStore, !hasSeenWelcome else { return false }
        return !documentBound
    }
}
