/**
 * plugins/imageUploadProgress.ts — pasting/dropping an image (MAR-21 item 4).
 *
 * Saving a pasted image is a round trip to the extension host (read the file,
 * MD5-dedup it, write it next to the document), and until it came back the
 * editor said NOTHING: no sign the paste had registered, and — if the save
 * failed — no sign it had failed either, because the only handler was a
 * `console.error` no user will ever see. A slow or failed save was
 * indistinguishable from a paste that did nothing.
 *
 * This tracks each in-flight save as a WIDGET DECORATION at the position the
 * paste happened, per docs/DESIGN_PRINCIPLES.md:
 *
 *   - *Analysis never blocks interactivity* — the decoration is chrome, so you
 *     keep typing while the save runs. No placeholder node is inserted, which
 *     also means a failed save leaves NOTHING to clean up and never lands a
 *     junk step in the undo history.
 *   - *Advisory, reversible, and quiet* — a failure becomes a dismissable pill
 *     (the `.ui-notice` primitive) that states what went wrong; it never
 *     modifies the document.
 *
 * The tracked position is mapped through every transaction, which also fixes a
 * real bug in the old flow: the resolved image was inserted with
 * `replaceSelectionWith` at the LIVE caret, so if you kept typing (or clicked
 * elsewhere) while the save was in flight, the image landed wherever the caret
 * had got to rather than where you pasted it.
 */
import { $prose } from "@milkdown/utils";
import { Decoration, DecorationSet, Plugin, PluginKey } from "@/pm";
import type { EditorView } from "@/pm";
import { t } from "../i18n";
import "./imageUploadProgress.css";

export const imageUploadProgressKey = new PluginKey<UploadState>("birta-image-upload");

/** One in-flight (or just-failed) image save. */
interface PendingUpload {
    readonly id: string;
    /** Document position the paste happened at; mapped through every step. */
    pos: number;
    /** Set once the save fails — the pill switches from progress to error. */
    error?: string;
}

interface UploadState {
    readonly uploads: readonly PendingUpload[];
    readonly decorations: DecorationSet;
}

type UploadAction =
    | { kind: "begin"; id: string; pos: number }
    | { kind: "settle"; id: string }
    | { kind: "fail"; id: string; error: string };

function progressWidget(): HTMLElement {
    const el = document.createElement("span");
    el.className = "img-upload-pill";
    el.setAttribute("aria-live", "polite");
    el.append(Object.assign(document.createElement("span"), { className: "img-upload-pill__spinner" }));
    el.append(document.createTextNode(t("Saving image…")));
    return el;
}

function errorWidget(upload: PendingUpload, view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "ui-notice img-upload-pill img-upload-pill--error";
    el.setAttribute("role", "alert");
    el.append(document.createTextNode(t("Image not saved: ") + upload.error));
    const dismiss = document.createElement("button");
    dismiss.className = "ui-btn ui-btn--icon ui-notice__dismiss";
    dismiss.setAttribute("aria-label", t("Dismiss"));
    dismiss.textContent = "×";
    // The failure is chrome, so dismissing it is not a document edit and must
    // not enter the undo history — a bare meta-only transaction.
    dismiss.addEventListener("mousedown", (e) => {
        e.preventDefault();
        settleImageUpload(view, upload.id);
    });
    el.append(dismiss);
    return el;
}

function buildDecorations(uploads: readonly PendingUpload[], view: EditorView | null, doc: { content: { size: number } }): DecorationSet {
    if (uploads.length === 0 || !view) { return DecorationSet.empty; }
    const decos = uploads
        // A position can be mapped away entirely (the block was deleted while
        // the save ran); drop rather than throw.
        .filter((u) => u.pos >= 0 && u.pos <= doc.content.size)
        .map((u) =>
            Decoration.widget(u.pos, () => (u.error ? errorWidget(u, view) : progressWidget()), {
                side: 1,
                key: `${u.id}:${u.error ?? ""}`,
            }),
        );
    return DecorationSet.create(doc as never, decos);
}

export const imageUploadProgressPlugin = $prose(() => {
    let liveView: EditorView | null = null;
    return new Plugin<UploadState>({
        key: imageUploadProgressKey,
        view(view) {
            liveView = view;
            return { destroy() { liveView = null; } };
        },
        state: {
            init: () => ({ uploads: [], decorations: DecorationSet.empty }),
            apply(tr, prev, _old, newState) {
                const action = tr.getMeta(imageUploadProgressKey) as UploadAction | undefined;
                let uploads = prev.uploads;
                if (tr.docChanged) {
                    uploads = uploads.map((u) => ({ ...u, pos: tr.mapping.map(u.pos, 1) }));
                }
                if (action?.kind === "begin") {
                    uploads = [...uploads, { id: action.id, pos: action.pos }];
                } else if (action?.kind === "settle") {
                    uploads = uploads.filter((u) => u.id !== action.id);
                } else if (action?.kind === "fail") {
                    uploads = uploads.map((u) =>
                        u.id === action.id ? { ...u, error: action.error } : u);
                }
                if (uploads === prev.uploads && !tr.docChanged) { return prev; }
                return { uploads, decorations: buildDecorations(uploads, liveView, newState.doc) };
            },
        },
        props: {
            decorations(state) { return imageUploadProgressKey.getState(state)?.decorations; },
        },
    });
});

let counter = 0;

/**
 * Marks an image save as started at the current selection and returns its
 * token. Never throws: a failure to show progress must not abort the save.
 */
export function beginImageUpload(view: EditorView): string {
    const id = `upl${++counter}`;
    view.dispatch(view.state.tr.setMeta(imageUploadProgressKey, {
        kind: "begin", id, pos: view.state.selection.from,
    } satisfies UploadAction));
    return id;
}

/** Clears an upload's chrome — on success, or when its error is dismissed. */
export function settleImageUpload(view: EditorView, id: string): void {
    view.dispatch(view.state.tr.setMeta(imageUploadProgressKey,
        { kind: "settle", id } satisfies UploadAction));
}

/** Turns an upload's progress pill into a dismissable error pill. */
export function failImageUpload(view: EditorView, id: string, error: string): void {
    view.dispatch(view.state.tr.setMeta(imageUploadProgressKey,
        { kind: "fail", id, error } satisfies UploadAction));
}

/**
 * Where a still-pending upload should insert, or null if it was cancelled or
 * its position was deleted while the save ran.
 */
export function uploadInsertPos(view: EditorView, id: string): number | null {
    const found = imageUploadProgressKey.getState(view.state)?.uploads.find((u) => u.id === id);
    if (!found) { return null; }
    return found.pos >= 0 && found.pos <= view.state.doc.content.size ? found.pos : null;
}
