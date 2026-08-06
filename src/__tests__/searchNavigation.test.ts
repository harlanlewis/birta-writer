/**
 * Catching the navigation VS Code aims at the short-lived raw text editor
 * before the WYSIWYG swap closes it (src/searchNavigation.ts).
 *
 * The bug this pins: a search-result click opened the file at the top with no
 * selection. Two causes — the swap closed the text tab before the extension
 * host reported anything, and the one listener that did fire read the caret a
 * tick BEFORE the search applied its range (`0:0` → "line 1" → scroll to top).
 * The signal that actually carries the target is a `Command`-kind selection
 * change, which arrives a couple of milliseconds after the editor appears.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

import {
    captureNavTarget,
    navTargetFromSelection,
    versionAcceptsUndefinedKindReveal,
    EDITOR_APPEAR_BUDGET_MS,
    SELECTION_GRACE_MS,
    type NavCaptureDeps,
} from "../searchNavigation";

const URI = vscode.Uri.file("/notes/target.md");
const OTHER = vscode.Uri.file("/notes/other.md");

const selection = (
    anchorLine: number,
    anchorChar: number,
    activeLine: number,
    activeChar: number,
): vscode.Selection =>
    new vscode.Selection(
        new vscode.Position(anchorLine, anchorChar),
        new vscode.Position(activeLine, activeChar),
    ) as unknown as vscode.Selection;

const editorFor = (uri: vscode.Uri): vscode.TextEditor =>
    ({ document: { uri } }) as unknown as vscode.TextEditor;

/** A controllable stand-in for the two vscode events the capture listens to.
 *  `acceptUndefinedKindReveal` defaults to the floor's behavior so the
 *  fallback path is what most kind-related cases exercise. */
function makeHarness(acceptUndefinedKindReveal = true) {
    const selectionListeners: Array<(e: vscode.TextEditorSelectionChangeEvent) => void> = [];
    const visibleListeners: Array<(e: readonly vscode.TextEditor[]) => void> = [];
    let visible: vscode.TextEditor[] = [];
    let disposals = 0;

    const deps: NavCaptureDeps = {
        onSelectionChange: ((listener: (e: vscode.TextEditorSelectionChangeEvent) => void) => {
            selectionListeners.push(listener);
            return { dispose: () => { disposals++; } };
        }) as unknown as NavCaptureDeps["onSelectionChange"],
        onVisibleEditorsChange: ((listener: (e: readonly vscode.TextEditor[]) => void) => {
            visibleListeners.push(listener);
            return { dispose: () => { disposals++; } };
        }) as unknown as NavCaptureDeps["onVisibleEditorsChange"],
        visibleEditors: () => visible,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        acceptUndefinedKindReveal,
    };

    return {
        deps,
        get disposals() { return disposals; },
        get listenerCount() { return selectionListeners.length + visibleListeners.length; },
        /** The editor shows up in the window, as it does ~26 ms after the tab opens. */
        showEditor(uri: vscode.Uri) {
            visible = [...visible, editorFor(uri)];
            for (const listener of [...visibleListeners]) { listener(visible); }
        },
        /** A navigation applying its target, as search does ~2 ms later.
         *  The kind is a rest tuple, not a defaulted parameter: the 1.95
         *  floor's reveal fires with kind UNDEFINED, and a default would
         *  silently turn an explicit `undefined` back into Command. */
        applySelection(
            uri: vscode.Uri,
            sel: vscode.Selection,
            ...kindArg: [vscode.TextEditorSelectionChangeKind | undefined] | []
        ) {
            const kind = kindArg.length
                ? kindArg[0]
                : vscode.TextEditorSelectionChangeKind.Command;
            for (const listener of [...selectionListeners]) {
                listener({
                    textEditor: editorFor(uri),
                    selections: [sel],
                    kind,
                } as unknown as vscode.TextEditorSelectionChangeEvent);
            }
        },
    };
}

describe("navTargetFromSelection", () => {
    it("a search hit's range should carry both ends, 1-indexed", () => {
        expect(navTargetFromSelection(selection(78, 22, 78, 28))).toEqual({
            line: 79,
            column: 28,
            anchor: { line: 79, column: 22 },
        });
    });

    it("a bare caret should carry no anchor", () => {
        expect(navTargetFromSelection(selection(11, 4, 11, 4))).toEqual({ line: 12, column: 4 });
    });

    it("a caret at 0:0 should read as no navigation at all", () => {
        // Where every document opens by default: acting on it would throw away
        // the panel's remembered scroll position on an ordinary open.
        expect(navTargetFromSelection(selection(0, 0, 0, 0))).toBeUndefined();
    });

    it("a selection anchored at 0:0 should still be a real target", () => {
        expect(navTargetFromSelection(selection(0, 0, 0, 6))).toEqual({
            line: 1,
            column: 6,
            anchor: { line: 1, column: 0 },
        });
    });
});

