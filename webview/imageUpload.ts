/**
 * imageUpload.ts
 *
 * Responsibility: manage the async operations for image upload and fetching
 * the project's image list.
 *
 * This module wraps the Promise bookkeeping for talking to the Extension, including:
 * - Image file upload (with timeout and error handling)
 * - Fetching the project's image list
 * - Inserting/updating image nodes in the ProseMirror editor
 */

import type { EditorView, Node as PMNode } from "./pm";
import {
    notifyUploadImage,
    notifyGetProjectImages,
} from "./messaging";
import {
    beginImageUpload,
    failImageUpload,
    settleImageUpload,
    uploadInsertPos,
} from "./plugins/imageUploadProgress";

// ── Image upload: pending promise map ────────────────────
type UploadCallbacks = {
    resolve: (url: string) => void;
    reject: (e: Error) => void;
};
const _pendingUploads = new Map<string, UploadCallbacks>();

// ── Fetch project image list: pending promise map ────────────
type GetImagesCallbacks = {
    resolve: (
        images: Array<{
            relPath: string;
            webviewUri: string;
            name: string;
        }> | null,
    ) => void;
    reject: (e: Error) => void;
};
const _pendingGetImages = new Map<string, GetImagesCallbacks>();

export async function handleGetProjectImages(
    _unusedId: string,
): Promise<Array<{
    relPath: string;
    webviewUri: string;
    name: string;
}> | null> {
    const id = `gimgs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
            if (!settled) {
                settled = true;
                _pendingGetImages.delete(id);
                resolve(null);
            }
        }, 10000);
        _pendingGetImages.set(id, {
            resolve: (r) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    resolve(r);
                }
            },
            reject: (e) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    reject(e);
                }
            },
        });
        notifyGetProjectImages(id);
    });
}

export async function handleImageFile(file: File, altText: string): Promise<string> {
    const id = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<string>((resolve, reject) => {
        _pendingUploads.set(id, { resolve, reject });
        const timeoutId = setTimeout(() => {
            if (_pendingUploads.has(id)) {
                _pendingUploads.delete(id);
                reject(new Error("Upload timed out"));
            }
        }, 30000);
        // Read the file as a Uint8Array, then send it to the Extension
        const reader = new FileReader();
        reader.onload = () => {
            const data = new Uint8Array(reader.result as ArrayBuffer);
            notifyUploadImage(id, data, file.type, altText);
        };
        reader.onerror = () => {
            clearTimeout(timeoutId);
            _pendingUploads.delete(id);
            reject(new Error("Failed to read file"));
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * `image` is an INLINE node, so a standalone image is really an image-only
 * paragraph (see plugins/imageBlocks). At a block boundary — which is what a
 * drop aims at — each image therefore gets a paragraph of its own, so three
 * dropped files become three stacked image blocks rather than one paragraph
 * holding a row of them. At an inline position (the fallback when a drop had
 * no aim, and where a paste lands) they stay inline, where the caret is.
 *
 * Doing this explicitly rather than leaving it to ProseMirror's fitting
 * algorithm is what makes the multi-image shape predictable; for a single
 * image the two agree.
 */
function imageContentFor(view: EditorView, at: number, images: PMNode[]): PMNode[] {
    const paragraph = view.state.schema.nodes["paragraph"];
    if (!paragraph) { return images; }
    const $at = view.state.doc.resolve(at);
    // Inline landing, or a container the schema won't let hold a paragraph:
    // hand back the bare images and let the fitting algorithm place them.
    if ($at.parent.inlineContent
        || !$at.parent.canReplaceWith($at.index(), $at.index(), paragraph)) {
        return images;
    }
    return images.map((img) => paragraph.create(null, img));
}

/** An Error's message, or whatever the rejection actually was. */
function reasonText(reason: unknown): string {
    return String((reason as Error | undefined)?.message ?? reason);
}

/**
 * The whole pasted/dropped-image flow, with its chrome (MAR-21 item 4): show
 * that a save is running at the paste position, then insert the images THERE —
 * not at the live caret, which may have moved while the saves were in flight —
 * or surface the failure in place.
 *
 * The progress/error chrome is decoration only (plugins/imageUploadProgress),
 * so a failed save leaves the document exactly as it was, with nothing to
 * clean up and no junk step in the undo history.
 *
 * **Why the whole batch waits (MAR-281).** The saves resolve independently and
 * out of order, so inserting each as it lands would put the images in
 * COMPLETION order rather than drag order — the load-bearing reason, and the
 * one a fast machine never reveals. Collecting them first costs the batch the
 * latency of its slowest file (a local write, single-digit milliseconds, with
 * the progress pill covering the wait) and buys drag order back.
 *
 * It also makes "one gesture, one undo step" unconditional. Note that this is
 * a *smaller* win than it looks: ProseMirror's history already groups
 * transactions less than its `newGroupDelay` (500 ms) apart, so per-file
 * inserts would usually collapse into one step anyway — measured, not assumed
 * (a per-file mutant passes an undo assertion that doesn't space its saves
 * out). What batching adds is the case where it matters: saves slow enough to
 * straddle that window, where a naive loop leaves the user undoing one image
 * at a time.
 *
 * A partial failure degrades rather than aborting: the files that saved are
 * inserted, and the pill reports how many didn't.
 */
export function saveAndInsertImagesAt(
    view: EditorView,
    files: readonly File[],
    altText: string,
    at: number,
): void {
    if (files.length === 0) { return; }
    const token = beginImageUpload(view, at, files.length);
    // The alt is lifted off the payload's FIRST `<img>`, which describes the
    // first file; the rest of a multi-file drag carries no description at all.
    const altFor = (i: number): string => (i === 0 ? altText : "");
    void Promise.allSettled(files.map((file, i) => handleImageFile(file, altFor(i))))
        .then((results) => {
            // Read before anything is dispatched. Null when the paste position
            // was deleted while the saves ran: the bytes are on disk either
            // way, we just have nowhere honest to put the references.
            const pos = uploadInsertPos(view, token);
            const rejected = results.filter((r) => r.status === "rejected");
            let failedCount = rejected.length;
            let reason = failedCount > 0
                ? reasonText((rejected[0] as PromiseRejectedResult).reason)
                : "";

            const imageType = view.state.schema.nodes["image"];
            const images = imageType
                ? results.flatMap((r, i) =>
                    r.status === "fulfilled"
                        ? [imageType.create({ src: r.value, alt: altFor(i), title: "" })]
                        : [])
                : [];
            if (pos !== null && images.length > 0) {
                try {
                    view.dispatch(view.state.tr.insert(pos, imageContentFor(view, pos, images)));
                    view.focus();
                } catch (e) {
                    // The document refused the landing. Say so where the user
                    // dropped, rather than letting the whole batch disappear
                    // into an unhandled rejection.
                    failedCount = files.length;
                    reason = reasonText(e);
                }
            }

            // Last, so the insert above has already carried the pill's tracked
            // position past the images it made room for.
            if (failedCount === 0) {
                settleImageUpload(view, token);
            } else {
                failImageUpload(view, token, reason, failedCount);
            }
        })
        // Nothing above should reject, but a save that vanishes without a word
        // is the bug this whole path exists to prevent — so it gets a net.
        .catch((e: unknown) => failImageUpload(view, token, reasonText(e), files.length));
}

/** Handle the image upload response */
export function handleImageUploaded(id: string, url: string): void {
    const cb = _pendingUploads.get(id);
    if (cb) {
        _pendingUploads.delete(id);
        cb.resolve(url);
    }
}

/** Handle an image upload error */
export function handleImageUploadError(id: string, error: string): void {
    const cb = _pendingUploads.get(id);
    if (cb) {
        _pendingUploads.delete(id);
        cb.reject(new Error(error));
    }
}

/** Handle the project image list response */
export function handleProjectImagesList(id: string, images: Array<{ relPath: string; webviewUri: string; name: string }>): void {
    const cb = _pendingGetImages.get(id);
    if (cb) {
        _pendingGetImages.delete(id);
        cb.resolve(images);
    }
}

