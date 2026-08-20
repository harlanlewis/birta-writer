/**
 * The native-picker round trip, which is the half of `dateInsert.ts` no browser
 * run reaches.
 *
 * `e2e/datePicker` drives the editor's own calendar end to end in two engines,
 * but it runs on a VS Code-profile page, so the branch that hands the question
 * to the HOST is never taken there. The paths that matter most are also the
 * ones hardest to provoke live: a reply that never comes, one that comes twice,
 * and one belonging to a request nobody is waiting on. Each of those costs the
 * user their caret if it is wrong, silently.
 *
 * The view is a stand-in rather than a real editor, deliberately. What is under
 * test is the bookkeeping around the request, and a real ProseMirror view would
 * make the assertions about a transaction rather than about the protocol.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockVscodeApi } from "./setup";
import { openDateChooser, resolveNativeDatePicker } from "../dateInsert";
import { formatCalendarDate } from "../utils/dateFormat";
import type { EditorView } from "../pm";

/** Records what the module did to the editor, with no editor involved. */
function fakeView(): {
    view: EditorView;
    inserted: string[];
    dispatched: () => number;
    focused: () => number;
} {
    const inserted: string[] = [];
    let focusCount = 0;
    let dispatchCount = 0;
    const view = {
        state: {
            selection: { from: 7 },
            doc: { content: { size: 100 } },
            get tr() {
                return {
                    insertText(text: string) { inserted.push(text); return this; },
                    scrollIntoView() { return this; },
                };
            },
        },
        // Counted, not ignored: `inserted` is filled while BUILDING the
        // transaction, so without this an insertion that composed one and never
        // dispatched it would read as a success.
        dispatch: () => { dispatchCount += 1; },
        focus: () => { focusCount += 1; },
        // jsdom has no layout, so `coordsAtPos` throwing is the REAL path here
        // and the fallback rectangle is what production would use too.
        coordsAtPos: () => { throw new Error("no layout"); },
        dom: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
    } as unknown as EditorView;
    return { view, inserted, dispatched: () => dispatchCount, focused: () => focusCount };
}

const TODAY = { year: 2026, month: 8, day: 20 };

/** Declares the host that prefers its own picker. */
function declareNativeHost(): void {
    (globalThis as { __i18n?: unknown }).__i18n = {
        host: { capabilities: [], arrangements: ["nativeDatePicker"], shortcuts: [] },
    };
}

/** The id of the most recent `showDatePicker` the module posted. */
function lastRequestId(): string {
    const calls = mockVscodeApi.postMessage.mock.calls as unknown as Array<[{ type: string; id: string }]>;
    const shown = calls.filter((c) => c[0]?.type === "showDatePicker");
    expect(shown.length, "no showDatePicker was posted").toBeGreaterThan(0);
    return shown[shown.length - 1]![0].id;
}

