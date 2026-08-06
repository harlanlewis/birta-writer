/**
 * src/searchNavigation.ts
 *
 * Catching a navigation that VS Code aims at a `.md` file we are about to
 * replace with the WYSIWYG editor — a search-result click, Go to Definition,
 * `code -g file:line`, a problems-panel entry.
 *
 * Those all open the file through the editor service with a selection attached.
 * A custom editor is never told about it (microsoft/vscode#102110's sibling
 * problem: options.selection reaches a text pane only), so the ONE place the
 * target is observable is the short-lived raw text editor VS Code opens before
 * `defaultMode: "preview"` swaps it for a Birta panel.
 *
 * Two facts about that window shape everything here (Extension Host probe,
 * 2026-07-29; re-probe before changing either constant below):
 *
 *   1. The swap can outrun the extension host. Close that text tab too soon
 *      after it opens and `onDidChangeActiveTextEditor` NEVER fires for it —
 *      the delta is coalesced away, and the navigation is lost with it. So the
 *      swap has to wait for the signal rather than race it.
 *   2. `onDidChangeActiveTextEditor` is the wrong signal anyway. It arrives
 *      ~26 ms after the tab opens carrying selection `0:0`; the real target
 *      lands ~2 ms later as a SEPARATE `onDidChangeTextEditorSelection` of
 *      kind `Command`.
 *
 * Hence: wait for the editor to appear, then a short grace for the selection.
 * A plain open produces no `Command` selection, so it resolves `undefined` and
 * the panel keeps restoring its own remembered scroll position.
 */

import * as vscode from "vscode";

/**
 * A navigation to hand to `MarkdownEditorProvider.setPendingNavigation` —
 * 1-indexed document lines, matching the wire. `anchor` is present only for a
 * real range, so a search hit arrives SELECTED rather than as a bare caret.
 */
export interface CapturedNavTarget {
    line: number;
    column: number;
    anchor?: { line: number; column: number };
}

/**
 * How long to wait for the text editor to show up at all. Locally probed
 * ~26 ms; on expiry we swap anyway — a missed jump is a disappointment, a
 * stalled swap is a bug. Sized for the slowest machine that must pass, not
 * the laptop: the release job's floor run (ubuntu-latest under xvfb,
 * 2026-08-06) missed a search reveal that three local runs caught.
 */
export const EDITOR_APPEAR_BUDGET_MS = 400;

/**
 * How long to wait for the navigation's selection once the editor exists.
 * Locally probed ~2 ms behind the editor; the release runner needed more (see
 * above). This is also the delay every ORDINARY open pays before the swap,
 * with the raw text on screen for the whole wait — so it buys reliability
 * with flash duration, and 80 ms is still under a perceptible beat.
 */
export const SELECTION_GRACE_MS = 80;

/** The vscode surface this module reads, injected so it can be unit-tested. */
export interface NavCaptureDeps {
    onSelectionChange: vscode.Event<vscode.TextEditorSelectionChangeEvent>;
    onVisibleEditorsChange: vscode.Event<readonly vscode.TextEditor[]>;
    visibleEditors: () => readonly vscode.TextEditor[];
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    /** Accept an undefined-kind non-empty selection as a navigation. Old
     *  VS Code (the 1.95 floor) applies a search reveal without stamping
     *  `Command`, so there it is the only signal — at the cost of also
     *  matching a restored selection, which modern builds must not pay:
     *  a false positive arrives SELECTED, and typing would replace it. */
    acceptUndefinedKindReveal: boolean;
}

/** Builds newer than this stamp reveals `Command`; the exact cutover between
 *  1.95 and 1.132 is unpinned, so builds in between keep the strict filter
 *  (their search jump behaves as before this fix, nothing worse). */
const UNDEFINED_KIND_REVEAL_CEILING_MINOR = 100;

export function versionAcceptsUndefinedKindReveal(version: string): boolean {
    const [major, minor] = version.split(".").map(Number);
    return major === 1 && minor < UNDEFINED_KIND_REVEAL_CEILING_MINOR;
}

function defaultDeps(): NavCaptureDeps {
    return {
        onSelectionChange: vscode.window.onDidChangeTextEditorSelection,
        onVisibleEditorsChange: vscode.window.onDidChangeVisibleTextEditors,
        visibleEditors: () => vscode.window.visibleTextEditors,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        acceptUndefinedKindReveal: versionAcceptsUndefinedKindReveal(vscode.version),
    };
}

/**
 * The target a selection describes, or undefined when it describes nothing.
 *
 * A bare caret at 0:0 is where every document opens by default — it is
 * indistinguishable from "no navigation happened", and acting on it would
 * throw away the panel's remembered scroll position for an ordinary open.
 */
export function navTargetFromSelection(
    selection: vscode.Selection | undefined,
): CapturedNavTarget | undefined {
    if (!selection) { return undefined; }
    const { anchor, active } = selection;
    const isEmpty = anchor.line === active.line && anchor.character === active.character;
    if (isEmpty && active.line === 0 && active.character === 0) { return undefined; }
    return {
        line: active.line + 1,
        column: active.character,
        ...(isEmpty
            ? {}
            : { anchor: { line: anchor.line + 1, column: anchor.character } }),
    };
}

/**
 * The navigation aimed at `uri`, or undefined if the open carried none.
 *
 * Resolves as soon as the signal arrives — the full budget is only ever paid
 * by an open that isn't a navigation.
 */
export function captureNavTarget(
    uri: vscode.Uri,
    deps: NavCaptureDeps = defaultDeps(),
): Promise<CapturedNavTarget | undefined> {
    const key = uri.toString();
    const isTarget = (editors: readonly vscode.TextEditor[]): boolean =>
        editors.some((editor) => editor.document.uri.toString() === key);

    return new Promise((resolve) => {
        const subscriptions: vscode.Disposable[] = [];
        let appearTimer: unknown;
        let graceTimer: unknown;
        let settled = false;

        const finish = (target: CapturedNavTarget | undefined): void => {
            if (settled) { return; }
            settled = true;
            deps.clearTimeout(appearTimer);
            deps.clearTimeout(graceTimer);
            for (const subscription of subscriptions) { subscription.dispose(); }
            resolve(target);
        };

        // THE signal: an explicit navigation applying its selection, stamped
        // Command — except on old builds, where a reveal carries no kind and
        // the non-empty fallback applies (see acceptUndefinedKindReveal).
        subscriptions.push(
            deps.onSelectionChange((event) => {
                if (event.textEditor.document.uri.toString() !== key) { return; }
                const selection = event.selections[0];
                const isCommand = event.kind === vscode.TextEditorSelectionChangeKind.Command;
                const isFloorReveal =
                    deps.acceptUndefinedKindReveal &&
                    event.kind === undefined && selection != null && !selection.isEmpty;
                if (!isCommand && !isFloorReveal) { return; }
                finish(navTargetFromSelection(selection));
            }),
        );

        const startGrace = (): void => {
            if (graceTimer !== undefined) { return; }
            deps.clearTimeout(appearTimer);
            appearTimer = undefined;
            graceTimer = deps.setTimeout(() => finish(undefined), SELECTION_GRACE_MS);
        };

        if (isTarget(deps.visibleEditors())) {
            startGrace();
            return;
        }
        subscriptions.push(
            deps.onVisibleEditorsChange((editors) => {
                if (isTarget(editors)) { startGrace(); }
            }),
        );
        appearTimer = deps.setTimeout(() => finish(undefined), EDITOR_APPEAR_BUDGET_MS);
    });
}
