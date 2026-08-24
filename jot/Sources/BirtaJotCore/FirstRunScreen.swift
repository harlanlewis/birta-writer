import Foundation

/// Whether the first-run screen goes up on this launch.
///
/// The screen introduces the app's OWN note and the folder it keeps notes in,
/// and it asks a person to answer for both. That is the right thing to put in
/// front of somebody who launched the app, and the wrong thing to put in front
/// of somebody who asked it to open a particular file: they made a request,
/// and a tour is not an answer to it.
///
/// Refusing here consumes nothing. `hasSeenWelcome` is set by the screen's own
/// Continue rather than by this decision, so a launch that skips it is offered
/// the tour by the next launch that did not come from a file. There is no
/// state to reset and no second gate to keep in step.
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
                                  launchedWithDocument: Bool) -> Bool {
        if forced { return true }
        guard isUserStore, !hasSeenWelcome else { return false }
        return !launchedWithDocument
    }
}
