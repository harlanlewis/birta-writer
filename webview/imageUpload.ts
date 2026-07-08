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

import type { Editor } from "@milkdown/core";
import { editorViewCtx } from "@milkdown/core";
import {
    notifyUploadImage,
    notifyGetProjectImages,
} from "./messaging";

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

