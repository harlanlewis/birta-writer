/**
 * imageClient.ts
 *
 * WebView-side client for image operations that round-trip through the
 * Extension host. It manages the async request/response plumbing for:
 * - saving an image file to local disk (with timeout and error handling)
 * - listing the project's existing images
 * - renaming an image
 * - inserting / updating an image node in the ProseMirror editor
 *
 * Every request is correlated with its response by a generated id. Images are
 * always saved locally by the Extension — this client never talks to a remote
 * service.
 */

import type { Editor } from "@milkdown/core";
import { editorViewCtx } from "@milkdown/core";
import {
    notifySaveImage,
    notifyGetProjectImages,
    notifyRenameImage,
} from "./messaging";

// ── Save image: pending promise map ──────────────────
type SaveCallbacks = {
    resolve: (url: string) => void;
    reject: (e: Error) => void;
};
const _pendingSaves = new Map<string, SaveCallbacks>();

// ── Get project images: pending promise map ──────────
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

// ── Rename image: pending promise map ────────────────
type RenameCallbacks = { resolve: () => void; reject: (e: Error) => void };
const _pendingRenames = new Map<string, RenameCallbacks>();

export async function handleRenameImage(
    webviewUri: string,
    newBasename: string,
): Promise<void> {
    const id = `rename_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
            if (!settled) {
                settled = true;
                _pendingRenames.delete(id);
                reject(new Error("Rename timed out"));
            }
        }, 15000);
        _pendingRenames.set(id, {
            resolve: () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutId);
                    resolve();
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
        notifyRenameImage(id, webviewUri, newBasename);
    });
}

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

/**
 * Read a local image File and ask the Extension to save it to disk, resolving
 * with the WebView-accessible URI of the saved file.
 */
export async function saveImageFile(file: File, altText: string): Promise<string> {
    const id = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<string>((resolve, reject) => {
        _pendingSaves.set(id, { resolve, reject });
        const timeoutId = setTimeout(() => {
            if (_pendingSaves.has(id)) {
                _pendingSaves.delete(id);
                reject(new Error("Save timed out"));
            }
        }, 30000);
        // Read the file into a Uint8Array, then hand it to the Extension.
        const reader = new FileReader();
        reader.onload = () => {
            const data = new Uint8Array(reader.result as ArrayBuffer);
            notifySaveImage(id, data, file.type, altText);
        };
        reader.onerror = () => {
            clearTimeout(timeoutId);
            _pendingSaves.delete(id);
            reject(new Error("Failed to read file"));
        };
        reader.readAsArrayBuffer(file);
    });
}

export function insertImageNode(currentEditor: Editor | null, src: string, alt: string): void {
    if (!currentEditor) {
        return;
    }
    currentEditor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const imageType = state.schema.nodes["image"];
        if (!imageType) {
            return;
        }
        const node = imageType.create({ src, alt, title: "" });
        view.dispatch(state.tr.replaceSelectionWith(node));
        view.focus();
    });
}

/** Handle the "image saved" response. */
export function handleImageSaved(id: string, url: string): void {
    const cb = _pendingSaves.get(id);
    if (cb) {
        _pendingSaves.delete(id);
        cb.resolve(url);
    }
}

/** Handle the "image save failed" response. */
export function handleImageSaveError(id: string, error: string): void {
    const cb = _pendingSaves.get(id);
    if (cb) {
        _pendingSaves.delete(id);
        cb.reject(new Error(error));
    }
}

/** Handle the project-images list response. */
export function handleProjectImagesList(id: string, images: Array<{ relPath: string; webviewUri: string; name: string }>): void {
    const cb = _pendingGetImages.get(id);
    if (cb) {
        _pendingGetImages.delete(id);
        cb.resolve(images);
    }
}

/** Handle the image-renamed response. */
export function handleImageRenamed(id: string): void {
    const cb = _pendingRenames.get(id);
    if (cb) {
        _pendingRenames.delete(id);
        cb.resolve();
    }
}

/** Handle the image-rename-failed response. */
export function handleImageRenameError(id: string, error: string): void {
    const cb = _pendingRenames.get(id);
    if (cb) {
        _pendingRenames.delete(id);
        cb.reject(new Error(error));
    }
}
