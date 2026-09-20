import Foundation

/// What a launch opens on, as one decision with three answers.
///
/// A first run has ONE job and it is not configuration. This is a
/// hotkey-summoned scratchpad, so exactly one behaviour has to be learned or
/// the product is dead: summon and dismiss. Everything else is a setting with
/// a default worth keeping and a row in Settings to change it on.
///
/// So `invitation` is what a real first run gets. Nothing opens; the menu bar
/// says where the app lives and which keys to press, and pressing them is the
/// only route to the panel, which is what makes the gesture teach itself. The
/// panel then opens already holding the tour (`FirstRunNote`), so the first
/// thing anybody reads is a rendered document rather than a form.
///
/// `screen` is the questions (`SettingsForm.welcome`, drawn by `WelcomeView`),
/// and no ordinary launch reaches it any more. It stays because two of its
/// rows are worth looking at on a build made for looking at things:
/// `AppFlavor.showsWelcomeScreen` puts Show Welcome in a development build's
/// Settings, and `forced` is how a checking run builds it without a person.
/// Retiring the rows is a separate decision from retiring the launch that
/// showed them, and this type only settles the second.
///
/// The refusals on the invitation are what they always were, and each is
/// doing different work.
///
/// `isUserStore` is the throwaway defaults domain `mac/scripts/measure.sh`
/// runs against, where every launch looks like a first one. Without it each
/// run would seed a tour and put a popover in the menu bar of whoever is
/// driving the machine.
///
/// `documentBound` is asked of the BINDING rather than of how this launch
/// started, and the difference is the whole of what it protects. A launch is
/// one moment; the binding survives quitting, so a gate on the launch defers
/// once and the next ordinary launch offers a tour over the same document.
/// `FirstRunNote.shouldWrite` refuses the `document` slot, so that launch
/// would spend the one chance to offer the tour on a note it is not allowed
/// to write, and in a release build nothing gives it back.
///
/// Deferring costs nothing but the timing: the invitation is offered again on
/// the first launch that is back on the app's own note, because
/// `hasSeenWelcome` is spent when the panel comes up rather than when the
/// launch happens.
///
/// What the refusal does NOT undo is `Prefs.isFirstLaunch`, which is the
/// absence of every stored key: binding the document stores one, so a person
/// whose first ever launch came from Open With never meets
/// `Prefs.applyOnboardingDefaults` in its acting arm and is not registered as
/// a login item. That is the conservative outcome and it should stay: a login
/// item is a registration with the system, and making one on the strength of
/// a launch argument reaches into a Mac over a launch that was about a file.
public enum FirstRun {
    /// The three things a launch can open on.
    public enum Opening: String, CaseIterable, Sendable {
        /// An install that has run before, on an ordinary launch. The panel
        /// stays where the last quit left it.
        case nothing
        /// The menu bar's popover over a panel that stays down until the
        /// chord is pressed (`FirstRunInvitation`), and the tour written into
        /// the note behind it.
        case invitation
        /// The questions. Only `forced` and a development build's Show
        /// Welcome reach this.
        case screen
    }

    /// `forced` is `BIRTA_MAC_OPEN_WELCOME=1`, which is how the screen is
    /// proven to construct without a person: the ordinary gate deliberately
    /// never fires under a throwaway defaults domain, so nothing else would
    /// ever build it. It outranks every refusal below for that reason, this
    /// one included, or a checking run could not reach the screen by asking.
    public static func opening(forced: Bool,
                               isUserStore: Bool,
                               hasSeenWelcome: Bool,
                               documentBound: Bool) -> Opening {
        if forced { return .screen }
        guard isUserStore, !hasSeenWelcome, !documentBound else { return .nothing }
        return .invitation
    }
}
