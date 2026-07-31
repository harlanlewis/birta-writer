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

/**
 * How long a save may run before it is worth telling the user about. A local
 * save is usually single-digit milliseconds, and a pill that appears and
 * vanishes within one frame is not information — it is a flicker. Below this
 * the save is invisible, which is the correct report for "it already
 * finished"; above it the pill appears and stays until the save resolves.
 */
export const UPLOAD_PILL_DELAY_MS = 250;

/** One in-flight (or just-failed) image save — or one BATCH of them. */
interface PendingUpload {
    readonly id: string;
    /** Document position the paste happened at; mapped through every step. */
    pos: number;
    /** How many files this one pill stands for (MAR-281); 1 for a paste. */
    readonly count: number;
    /** Whether the save has outlived UPLOAD_PILL_DELAY_MS and earned a pill. */
    shown: boolean;
    /** Set once the save fails — the pill switches from progress to error. */
    error?: string;
    /** How many of `count` failed. Only meaningful alongside `error`. */
    failedCount?: number;
}

interface UploadState {
    readonly uploads: readonly PendingUpload[];
    readonly decorations: DecorationSet;
}

type UploadAction =
    | { kind: "begin"; id: string; pos: number; count: number }
    | { kind: "show"; id: string }
    | { kind: "settle"; id: string }
    | { kind: "fail"; id: string; error: string; failedCount: number };

/** "3" substituted into a whole translatable sentence, house `{0}` style. */
function withCount(key: string, count: number): string {
    return t(key).replace("{0}", String(count));
}

function progressWidget(upload: PendingUpload): HTMLElement {
    const el = document.createElement("span");
    el.className = "img-upload-pill";
    el.setAttribute("aria-live", "polite");
    el.append(Object.assign(document.createElement("span"), { className: "img-upload-pill__spinner" }));
    el.append(document.createTextNode(upload.count > 1
        ? withCount("Saving {0} images…", upload.count)
        : t("Saving image…")));
    return el;
}

function errorWidget(upload: PendingUpload, view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "ui-notice img-upload-pill img-upload-pill--error";
    el.setAttribute("role", "alert");
    // A batch reports how many of it failed — the rest were inserted, so
    // "Image not saved" alone would misdescribe what just happened.
    const failed = upload.failedCount ?? 1;
    el.append(document.createTextNode(
        (failed > 1 ? withCount("{0} images not saved: ", failed) : t("Image not saved: "))
        + upload.error));
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
        // A failure always reports, however fast it arrived; a still-running
        // save reports only once it has outlived the flicker threshold.
        .filter((u) => u.shown || u.error !== undefined)
        // A position can be mapped away entirely (the block was deleted while
        // the save ran); drop rather than throw.
        .filter((u) => u.pos >= 0 && u.pos <= doc.content.size)
        .map((u) =>
            Decoration.widget(u.pos, () => (u.error ? errorWidget(u, view) : progressWidget(u)), {
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
                    uploads = [...uploads, { id: action.id, pos: action.pos, count: action.count, shown: false }];
                } else if (action?.kind === "show") {
                    uploads = uploads.map((u) =>
                        u.id === action.id ? { ...u, shown: true } : u);
                } else if (action?.kind === "settle") {
                    uploads = uploads.filter((u) => u.id !== action.id);
                } else if (action?.kind === "fail") {
                    uploads = uploads.map((u) =>
                        u.id === action.id
                            ? { ...u, error: action.error, failedCount: action.failedCount }
                            : u);
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
 * Dispatches only into a live view. Every entry point here is reached from a
 * promise or a timer that can outlive the editor — closing the tab mid-save
 * would otherwise dispatch into a destroyed view and throw from a callback
 * nobody is catching.
 */
function dispatchIfLive(view: EditorView, action: UploadAction): void {
    if (view.isDestroyed) { return; }
    view.dispatch(view.state.tr.setMeta(imageUploadProgressKey, action));
}

/**
 * Marks an image save as started at the current selection and returns its
 * token. Never throws: a failure to show progress must not abort the save.
 *
 * `count` is how many files the token stands for — one drop of several images
 * is ONE pill, not a stack of identical ones over the same position.
 */
export function beginImageUpload(view: EditorView, at?: number, count = 1): string {
    const id = `upl${++counter}`;
    dispatchIfLive(view, { kind: "begin", id, pos: at ?? view.state.selection.from, count });
    // The position is tracked from NOW (that is the whole point — it must
    // follow edits made while the save runs), but the pill only appears if the
    // save is slow enough to be worth a report.
    setTimeout(() => {
        if (view.isDestroyed) { return; }
        const still = imageUploadProgressKey.getState(view.state)?.uploads
            .some((u) => u.id === id && !u.error);
        if (still) { dispatchIfLive(view, { kind: "show", id }); }
    }, UPLOAD_PILL_DELAY_MS);
    return id;
}

/** Clears an upload's chrome — on success, or when its error is dismissed. */
export function settleImageUpload(view: EditorView, id: string): void {
    dispatchIfLive(view, { kind: "settle", id });
}

/**
 * Turns an upload's progress pill into a dismissable error pill.
 * `failedCount` is how many of the batch failed — the remainder still land.
 */
export function failImageUpload(
    view: EditorView,
    id: string,
    error: string,
    failedCount = 1,
): void {
    dispatchIfLive(view, { kind: "fail", id, error, failedCount });
}

/**
 * Where a still-pending upload should insert, or null if it was cancelled or
 * its position was deleted while the save ran.
 */
export function uploadInsertPos(view: EditorView, id: string): number | null {
    if (view.isDestroyed) { return null; }
    const found = imageUploadProgressKey.getState(view.state)?.uploads.find((u) => u.id === id);
    if (!found) { return null; }
    return found.pos >= 0 && found.pos <= view.state.doc.content.size ? found.pos : null;
}
