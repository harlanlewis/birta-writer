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
 * How long to wait for the text editor to show up at all. Several times the
 * probed ~26 ms; the rest is headroom for a loaded machine. On expiry we swap
 * anyway — a missed jump is a disappointment, a stalled swap is a bug.
 */
export const EDITOR_APPEAR_BUDGET_MS = 120;

/**
 * How long to wait for the navigation's selection once the editor exists.
 *
 * The probe put it ~2 ms behind the editor, so this is almost entirely margin.
 * It is also the delay every ORDINARY open pays before the swap, and the swap
 * is what the user sees: the raw text is on screen for the whole wait, so this
 * number is the difference between a flicker and a readable flash of Markdown.
 * Keep it an order of magnitude above the measurement and no more.
 */
export const SELECTION_GRACE_MS = 20;

/** The vscode surface this module reads, injected so it can be unit-tested. */
export interface NavCaptureDeps {
    onSelectionChange: vscode.Event<vscode.TextEditorSelectionChangeEvent>;
    onVisibleEditorsChange: vscode.Event<readonly vscode.TextEditor[]>;
    visibleEditors: () => readonly vscode.TextEditor[];
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
}

function defaultDeps(): NavCaptureDeps {
    return {
        onSelectionChange: vscode.window.onDidChangeTextEditorSelection,
        onVisibleEditorsChange: vscode.window.onDidChangeVisibleTextEditors,
        visibleEditors: () => vscode.window.visibleTextEditors,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
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

        // THE signal: an explicit navigation applying its selection. Newer
        // VS Code stamps those TextEditorSelectionChangeKind.Command. The
        // engines floor (1.95.0) applies a search-result reveal
        // programmatically with kind UNDEFINED, so an undefined kind is
        // accepted too — but only with a NON-EMPTY selection, which is what
        // separates a reveal highlighting its match from an editor-state
        // restore parking a bare caret (an ordinary reopen must never read as
        // "jump"). Caught by the release corpus step's floor matrix.
        subscriptions.push(
            deps.onSelectionChange((event) => {
                if (event.textEditor.document.uri.toString() !== key) { return; }
                const selection = event.selections[0];
                const isCommand = event.kind === vscode.TextEditorSelectionChangeKind.Command;
                const isFloorReveal =
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
