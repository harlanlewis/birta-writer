/**
 * Local undo/redo for overlay text inputs.
 *
 * VS Code's Electron layer intercepts Cmd+Z / Ctrl+Z before the native
 * input ever sees it, so undo/redo silently does nothing inside webview
 * overlay inputs (link popup, image toolbar, find bar, ...). This helper
 * maintains a small per-input history stack and handles the shortcuts
 * itself, stopping propagation so nothing upstream swallows them.
 */

interface Snapshot {
    value: string;
    selectionStart: number;
    selectionEnd: number;
}

/** Maximum number of undo entries kept per input. */
const MAX_STACK = 100;

/** Typing within this window is coalesced into a single undo step (ms). */
const COALESCE_MS = 300;

type UndoableInput = HTMLInputElement | HTMLTextAreaElement;

function takeSnapshot(input: UndoableInput): Snapshot {
    return {
        value: input.value,
        selectionStart: input.selectionStart ?? input.value.length,
        selectionEnd: input.selectionEnd ?? input.value.length,
    };
}

function applySnapshot(input: UndoableInput, snap: Snapshot): void {
    input.value = snap.value;
    try {
        input.setSelectionRange(snap.selectionStart, snap.selectionEnd);
    } catch {
        // Some input types reject setSelectionRange; value restore still applies
    }
}

/** Is this keydown an undo/redo chord? Accept meta OR ctrl as the modifier. */
function chordOf(e: KeyboardEvent): "undo" | "redo" | null {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) {
        return null;
    }
    const key = e.key.toLowerCase();
    if (key === "z") {
        return e.shiftKey ? "redo" : "undo";
    }
    if (key === "y" && !e.shiftKey) {
        return "redo";
    }
    return null;
}

/**
 * Attach local undo/redo handling to a text input.
 *
 * - Snapshots {value, selection} on each `input` event; rapid typing
 *   (< 300ms between events) is coalesced into one undo step.
 * - Mod-Z undoes, Mod-Shift-Z / Ctrl-Y redoes, with preventDefault +
 *   stopPropagation so VS Code / ProseMirror never see the chord.
 * - Restoring dispatches a synthetic bubbling `input` event so live
 *   listeners (filtering, search) still react.
 *
 * @returns detach function that removes all listeners.
 */
export function attachInputUndo(input: UndoableInput): () => void {
    const undoStack: Snapshot[] = [];
    const redoStack: Snapshot[] = [];
    // The state the input is currently in (as far as history is concerned)
    let current = takeSnapshot(input);
    let lastInputTime = 0;
    let restoring = false;

    /**
     * Resync after programmatic value changes (they fire no `input` event).
     * Old history refers to different content at that point, so drop it
     * rather than let undo restore stale values.
     */
    function resyncIfStale(): void {
        if (input.value !== current.value) {
            current = takeSnapshot(input);
            lastInputTime = 0;
            undoStack.length = 0;
            redoStack.length = 0;
        }
    }

    function onInput(): void {
        if (restoring) {
            return;
        }
        if (input.value === current.value) {
            // No value change (e.g. selection-only synthetic events): keep history
            current = takeSnapshot(input);
            return;
        }
        const now = Date.now();
        // Coalesce a rapid typing burst into one undo step: only push a new
        // entry when enough time has passed since the previous edit
        if (now - lastInputTime > COALESCE_MS) {
            undoStack.push(current);
            if (undoStack.length > MAX_STACK) {
                undoStack.shift();
            }
        }
        lastInputTime = now;
        current = takeSnapshot(input);
        redoStack.length = 0;
    }

    function restore(snap: Snapshot): void {
        restoring = true;
        try {
            applySnapshot(input, snap);
            current = snap;
            lastInputTime = 0;
            // Let live listeners (filtering, search, ...) react to the change
            input.dispatchEvent(new Event("input", { bubbles: true }));
        } finally {
            restoring = false;
        }
    }

    // Typed as Event: the input union type collapses addEventListener to
    // its generic overload, which does not narrow "keydown" listeners
    function onKeydown(event: Event): void {
        const e = event as KeyboardEvent;
        if (e.isComposing) {
            return;
        }
        const chord = chordOf(e);
        if (!chord) {
            return;
        }
        // Swallow the chord even when there is nothing to undo/redo, so it
        // never leaks to the editor or VS Code
        e.preventDefault();
        e.stopPropagation();

        resyncIfStale();

        if (chord === "undo") {
            const prev = undoStack.pop();
            if (prev === undefined) {
                return;
            }
            redoStack.push(current);
            restore(prev);
        } else {
            const next = redoStack.pop();
            if (next === undefined) {
                return;
            }
            undoStack.push(current);
            restore(next);
        }
    }

    // Overlay inputs are often reused across openings with programmatic
    // prefills; resync on focus so undo never restores stale content
    function onFocus(): void {
        resyncIfStale();
    }

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("focus", onFocus);

    return () => {
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onKeydown);
        input.removeEventListener("focus", onFocus);
    };
}
