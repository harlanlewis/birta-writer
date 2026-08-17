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
 * Two properties do the work, and both are about the exit rather than the
 * entry:
 *
 *   1. The snapshot is taken from the surfaces themselves, on entry, and is
 *      what the exit restores. Focus never force-shows a toolbar the user had
 *      already hidden or re-enables a check they had turned off, because it
 *      never asserts a state — it replays the one it read.
 *   2. Nothing it changes is persisted. Proofreading is silenced by masking the
 *      live plugin config, not by writing `birta.proofreading.enabled`, so a
 *      window that dies mid-focus leaves the user's settings as they were. The
 *      toolbar is the exception the user can see: its visibility IS a setting,
 *      so focus drives the same session-level show/hide the expand tab uses and
 *      leaves the persisted value alone.
 *
 * The workbench chrome around the webview (activity bar, side bar, status bar,
 * tabs) is VS Code's own Zen Mode, driven from the extension. We do not
 * reimplement it, and we do not restore it either: Zen Mode is a toggle that
 * owns its own restore, and a second opinion about what the workbench looked
 * like is how the two disagree.
 */

/**
 * The surfaces focus mode collapses. Each pair is a read and a write of the
 * same piece of state, because the snapshot is the read and the exit is the
 * write: a host that can set a surface but not report it cannot be restored.
 */
export interface FocusSurfaces {
    toolbarVisible(): boolean;
    setToolbarVisible(visible: boolean): void;
    tocOpen(): boolean;
    setTocOpen(open: boolean): void;
    /** The master proofreading gate, masked in the live plugin config only. */
    proofreadingOn(): boolean;
    setProofreadingOn(on: boolean): void;
    /** Hand the workbench chrome to VS Code's Zen Mode. */
    toggleWorkbenchZen(): void;
}

/** What the surfaces read on entry, and what the exit replays. */
interface Snapshot {
    toolbarVisible: boolean;
    tocOpen: boolean;
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
            tocOpen: host.tocOpen(),
            proofreadingOn: host.proofreadingOn(),
        };
        if (_snapshot.toolbarVisible) { host.setToolbarVisible(false); }
        if (_snapshot.tocOpen) { host.setTocOpen(false); }
        if (_snapshot.proofreadingOn) { host.setProofreadingOn(false); }
    } else {
        const prior = _snapshot;
        _snapshot = undefined;
        if (prior) {
            host.setToolbarVisible(prior.toolbarVisible);
            host.setTocOpen(prior.tocOpen);
            host.setProofreadingOn(prior.proofreadingOn);
        }
    }

    _focus = on;
    host.toggleWorkbenchZen();
    syncFocusModeBodyClass();
    for (const fn of _listeners) { fn(_focus); }
}

/**
 * Re-apply the mask after the extension pushes a fresh proofread config, and
 * fold the incoming value into the snapshot so the exit restores what the user
 * chose rather than what was live when focus started.
 *
 * Without this a settings change made during focus would both un-silence the
 * document and be discarded on exit — the mask is live state, and an inbound
 * config write is the one thing that can overwrite it.
 */
export function reconcileProofreadingUnderFocus(incomingOn: boolean): void {
    // The snapshot's presence IS the mode: it is taken on entry and dropped on
    // exit, so testing `_focus` as well would be a second copy of one fact.
    if (!_snapshot) { return; }
    _snapshot.proofreadingOn = incomingOn;
    _host?.setProofreadingOn(false);
}

/** Test seam: drop the wired surfaces and the mode state. */
export function resetFocusModeForTests(): void {
    _host = undefined;
    _focus = false;
    _snapshot = undefined;
    _listeners.clear();
}
