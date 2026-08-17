/**
 * webview/focusMode.ts
 *
 * Focus mode: one toggle that takes the view down to the content, and an exit
 * that puts back exactly what was there (MAR-72).
 *
 * The mode owns no chrome. Every surface it collapses already has a working
 * toggle of its own, so this composes them rather than reaching into any of
 * them: the host below is supplied by `index.ts`, which is where the toolbar,
 * the table of contents and the editor view are already wired.
 *
 * Three properties do the work, and all of them are about the exit rather
 * than the entry:
 *
 *   1. The snapshot is taken from the surfaces themselves, on entry, and is
 *      what the exit restores. Focus never force-shows a toolbar the user had
 *      already hidden or re-enables a check they had turned off, because it
 *      never asserts a state: it replays the one it read.
 *   2. Nothing it changes is persisted. Proofreading is silenced by masking the
 *      live plugin config, not by writing `birta.proofreading.enabled`, so a
 *      window that dies mid-focus leaves the user's settings as they were. The
 *      toolbar and the TOC likewise take the session-level path their own
 *      expand tab and toggle use, and leave the persisted values alone.
 *   3. A setting that changes WHILE focused is folded into the snapshot rather
 *      than applied over the collapsed view. The extension echoes every
 *      `birta.toolbar.*` and `birta.proofreading.*` write back as a whole
 *      config, and applying that echo verbatim would re-show a hidden toolbar
 *      or un-silence the document mid-focus. `maskToolbarConfigUnderFocus`
 *      and `maskProofreadConfigUnderFocus` are the seam: the inbound value
 *      becomes what the exit restores, and the live surface keeps whatever it
 *      is showing now. That last clause is what lets a user who re-shows the
 *      toolbar by hand during focus keep it: the mask replays the LIVE state,
 *      not the collapsed one, so it never fights a gesture.
 *
 * The workbench chrome around the webview (activity bar, side bar, status bar,
 * tabs) is deliberately not touched. VS Code's Zen Mode is a workbench-level
 * toggle with its own restore and its own keybinding, and driving it from here
 * meant a state this module could not read: a Zen exit by Cmd+K Z or Escape
 * during focus, or a webview reload mid-focus, left the two out of step, and
 * the next toggle inverted the workbench. A user who wants both runs both.
 */

/**
 * The TOC's visibility, as focus mode reads and writes it. `decision` is the
 * user's standing show/hide choice in the panel's own vocabulary ("auto" is
 * the heading-count heuristic), and `open` is what the panel is showing. Both
 * are needed: the decision is what stops a document change from auto-opening
 * the panel mid-focus, and the open flag is what distinguishes a "shown"
 * decision whose panel is closed because the window is narrow (overlay mode)
 * from one whose panel is up.
 */
export interface TocFocusState {
    open: boolean;
    decision: "auto" | "shown" | "hidden";
}

/** The TOC as focus mode leaves it: closed, and deaf to auto-open. */
export const TOC_COLLAPSED: TocFocusState = { open: false, decision: "hidden" };

/**
 * The surfaces focus mode collapses. Each pair is a read and a write of the
 * same piece of state, because the snapshot is the read and the exit is the
 * write: a host that can set a surface but not report it cannot be restored.
 */
export interface FocusSurfaces {
    toolbarVisible(): boolean;
    setToolbarVisible(visible: boolean): void;
    tocState(): TocFocusState;
    setTocState(state: TocFocusState): void;
    /** The master proofreading gate, masked in the live plugin config only. */
    proofreadingOn(): boolean;
    setProofreadingOn(on: boolean): void;
}

/** What the surfaces read on entry, and what the exit replays. */
interface Snapshot {
    toolbarVisible: boolean;
    toc: TocFocusState;
    proofreadingOn: boolean;
}

let _host: FocusSurfaces | undefined;
let _focus = false;
let _snapshot: Snapshot | undefined;

const _listeners = new Set<(focus: boolean) => void>();

/** Wire the surfaces. Called once from the composition root. */
export function setFocusSurfaces(host: FocusSurfaces): void {
    _host = host;
}

/** Whether the view is currently stripped to its content. */
export function isFocusMode(): boolean {
    return _focus;
}

