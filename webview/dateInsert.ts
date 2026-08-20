/**
 * webview/dateInsert.ts
 *
 * The one place a date reaches the document, and the one place that decides
 * which picker asks for it.
 *
 * Three gestures end here: `/today` and its two siblings, the editor's own
 * calendar, and Birta Writer Jot's `NSDatePicker`. They agree on the bytes
 * because none of them writes any: each produces a `CalendarDate`, and
 * `insertDateAtCaret` is the only function that spells one. The native picker
 * in particular reports a DAY and never a string, so the app cannot drift into
 * a second spelling of the same date.
 *
 * This module is eager and deliberately small. It holds the relative
 * insertions, which must not wait on a chunk, and the host round trip, whose
 * reply has to be routed by the eager message handler. The calendar is the
 * lazy half (`components/datePicker`), so a document that never asks for a
 * date never loads the grid or the picker. Its stylesheet is eager regardless,
 * as every component's is here; `datePicker.css` says why.
 */
import { type CalendarDate, formatCalendarDate } from "@/utils/dateFormat";
import { notifyShowDatePicker } from "@/messaging";
import { hostArranges } from "../shared/hostProfile";
import type { EditorView } from "@/pm";

/**
 * Writes the date at the caret, as plain text.
 *
 * Plain text is the whole design and not a shortcut. A date node would have to
 * survive serialization, and Markdown has nowhere to put one, so the file
 * would either grow a spelling no other tool reads or lose the value on a
 * round trip. What the user sees is what the file gets, and every tool that
 * opens it afterwards sees the same characters.
 */
export function insertDateAtCaret(view: EditorView, date: CalendarDate, locale?: string): void {
    const text = formatCalendarDate(date, locale);
    view.dispatch(view.state.tr.insertText(text).scrollIntoView());
    view.focus();
}

/** Pending native-picker requests, by the id the host echoes back. */
const pendingNative = new Map<string, (date: CalendarDate | null) => void>();

let nextRequestId = 0;

/**
 * How long a native picker may go unanswered before the editor takes its caret
 * back.
 *
 * The host is supposed to answer every request, a dismissal included, and Jot
 * does. It can still fail to: a malformed request is dropped rather than
 * answered, by design and by test, and a host that is not Jot may not
 * implement the message at all. Without this the caret is never returned and
 * the user is left in a document that will not take a keystroke, with nothing
 * on screen explaining why. `requestEditorContext` on the Jot side is bounded
 * for the same reason.
 */
const NATIVE_PICKER_TIMEOUT_MS = 60_000;

/**
 * Routes a `datePickerResult` back to the request that asked for it.
 *
 * An id the table does not know is dropped rather than guessed at. It names a
 * request that has already been retired: answered, or timed out, or belonging
 * to a webview that has gone. Guessing which pending request it meant would
 * write a date the user did not choose.
 *
 * What this is NOT is a guard against a document swap. Nothing clears the table
 * when the webview changes documents, so a reply that arrives with a live id
 * still lands. That case does not arise today, because the webview is torn down
 * and rebuilt per document and takes the table with it; it would need solving
 * the day one webview serves two.
 */
export function resolveNativeDatePicker(
    id: string,
    date: { year: number; month: number; day: number } | null,
): void {
    pendingNative.get(id)?.(date);
    pendingNative.delete(id);
}

/** The caret's rectangle in viewport coordinates, for anchoring a picker. */
function caretRect(view: EditorView, pos: number): { left: number; top: number; bottom: number } {
    try {
        const c = view.coordsAtPos(pos);
        return { left: c.left, top: c.top, bottom: c.bottom };
    } catch {
        // `coordsAtPos` needs a laid-out document, which jsdom does not
        // provide. Falling back to the editor's own box keeps the picker on
        // screen rather than at the origin.
        const r = view.dom.getBoundingClientRect();
        return { left: r.left + 8, top: r.top + 8, bottom: r.top + 8 };
    }
}

/**
 * Opens whichever date picker this surface has, and inserts what it returns.
 *
 * Both pickers take focus off the `contenteditable`, the editor's own calendar
 * because it is a keyboard focus trap and the native one because it is an
 * AppKit window, so giving the caret back is this function's job. Giving it
 * back is `view.focus()` and nothing more, and the reason is worth stating
 * because the obvious defensive version is wrong: ProseMirror's selection
 * lives in the editor STATE, not in the DOM, so focusing the view writes the
 * selection it already holds back into the document. Snapshotting the position
 * and restoring it through a transaction adds a no-op transaction and protects
 * against nothing, which `e2e/datePicker` demonstrates by passing in both
 * engines with the snapshot deleted.
 *
 * What is NOT assumed is that this holds. The two arms of that suite close the
 * picker and then type, in Chromium and in WebKit, and assert the character
 * landed in the block the caret started in.
 */
export function openDateChooser(view: EditorView, today: CalendarDate): void {
    // The position, not the rectangle: asking for the box again later is what
    // lets the popup follow a caret the document has scrolled under it.
    //
    // The position can go stale, and the picker being modal to the KEYBOARD
    // does not prevent it: an external file change or a host sync arrives down
    // the message pipe regardless. What makes that safe is not the modality but
    // `caretRect` below, which catches a position the document no longer has
    // and falls back to the editor's own box.
    const anchorPos = view.state.selection.from;
    const anchor = (): { left: number; top: number; bottom: number } => caretRect(view, anchorPos);
    const refocus = (): void => { view.focus(); };

    if (hostArranges("nativeDatePicker")) {
        const id = `date-${++nextRequestId}`;
        const timer = setTimeout(() => {
            if (pendingNative.delete(id)) { refocus(); }
        }, NATIVE_PICKER_TIMEOUT_MS);
        pendingNative.set(id, (picked) => {
            clearTimeout(timer);
            if (picked) { insertDateAtCaret(view, picked); } else { refocus(); }
        });
        notifyShowDatePicker(id, anchor());
        return;
    }

    // The picker reports `onClose` before `onPick`, so the editor is focused
    // again before anything is written to it. One route back for a dismissal
    // and a pick alike, rather than two that can drift.
    import("@/components/datePicker")
        .then((m) => m.openDatePicker({
            content: view.dom as HTMLElement,
            anchor,
            today,
            onPick: (date) => insertDateAtCaret(view, date),
            onClose: refocus,
        }))
        .catch((e) => console.error("[birta] date picker failed to load", e));
}