describe("captureNavTarget", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("a Command selection after the editor appears should resolve the target", async () => {
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        vi.advanceTimersByTime(26);
        harness.showEditor(URI);
        vi.advanceTimersByTime(2);
        harness.applySelection(URI, selection(78, 22, 78, 28));

        await expect(captured).resolves.toEqual({
            line: 79,
            column: 28,
            anchor: { line: 79, column: 22 },
        });
    });

    it("a target arriving before the grace expires should not be lost to the timeout", async () => {
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        harness.showEditor(URI);
        vi.advanceTimersByTime(SELECTION_GRACE_MS - 1);
        harness.applySelection(URI, selection(4, 0, 4, 3));
        vi.advanceTimersByTime(SELECTION_GRACE_MS);

        await expect(captured).resolves.toEqual({
            line: 5,
            column: 3,
            anchor: { line: 5, column: 0 },
        });
    });

    it("an editor already on screen should still be waited on for its selection", async () => {
        const harness = makeHarness();
        harness.showEditor(URI);
        const captured = captureNavTarget(URI, harness.deps);

        harness.applySelection(URI, selection(9, 1, 9, 1));

        await expect(captured).resolves.toEqual({ line: 10, column: 1 });
    });

    it("an ordinary open with no navigation should resolve nothing within the grace", async () => {
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        harness.showEditor(URI);
        await vi.advanceTimersByTimeAsync(SELECTION_GRACE_MS);

        await expect(captured).resolves.toBeUndefined();
    });

    it("an editor that never appears should resolve nothing within the budget", async () => {
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        await vi.advanceTimersByTimeAsync(EDITOR_APPEAR_BUDGET_MS);

        await expect(captured).resolves.toBeUndefined();
    });

    it("an undefined-kind NON-EMPTY selection should read as a navigation (the 1.95 floor's search reveal)", async () => {
        // VS Code 1.95.0 applies a search-result reveal programmatically, with
        // no kind stamped — newer builds stamp Command. Caught by the release
        // corpus step the first time the engines floor was actually launched.
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        harness.showEditor(URI);
        harness.applySelection(
            URI,
            selection(78, 22, 78, 28),
            undefined,
        );

        await expect(captured).resolves.toEqual({
            line: 79,
            column: 28,
            anchor: { line: 79, column: 22 },
        });
    });

    it("on modern VS Code an undefined-kind selection should be ignored even when non-empty", async () => {
        // Modern builds stamp reveals Command, so an undefined-kind non-empty
        // change there is a RESTORED selection — acting on it would jump to a
        // stale line and hand typing a selected range to replace.
        const harness = makeHarness(false);
        const captured = captureNavTarget(URI, harness.deps);

        harness.showEditor(URI);
        harness.applySelection(URI, selection(78, 22, 78, 28), undefined);
        await vi.advanceTimersByTimeAsync(SELECTION_GRACE_MS);

        await expect(captured).resolves.toBeUndefined();
    });

    it("the undefined-kind fallback should switch on the version floor", () => {
        expect(versionAcceptsUndefinedKindReveal("1.95.0")).toBe(true);
        expect(versionAcceptsUndefinedKindReveal("1.99.3")).toBe(true);
        expect(versionAcceptsUndefinedKindReveal("1.100.0")).toBe(false);
        expect(versionAcceptsUndefinedKindReveal("1.132.0")).toBe(false);
        expect(versionAcceptsUndefinedKindReveal("2.0.0")).toBe(false);
    });

    it("an undefined-kind BARE CARET should not read as a navigation (editor-state restore)", async () => {
        // The other thing that fires an undefined-kind change: reopening a
        // file restores its previous caret. Acting on that would turn every
        // reopen into a jump and discard the panel's remembered scroll.
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        harness.showEditor(URI);
        harness.applySelection(
            URI,
            selection(40, 5, 40, 5),
            undefined,
        );
        await vi.advanceTimersByTimeAsync(SELECTION_GRACE_MS);

        await expect(captured).resolves.toBeUndefined();
    });

    it("a keyboard or mouse selection should not read as a navigation", async () => {
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        harness.showEditor(URI);
        harness.applySelection(
            URI,
            selection(40, 0, 40, 5),
            vscode.TextEditorSelectionChangeKind.Mouse,
        );
        await vi.advanceTimersByTimeAsync(SELECTION_GRACE_MS);

        await expect(captured).resolves.toBeUndefined();
    });

    it("another file's navigation should be ignored", async () => {
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        harness.showEditor(OTHER);
        harness.applySelection(OTHER, selection(3, 0, 3, 9));
        await vi.advanceTimersByTimeAsync(EDITOR_APPEAR_BUDGET_MS);

        await expect(captured).resolves.toBeUndefined();
    });

    it("every listener should be disposed once the capture settles", async () => {
        const harness = makeHarness();
        const captured = captureNavTarget(URI, harness.deps);

        harness.showEditor(URI);
        harness.applySelection(URI, selection(2, 0, 2, 4));
        await captured;

        expect(harness.disposals).toBe(harness.listenerCount);
    });
});