describe("openDateChooser on a host with its own picker", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        declareNativeHost();
    });
    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as { __i18n?: unknown }).__i18n;
    });

    it("a host that prefers its own picker should be asked, and not shown ours", () => {
        const { view, inserted } = fakeView();
        openDateChooser(view, TODAY);

        const posted = mockVscodeApi.postMessage.mock.calls
            .map((c) => c[0] as { type: string })
            .filter((m) => m.type === "showDatePicker");
        expect(posted).toHaveLength(1);
        // Nothing is written until the host answers.
        expect(inserted).toEqual([]);
        expect(document.querySelector(".date-picker")).toBeNull();
    });

    it("the request should carry an anchor, so the host has somewhere to put it", () => {
        const { view } = fakeView();
        openDateChooser(view, TODAY);
        const msg = mockVscodeApi.postMessage.mock.calls
            .map((c) => c[0] as Record<string, unknown>)
            .find((m) => m.type === "showDatePicker")!;
        for (const key of ["id", "left", "top", "bottom"]) {
            expect(msg[key], key).toBeDefined();
            if (key !== "id") { expect(typeof msg[key], key).toBe("number"); }
        }
    });

    it("a chosen day should be written, in the one spelling the editor owns", () => {
        const { view, inserted, dispatched } = fakeView();
        openDateChooser(view, TODAY);
        resolveNativeDatePicker(lastRequestId(), { year: 2026, month: 8, day: 20 });
        // The host reported a DAY; the characters are the editor's. Compared
        // against the formatter rather than against a literal, because the
        // native path passes no locale: a hardcoded "Aug 20, 2026" would be an
        // assertion about the RUNNER's ambient ICU default, and would go red on
        // a machine with a different one while the code was perfectly correct.
        expect(inserted).toEqual([formatCalendarDate({ year: 2026, month: 8, day: 20 })]);
        expect(dispatched(), "the transaction was built but never dispatched").toBe(1);
    });

    it("a dismissed picker should write nothing and give the caret back", () => {
        const { view, inserted, focused } = fakeView();
        openDateChooser(view, TODAY);
        resolveNativeDatePicker(lastRequestId(), null);
        expect(inserted).toEqual([]);
        expect(focused()).toBe(1);
    });

    it("a second reply to the same request should do nothing", () => {
        // The popover reports on pick and its close follows; a table that did
        // not retire the request would insert twice.
        const { view, inserted } = fakeView();
        openDateChooser(view, TODAY);
        const id = lastRequestId();
        resolveNativeDatePicker(id, { year: 2026, month: 8, day: 20 });
        resolveNativeDatePicker(id, { year: 2026, month: 8, day: 21 });
        // Derived, not literal, for the reason the arm above gives: the native
        // path passes no locale, so a hardcoded spelling would assert the
        // runner's ambient ICU default rather than anything this code decides.
        expect(inserted).toEqual([formatCalendarDate({ year: 2026, month: 8, day: 20 })]);
    });

    it("a reply to a request nobody is waiting on should be ignored", () => {
        const { view, inserted, focused } = fakeView();
        openDateChooser(view, TODAY);
        resolveNativeDatePicker("date-from-another-document", { year: 2001, month: 1, day: 1 });
        expect(inserted).toEqual([]);
        expect(focused()).toBe(0);
    });

    it("a host that never answers should still give the caret back", () => {
        vi.useFakeTimers();
        const { view, inserted, focused } = fakeView();
        openDateChooser(view, TODAY);
        expect(focused()).toBe(0);
        vi.advanceTimersByTime(60_000);
        expect(focused(), "the caret was never returned").toBe(1);
        expect(inserted).toEqual([]);
    });

    it("an answer that arrives should cancel the timeout rather than leave it armed", () => {
        vi.useFakeTimers();
        const { view, focused } = fakeView();
        openDateChooser(view, TODAY);
        expect(vi.getTimerCount(), "no timeout was armed").toBe(1);

        resolveNativeDatePicker(lastRequestId(), null);
        expect(focused()).toBe(1);
        // The timer itself, not just its effect. The pending-table delete
        // already makes a late callback inert, so asserting only that focus
        // stayed at one passes with `clearTimeout` deleted, and would be
        // pinning the guard while claiming to pin the clear.
        expect(vi.getTimerCount(), "the timeout is still armed after a reply").toBe(0);

        vi.advanceTimersByTime(120_000);
        expect(focused(), "the timeout fired after the reply").toBe(1);
    });
});

describe("openDateChooser on a host with no picker of its own", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete (globalThis as { __i18n?: unknown }).__i18n;
    });

    it("the host should not be asked, because the editor draws its own calendar", () => {
        const { view } = fakeView();
        openDateChooser(view, TODAY);
        const asked = mockVscodeApi.postMessage.mock.calls
            .map((c) => c[0] as { type: string })
            .filter((m) => m.type === "showDatePicker");
        expect(asked).toEqual([]);
    });
});
