/**
 * imageUpload.ts
 * 
 * 职责：管理图片上传、获取项目图片列表、图片重命名的异步操作
 * 
 * 本模块封装了与 Extension 通信的 Promise 管理，包括：
 * - 图片文件上传（支持超时和错误处理）
 * - 获取项目图片列表
 * - 图片重命名
 * - 在 ProseMirror 编辑器中插入/更新图片节点
 */

import type { Editor } from "@milkdown/core";
import { editorViewCtx } from "@milkdown/core";
import {
    notifyUploadImage,
    notifyGetProjectImages,
    notifyRenameImage,
} from "./messaging";

// ── 图片上传：pending promise map ────────────────────
type UploadCallbacks = {
    resolve: (url: string) => void;
    reject: (e: Error) => void;
};
const _pendingUploads = new Map<string, UploadCallbacks>();

// ── 获取项目图片列表：pending promise map ────────────
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

// ── 图片重命名：pending promise map ──────────────────
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
        // 读取文件为 Uint8Array 后发送给 Extension
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

/** 处理图片上传响应 */
export function handleImageUploaded(id: string, url: string): void {
    const cb = _pendingUploads.get(id);
    if (cb) {
        _pendingUploads.delete(id);
        cb.resolve(url);
    }
}

/** 处理图片上传错误 */
export function handleImageUploadError(id: string, error: string): void {
    const cb = _pendingUploads.get(id);
    if (cb) {
        _pendingUploads.delete(id);
        cb.reject(new Error(error));
    }
}

/** 处理项目图片列表响应 */
export function handleProjectImagesList(id: string, images: Array<{ relPath: string; webviewUri: string; name: string }>): void {
    const cb = _pendingGetImages.get(id);
    if (cb) {
        _pendingGetImages.delete(id);
        cb.resolve(images);
    }
}

/** 处理图片重命名响应 */
export function handleImageRenamed(id: string): void {
    const cb = _pendingRenames.get(id);
    if (cb) {
        _pendingRenames.delete(id);
        cb.resolve();
    }
}

/** 处理图片重命名错误 */
export function handleImageRenameError(id: string, error: string): void {
    const cb = _pendingRenames.get(id);
    if (cb) {
        _pendingRenames.delete(id);
        cb.reject(new Error(error));
    }
}
