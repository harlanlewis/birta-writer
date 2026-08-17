/**
 * Focus mode (MAR-72).
 *
 * The mode's whole risk is in the exit, not the entry: hiding chrome is
 * obvious and reversible, and the way this feature can hurt someone is by
 * restoring a state they never had — showing a toolbar they had hidden, or
 * re-enabling a check they had turned off. So the cases below are mostly about
 * what comes back.
 *
 * The surfaces are a fake rather than the real toolbar and TOC on purpose: the
 * module's contract is that it reads a surface and later writes back what it
 * read, and a fake is what lets every STARTING state be enumerated instead of
 * sampled. The real wiring is exercised by `e2e/focusMode`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    isFocusMode,
    setFocusMode,
    setFocusSurfaces,
    subscribeFocusMode,
    reconcileProofreadingUnderFocus,
    resetFocusModeForTests,
    type FocusSurfaces,
} from "../focusMode";

/** The three surfaces focus collapses, as plain state a test can start anywhere. */
interface FakeState {
    toolbarVisible: boolean;
    tocOpen: boolean;
    proofreadingOn: boolean;
}

function makeSurfaces(initial: FakeState): { state: FakeState; host: FocusSurfaces; zenCalls: () => number } {
    const state = { ...initial };
    let zen = 0;
    const host: FocusSurfaces = {
        toolbarVisible: () => state.toolbarVisible,
        setToolbarVisible: (v) => { state.toolbarVisible = v; },
        tocOpen: () => state.tocOpen,
        setTocOpen: (v) => { state.tocOpen = v; },
        proofreadingOn: () => state.proofreadingOn,
        setProofreadingOn: (v) => { state.proofreadingOn = v; },
        toggleWorkbenchZen: () => { zen++; },
    };
    return { state, host, zenCalls: () => zen };
}

/** Every starting combination of the three surfaces. */
const ALL_STATES: FakeState[] = [false, true].flatMap((toolbarVisible) =>
    [false, true].flatMap((tocOpen) =>
        [false, true].map((proofreadingOn) => ({ toolbarVisible, tocOpen, proofreadingOn })),
    ),
);

