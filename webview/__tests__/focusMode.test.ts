/**
 * Focus mode (MAR-72).
 *
 * The mode's whole risk is in the exit, not the entry: hiding chrome is
 * obvious and reversible, and the way this feature can hurt someone is by
 * restoring a state they never had, showing a toolbar they had hidden, or
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
    maskProofreadConfigUnderFocus,
    maskToolbarConfigUnderFocus,
    absorbTocVisibilityUnderFocus,
    resetFocusModeForTests,
    TOC_COLLAPSED,
    type FocusSurfaces,
    type TocFocusState,
} from "../focusMode";

/** The three surfaces focus collapses, as plain state a test can start anywhere. */
interface FakeState {
    toolbarVisible: boolean;
    toc: TocFocusState;
    proofreadingOn: boolean;
}

function makeSurfaces(initial: FakeState): { state: FakeState; host: FocusSurfaces } {
    const state = { ...initial, toc: { ...initial.toc } };
    const host: FocusSurfaces = {
        toolbarVisible: () => state.toolbarVisible,
        setToolbarVisible: (v) => { state.toolbarVisible = v; },
        tocState: () => ({ ...state.toc }),
        setTocState: (v) => { state.toc = { ...v }; },
        proofreadingOn: () => state.proofreadingOn,
        setProofreadingOn: (v) => { state.proofreadingOn = v; },
    };
    return { state, host };
}

/** Every TOC state the panel can report: three decisions, open or closed. */
const TOC_STATES: TocFocusState[] = (["auto", "shown", "hidden"] as const).flatMap((decision) =>
    [false, true].map((open) => ({ open, decision })),
);