/**
 * Subscribe to mode changes. Returns the unsubscribe. Every mirroring control
 * repaints from this one event rather than holding a private copy, which is
 * "One switch, one announcement" (docs/DESIGN_PRINCIPLES.md).
 */
export function subscribeFocusMode(fn: (focus: boolean) => void): () => void {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
}

/**
 * Mirror the mode onto the body, so CSS can reach chrome that has no
 * subscriber of its own.
 */
export function syncFocusModeBodyClass(): void {
    document.body.classList.toggle("focus-mode", _focus);
}

function sameTocState(a: TocFocusState, b: TocFocusState): boolean {
    return a.open === b.open && a.decision === b.decision;
}

/**
 * Enter or leave focus mode. Idempotent in both directions: entering while
 * already in focus would overwrite the snapshot with the collapsed state and
 * make the exit restore nothing, which is the one way this feature can lose
 * something the user had.
 */
export function setFocusMode(on: boolean): void {
    if (on === _focus) { return; }
    const host = _host;
    if (!host) { return; }

    if (on) {
        _snapshot = {
            toolbarVisible: host.toolbarVisible(),
            toc: host.tocState(),
            proofreadingOn: host.proofreadingOn(),
        };
        if (_snapshot.toolbarVisible) { host.setToolbarVisible(false); }
        if (!sameTocState(_snapshot.toc, TOC_COLLAPSED)) { host.setTocState(TOC_COLLAPSED); }
        if (_snapshot.proofreadingOn) { host.setProofreadingOn(false); }
    } else {
        const prior = _snapshot;
        _snapshot = undefined;
        if (prior) {
            host.setToolbarVisible(prior.toolbarVisible);
            host.setTocState(prior.toc);
            host.setProofreadingOn(prior.proofreadingOn);
        }
    }

    _focus = on;
    syncFocusModeBodyClass();
    for (const fn of _listeners) { fn(_focus); }
}

/**
 * Fold an inbound proofread config into a focused session: the incoming
 * master gate becomes what the exit restores, and the config that reaches the
 * live plugin keeps the gate where the surface has it now. Outside focus the
 * config passes through untouched.
 *
 * Without this a settings change made during focus would both un-silence the
 * document and be discarded on exit: the mask is live state, and an inbound
 * config write is the one thing that can overwrite it.
 */
export function maskProofreadConfigUnderFocus<T extends { proofreadingEnabled: boolean }>(config: T): T {
    // The snapshot's presence IS the mode: it is taken on entry and dropped on
    // exit, so testing `_focus` as well would be a second copy of one fact.
    if (!_snapshot || !_host) { return config; }
    _snapshot.proofreadingOn = config.proofreadingEnabled;
    return { ...config, proofreadingEnabled: _host.proofreadingOn() };
}

/**
 * The toolbar's counterpart of the mask above. `visible` is the persisted
 * `birta.toolbar.visible`, echoed back on EVERY toolbar setting write (a
 * layout drag, a hidden item), not only on a visibility change, so an
 * unmasked echo re-shows the toolbar the moment anything about it is edited.
 */
export function maskToolbarConfigUnderFocus<T extends { visible?: boolean }>(config: T): T {
    if (!_snapshot || !_host) { return config; }
    _snapshot.toolbarVisible = config.visible !== false;
    return { ...config, visible: _host.toolbarVisible() };
}

/**
 * The TOC's counterpart. `birta.tocVisibility` is echoed to every open editor
 * when any one of them toggles its panel, and applying that echo would open a
 * focused editor's TOC over the content. Absorbed rather than masked, because
 * the panel's write API is the persisted vocabulary itself and there is no
 * live value to hand back that would not either reopen the panel or close one
 * the user re-opened by hand mid-focus. Returns true when the caller must not
 * apply the value.
 */
export function absorbTocVisibilityUnderFocus(visibility: TocFocusState["decision"]): boolean {
    if (!_snapshot) { return false; }
    // "auto" recomputes its open state from the outline on restore, so the
    // flag recorded beside it is not read; the explicit decisions open or
    // close the panel outright.
    _snapshot.toc = { open: visibility === "shown", decision: visibility };
    return true;
}

/** Test seam: drop the wired surfaces and the mode state. */
export function resetFocusModeForTests(): void {
    _host = undefined;
    _focus = false;
    _snapshot = undefined;
    _listeners.clear();
}