describe("focus mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetFocusModeForTests();
        document.body.className = "";
    });

    it("entering focus should leave every surface collapsed, from any starting state", () => {
        // Enumerated rather than sampled, and the count is asserted: a sweep
        // that reached nothing passes.
        expect(ALL_STATES).toHaveLength(8);
        for (const start of ALL_STATES) {
            resetFocusModeForTests();
            const { state, host } = makeSurfaces(start);
            setFocusSurfaces(host);
            setFocusMode(true);
            expect(state, `from ${JSON.stringify(start)}`).toEqual({
                toolbarVisible: false,
                tocOpen: false,
                proofreadingOn: false,
            });
        }
    });

    it("a round trip should restore the exact prior state, from any starting state", () => {
        // The invariant the feature exists to keep. It holds regardless of what
        // the author expected the collapsed state to be, which an
        // expected-output assertion per surface would not.
        expect(ALL_STATES).toHaveLength(8);
        for (const start of ALL_STATES) {
            resetFocusModeForTests();
            const { state, host } = makeSurfaces(start);
            setFocusSurfaces(host);
            setFocusMode(true);
            setFocusMode(false);
            expect(state, `from ${JSON.stringify(start)}`).toEqual(start);
        }
    });

    it("entering twice should not overwrite the snapshot, so the exit still restores", () => {
        // The one way this feature can lose state: a second entry snapshotting
        // the ALREADY-collapsed surfaces would make the exit restore nothing.
        const { state, host } = makeSurfaces({ toolbarVisible: true, tocOpen: true, proofreadingOn: true });
        setFocusSurfaces(host);
        setFocusMode(true);
        setFocusMode(true);
        setFocusMode(false);
        expect(state).toEqual({ toolbarVisible: true, tocOpen: true, proofreadingOn: true });
    });

    it("exiting when not in focus should be a no-op on every surface", () => {
        const { state, host, zenCalls } = makeSurfaces({ toolbarVisible: false, tocOpen: true, proofreadingOn: true });
        setFocusSurfaces(host);
        setFocusMode(false);
        expect(state).toEqual({ toolbarVisible: false, tocOpen: true, proofreadingOn: true });
        expect(isFocusMode()).toBe(false);
        // The workbench half must not fire either: an unbalanced Zen toggle
        // would flip VS Code's chrome with nothing on our side to match it.
        expect(zenCalls()).toBe(0);
    });

    it("a redundant enter should not double-toggle the workbench chrome", () => {
        const { host, zenCalls } = makeSurfaces({ toolbarVisible: true, tocOpen: true, proofreadingOn: true });
        setFocusSurfaces(host);
        setFocusMode(true);
        setFocusMode(true);
        expect(zenCalls()).toBe(1);
        setFocusMode(false);
        expect(zenCalls()).toBe(2);
    });

    it("a surface already collapsed should not be written on entry", () => {
        // Focus replays what it read; it never asserts a state. Writing a
        // surface that was already where focus wants it is how a toggle-based
        // host (the TOC's own `toggle()`) gets flipped the wrong way.
        const writes: string[] = [];
        const state = { toolbarVisible: false, tocOpen: false, proofreadingOn: true };
        setFocusSurfaces({
            toolbarVisible: () => state.toolbarVisible,
            setToolbarVisible: (v) => { writes.push(`toolbar=${v}`); state.toolbarVisible = v; },
            tocOpen: () => state.tocOpen,
            setTocOpen: (v) => { writes.push(`toc=${v}`); state.tocOpen = v; },
            proofreadingOn: () => state.proofreadingOn,
            setProofreadingOn: (v) => { writes.push(`proofread=${v}`); state.proofreadingOn = v; },
            toggleWorkbenchZen: () => {},
        });
        setFocusMode(true);
        expect(writes).toEqual(["proofread=false"]);
    });

    it("an inbound proofread config change during focus should stay silenced and be restored on exit", () => {
        // The mask is live state, so a settings write is the one thing that can
        // un-silence a focused document. The user's new value must survive to
        // the exit, and the document must stay quiet until then.
        const { state, host } = makeSurfaces({ toolbarVisible: true, tocOpen: true, proofreadingOn: false });
        setFocusSurfaces(host);
        setFocusMode(true);
        expect(state.proofreadingOn).toBe(false);

        // The user turns proofreading ON in settings while focused.
        state.proofreadingOn = true;
        reconcileProofreadingUnderFocus(true);
        expect(state.proofreadingOn, "still silenced while focused").toBe(false);

        setFocusMode(false);
        expect(state.proofreadingOn, "the setting the user chose is what returns").toBe(true);
    });

    it("a config change outside focus should not be captured as a snapshot", () => {
        const { state, host } = makeSurfaces({ toolbarVisible: true, tocOpen: true, proofreadingOn: true });
        setFocusSurfaces(host);
        reconcileProofreadingUnderFocus(false);
        expect(state.proofreadingOn).toBe(true);
    });

    it("subscribers should see each transition once, and the body class should mirror it", () => {
        const { host } = makeSurfaces({ toolbarVisible: true, tocOpen: true, proofreadingOn: true });
        setFocusSurfaces(host);
        const seen: boolean[] = [];
        const unsubscribe = subscribeFocusMode((f) => seen.push(f));

        setFocusMode(true);
        expect(document.body.classList.contains("focus-mode")).toBe(true);
        setFocusMode(true);
        setFocusMode(false);
        expect(document.body.classList.contains("focus-mode")).toBe(false);

        expect(seen).toEqual([true, false]);
        unsubscribe();
        setFocusMode(true);
        expect(seen).toEqual([true, false]);
    });

    it("no wired surfaces should leave the mode off rather than half-applied", () => {
        // The command is palette-reachable, and a webview mid-teardown has no
        // surfaces. Entering a mode whose exit cannot restore anything is worse
        // than refusing.
        setFocusMode(true);
        expect(isFocusMode()).toBe(false);
    });
});