/** Every starting combination of the three surfaces. */
const ALL_STATES: FakeState[] = [false, true].flatMap((toolbarVisible) =>
    TOC_STATES.flatMap((toc) =>
        [false, true].map((proofreadingOn) => ({ toolbarVisible, toc, proofreadingOn })),
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
        expect(ALL_STATES).toHaveLength(24);
        for (const start of ALL_STATES) {
            resetFocusModeForTests();
            const { state, host } = makeSurfaces(start);
            setFocusSurfaces(host);
            setFocusMode(true);
            expect(state, `from ${JSON.stringify(start)}`).toEqual({
                toolbarVisible: false,
                toc: TOC_COLLAPSED,
                proofreadingOn: false,
            });
        }
    });

    it("a round trip should restore the exact prior state, from any starting state", () => {
        // The invariant the feature exists to keep. It holds regardless of what
        // the author expected the collapsed state to be, which an
        // expected-output assertion per surface would not.
        expect(ALL_STATES).toHaveLength(24);
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
        const start: FakeState = { toolbarVisible: true, toc: { open: true, decision: "shown" }, proofreadingOn: true };
        const { state, host } = makeSurfaces(start);
        setFocusSurfaces(host);
        setFocusMode(true);
        setFocusMode(true);
        setFocusMode(false);
        expect(state).toEqual(start);
    });

    it("exiting when not in focus should be a no-op on every surface", () => {
        const start: FakeState = { toolbarVisible: false, toc: { open: true, decision: "auto" }, proofreadingOn: true };
        const { state, host } = makeSurfaces(start);
        setFocusSurfaces(host);
        setFocusMode(false);
        expect(state).toEqual(start);
        expect(isFocusMode()).toBe(false);
    });

    it("a surface already collapsed should not be written on entry", () => {
        // Focus replays what it read; it never asserts a state. Writing a
        // surface that was already where focus wants it is how a toggle-based
        // host (the TOC's own `toggle()`) gets flipped the wrong way.
        const writes: string[] = [];
        const state: FakeState = { toolbarVisible: false, toc: { open: false, decision: "hidden" }, proofreadingOn: true };
        setFocusSurfaces({
            toolbarVisible: () => state.toolbarVisible,
            setToolbarVisible: (v) => { writes.push(`toolbar=${v}`); state.toolbarVisible = v; },
            tocState: () => state.toc,
            setTocState: (v) => { writes.push(`toc=${v.decision}`); state.toc = v; },
            proofreadingOn: () => state.proofreadingOn,
            setProofreadingOn: (v) => { writes.push(`proofread=${v}`); state.proofreadingOn = v; },
        });
        setFocusMode(true);
        expect(writes).toEqual(["proofread=false"]);
    });

    it("a closed TOC left on auto should still be parked on hidden, so a doc change cannot open it mid-focus", () => {
        const { state, host } = makeSurfaces({ toolbarVisible: false, toc: { open: false, decision: "auto" }, proofreadingOn: false });
        setFocusSurfaces(host);
        setFocusMode(true);
        expect(state.toc).toEqual(TOC_COLLAPSED);
        setFocusMode(false);
        expect(state.toc).toEqual({ open: false, decision: "auto" });
    });

    describe("inbound settings echoes during focus", () => {
        it("a proofread config echo should keep the live gate and be what the exit restores", () => {
            // The mask is live state, so a settings write is the one thing that
            // can un-silence a focused document. The user's new value must
            // survive to the exit, and the document must stay quiet until then.
            const { state, host } = makeSurfaces({ toolbarVisible: true, toc: { open: true, decision: "shown" }, proofreadingOn: false });
            setFocusSurfaces(host);
            setFocusMode(true);
            expect(state.proofreadingOn).toBe(false);

            // The user turns proofreading ON in settings while focused.
            const masked = maskProofreadConfigUnderFocus({ proofreadingEnabled: true, spelling: true });
            expect(masked, "the live gate is what reaches the plugin").toEqual({ proofreadingEnabled: false, spelling: true });

            setFocusMode(false);
            expect(state.proofreadingOn, "the setting the user chose is what returns").toBe(true);
        });

        it("a toolbar config echo should not re-show a toolbar focus hid", () => {
            // `visible` rides along on EVERY toolbar write, a layout drag
            // included, so the echo would otherwise re-show the bar the moment
            // anything about it was edited.
            const { state, host } = makeSurfaces({ toolbarVisible: true, toc: { open: false, decision: "hidden" }, proofreadingOn: false });
            setFocusSurfaces(host);
            setFocusMode(true);
            expect(state.toolbarVisible).toBe(false);

            const masked = maskToolbarConfigUnderFocus({ visible: true, order: ["format"] });
            expect(masked).toEqual({ visible: false, order: ["format"] });

            setFocusMode(false);
            expect(state.toolbarVisible).toBe(true);
        });

        it("a toolbar echo saying hidden should be what the exit restores", () => {
            const { state, host } = makeSurfaces({ toolbarVisible: true, toc: TOC_COLLAPSED, proofreadingOn: false });
            setFocusSurfaces(host);
            setFocusMode(true);
            maskToolbarConfigUnderFocus({ visible: false });
            setFocusMode(false);
            expect(state.toolbarVisible, "the user hid it in settings while focused").toBe(false);
        });

        it("a surface the user re-showed by hand during focus should keep the live state through an echo", () => {
            // The mask replays the LIVE value, not the collapsed one, so a
            // gesture made mid-focus is never fought by its own echo.
            const { state, host } = makeSurfaces({ toolbarVisible: true, toc: TOC_COLLAPSED, proofreadingOn: true });
            setFocusSurfaces(host);
            setFocusMode(true);
            state.toolbarVisible = true; // the expand tab
            state.proofreadingOn = true; // the Checks menu
            expect(maskToolbarConfigUnderFocus({ visible: true })).toEqual({ visible: true });
            expect(maskProofreadConfigUnderFocus({ proofreadingEnabled: true })).toEqual({ proofreadingEnabled: true });
        });

        it("a TOC visibility echo should be absorbed and be what the exit restores", () => {
            const { state, host } = makeSurfaces({ toolbarVisible: false, toc: { open: false, decision: "auto" }, proofreadingOn: false });
            setFocusSurfaces(host);
            setFocusMode(true);
            expect(absorbTocVisibilityUnderFocus("shown"), "the caller must not apply it").toBe(true);
            expect(state.toc, "the panel stays collapsed").toEqual(TOC_COLLAPSED);
            setFocusMode(false);
            expect(state.toc).toEqual({ open: true, decision: "shown" });
        });

        it("outside focus every echo should pass through untouched", () => {
            const { state, host } = makeSurfaces({ toolbarVisible: true, toc: { open: true, decision: "shown" }, proofreadingOn: true });
            setFocusSurfaces(host);
            expect(maskProofreadConfigUnderFocus({ proofreadingEnabled: false })).toEqual({ proofreadingEnabled: false });
            expect(maskToolbarConfigUnderFocus({ visible: false })).toEqual({ visible: false });
            expect(absorbTocVisibilityUnderFocus("hidden")).toBe(false);
            expect(state.proofreadingOn).toBe(true);
        });
    });

    it("subscribers should see each transition once, and the body class should mirror it", () => {
        const { host } = makeSurfaces({ toolbarVisible: true, toc: { open: true, decision: "shown" }, proofreadingOn: true });
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
