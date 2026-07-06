import type { Node as PMNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import type {
    Decoration,
    DecorationSource,
    EditorView,
} from "@milkdown/prose/view";
import {
    IconZoomIn,
    IconPencil,
    IconTrash2,
    IconCheck,
    IconX,
    IconImageOff,
} from "@/ui/icons";
import { t } from "@/i18n";
import { createButton, createSeparator, setupInputKeyboard } from "@/ui/dom";
import { attachImgPathComplete, resolveToWebviewUri } from './imgPathComplete';
import { attachInputUndo } from "@/utils/inputUndo";
import './imageView.css';

// ─── webviewUri ↔ relPath bidirectional map (written by index.ts when init/revert messages arrive) ─────
const _uriToRel = new Map<string, string>(); // webviewUri → relPath
const _relToUri = new Map<string, string>(); // relPath    → webviewUri

/** Called from outside (index.ts) after imageUriMap arrives on init/revert */
export function setImageUriMap(map: Record<string, string>): void {
    _uriToRel.clear();
    _relToUri.clear();
    for (const [uri, rel] of Object.entries(map)) {
        _uriToRel.set(uri, rel);
        _relToUri.set(rel, uri);
    }
}

/** Convert a webviewUri to a displayable relPath (returns the input as-is if not found) */
function toDisplayPath(src: string): string {
    return _uriToRel.get(src) ?? src;
}

/** Convert a relPath to a webviewUri that renders directly in the NodeView (returns the input as-is if not found) */
function toWebviewUri(src: string): string {
    return _relToUri.get(src) ?? src;
}

type ViewMutationRecord = MutationRecord | { type: "selection"; target: Node };

// ─── Lightbox ──────────────────────────────────────────────
let activeLightbox: HTMLElement | null = null;

function showGlobalLightbox(src: string, alt: string): void {
    if (activeLightbox) {
        return;
    }

    const lb = document.createElement("div");
    lb.className = "img-editor-lightbox";

    const img = document.createElement("img");
    img.className = "img-editor-lightbox-img";
    img.src = src;
    img.alt = alt;

    const closeBtn = document.createElement("button");
    closeBtn.className = "img-editor-lightbox-close";
    closeBtn.innerHTML = IconX;
    closeBtn.title = t("Close");

    lb.appendChild(img);
    lb.appendChild(closeBtn);
    document.body.appendChild(lb);
    activeLightbox = lb;

    function close(): void {
        if (activeLightbox && document.body.contains(activeLightbox)) {
            document.body.removeChild(activeLightbox);
        }
        activeLightbox = null;
        document.removeEventListener("keydown", onKeyDown);
    }

    function onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    }

    lb.addEventListener("mousedown", (e) => {
        if (e.target === lb) {
            close();
        }
    });
    closeBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
    });
    document.addEventListener("keydown", onKeyDown);
}

// ─── Stop input events from bubbling to ProseMirror ───────
// ProseMirror listens for copy/cut/paste/keydown, etc. on view.dom, so
// clipboard actions inside the input bubble up and get intercepted
// (ProseMirror's copy handler calls preventDefault).
// Stop these events from bubbling at the input, so the browser's native behavior fires normally.
function isolateInput(input: HTMLInputElement): void {
    const stopOnly = (e: Event) => e.stopPropagation();
    input.addEventListener("copy", stopOnly);
    input.addEventListener("cut", stopOnly);
    input.addEventListener("paste", stopOnly);
    input.addEventListener("mousedown", stopOnly);
    input.addEventListener("click", stopOnly);
    input.addEventListener("select", stopOnly);
    // Note: do NOT stopPropagation on keydown here —
    // the VS Code WebView relies on keydown bubbling to window to trigger native clipboard actions
}

// ─── Helper: extract the file name (without extension) from src ───────────────
function basenameNoExt(src: string): string {
    const name = src.split("/").pop() ?? src;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

// ─── Toolbar button factory ────────────────────────────────
function makeBtn(icon: string, label: string): HTMLButtonElement {
    return createButton({ className: "img-tb-btn", icon, tabIndex: -1, title: label, tooltipPlacement: "above" });
}

function makeSep(): HTMLElement {
    return createSeparator("img-tb-sep", "span");
}

// ─── NodeView factory ──────────────────────────────────────
export function createImageView(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    _decorations?: readonly Decoration[],
    _innerDecorations?: DecorationSource,
    onRenameImage?: (webviewUri: string, newBasename: string) => Promise<void>,
): {
    dom: HTMLElement;
    update: (n: PMNode) => boolean;
    selectNode: () => void;
    deselectNode: () => void;
    stopEvent: (e: Event) => boolean;
    ignoreMutation: (m: ViewMutationRecord) => boolean;
    destroy: () => void;
} {
    let currentNode = node;

    // ── Outer wrapper ─────────────────────────────────────────
    const wrapper = document.createElement("div");
    wrapper.className = "image-wrapper";

    // ── Image ─────────────────────────────────────────────────
    const img = document.createElement("img");
    img.className = "image-node";
    img.src = (node.attrs["src"] as string) ?? "";
    img.alt = (node.attrs["alt"] as string) ?? "";
    img.draggable = false;

    // ── Image load-failure placeholder ────────────────────────
    let imgErrored = false;
    const errorPlaceholder = document.createElement("div");
    errorPlaceholder.className = "img-error-placeholder";
    errorPlaceholder.style.display = "none";

    img.addEventListener("error", () => {
        imgErrored = true;
        img.style.display = "none";
        errorPlaceholder.innerHTML = `${IconImageOff}<span>${t("Image not found")}</span>`;
        errorPlaceholder.style.display = "flex";
    });

    img.addEventListener("load", () => {
        if (imgErrored) {
            imgErrored = false;
            img.style.display = "";
            errorPlaceholder.style.display = "none";
        }
    });

    // ── Toolbar ───────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "image-toolbar";
    toolbar.contentEditable = "false";

    // Zoom button
    const zoomBtn = makeBtn(IconZoomIn, t("View Full Size"));
    zoomBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showGlobalLightbox(img.src, img.alt);
    });

    // Alt text editing
    const altBtn = createButton({
        className: "img-tb-btn",
        tabIndex: -1,
        label: "ALT",
        title: t("Edit Alt Text"),
        tooltipPlacement: "above",
        onClick: () => startAltEdit(),
    });
    altBtn.style.fontWeight = "600";

    // Pencil icon: always shown; click to edit the image path (src attribute)
    const renameBtn = makeBtn(IconPencil, t("Edit Image Path"));
    renameBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startSrcEdit();
    });

    // Delete button
    const deleteBtn = makeBtn(IconTrash2, t("Delete"));
    deleteBtn.style.color = "var(--vscode-errorForeground, #f44)";
    deleteBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = getPos();
        if (pos === undefined) {
            return;
        }
        view.dispatch(view.state.tr.delete(pos, pos + currentNode.nodeSize));
        view.focus();
    });

    // ── Info area: span (read-only, remote images) + input (editable file name, local images) ──
    const infoSpan = document.createElement("span");
    infoSpan.className = "img-tb-info";

    const infoInput = document.createElement("input");
    infoInput.type = "text";
    infoInput.className = "img-tb-info img-tb-info--input";
    isolateInput(infoInput);
    // Local undo/redo: VS Code intercepts Cmd+Z before native inputs see it
    const detachInfoUndo = attachInputUndo(infoInput);

    let currentInfoEl: HTMLElement = infoSpan;

    function updateInfo(src: string, alt: string): void {
        const name = src.split("/").pop() ?? src;
        const display = alt ? `${name} · ${alt}` : name;
        infoSpan.textContent = display;
        infoSpan.title = display;
        // Sync only when the input isn't focused (to avoid overwriting what the user is editing)
        if (document.activeElement !== infoInput) {
            infoInput.value = basenameNoExt(src);
            infoInput.title = name;
        }
    }

    // Local-image detection: vscode-webview-resource: (old) or vscode-cdn.net / vscode-resource (new)
    function isLocalImage(src: string): boolean {
        return /vscode-resource|vscode-cdn\.net/.test(src);
    }

    function updateInfoElement(src: string): void {
        const shouldUseInput = isLocalImage(src) && !!onRenameImage;
        const newEl = shouldUseInput ? infoInput : infoSpan;
        if (currentInfoEl !== newEl && currentInfoEl.parentElement) {
            currentInfoEl.parentElement.replaceChild(newEl, currentInfoEl);
            currentInfoEl = newEl;
        }
    }

    // infoInput keyboard events (rename the local image's file name)
    infoInput.addEventListener("keydown", (e) => {
        if (e.isComposing) {
            return;
        }
        if (e.key === "Enter") {
            e.stopPropagation();
            e.preventDefault();
            const newBasename = infoInput.value.trim();
            const orig = basenameNoExt(rawSrc);
            if (newBasename && newBasename !== orig && onRenameImage) {
                onRenameImage(rawSrc, newBasename).catch(() => {});
            } else {
                infoInput.value = orig;
            }
            infoInput.blur();
            view.focus();
        } else if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            infoInput.value = basenameNoExt(rawSrc);
            infoInput.blur();
            view.focus();
        }
    });

    infoInput.addEventListener("blur", () => {
        // Restore the original value if blur happens without a commit
        infoInput.value = basenameNoExt(rawSrc);
    });

    infoInput.addEventListener("focus", () => {
        infoInput.select();
    });

    // ── Assemble the toolbar (fixed layout; renameBtn always present) ────────────────
    toolbar.appendChild(currentInfoEl); // initially infoSpan
    toolbar.appendChild(makeSep());
    toolbar.appendChild(zoomBtn);
    toolbar.appendChild(makeSep());
    toolbar.appendChild(altBtn);
    toolbar.appendChild(makeSep());
    toolbar.appendChild(renameBtn);     // always present
    toolbar.appendChild(makeSep());
    toolbar.appendChild(deleteBtn);

    wrapper.appendChild(img);
    wrapper.appendChild(errorPlaceholder);
    wrapper.appendChild(toolbar);

    // ── Initialize the info area ──────────────────────────────
    let rawSrc = (node.attrs["src"] as string) ?? "";
    updateInfo(rawSrc, img.alt);
    updateInfoElement(rawSrc); // may replace infoSpan with infoInput

    // ── Inline Alt-text editing ───────────────────────────────
    let isEditingAlt = false;

    function startAltEdit(): void {
        if (isEditingAlt) {
            return;
        }
        isEditingAlt = true;

        const input = document.createElement("input");
        input.className = "img-rename-input";
        input.value = img.alt;
        input.placeholder = t("Alt text");
        input.style.width = "160px";
        isolateInput(input);
        const detachAltUndo = attachInputUndo(input);

        const confirmBtn = createButton({ className: "img-tb-btn", tabIndex: -1, icon: IconCheck, onClick: confirm });
        confirmBtn.style.color = "var(--vscode-charts-green, #4caf50)";
        const cancelBtn = createButton({ className: "img-tb-btn", tabIndex: -1, icon: IconX, onClick: cancel });

        // Temporarily hide the other buttons
        Array.from(toolbar.children).forEach((el) => {
            (el as HTMLElement).style.display = "none";
        });

        toolbar.appendChild(input);
        toolbar.appendChild(confirmBtn);
        toolbar.appendChild(cancelBtn);
        input.focus();
        input.select();
        setupInputKeyboard(input, confirm, cancel);

        function confirm(): void {
            if (!isEditingAlt) {
                return;
            }
            isEditingAlt = false;
            const newAlt = input.value.trim();
            cleanupAlt();
            if (newAlt !== currentNode.attrs["alt"]) {
                const pos = getPos();
                if (pos !== undefined) {
                    view.dispatch(
                        view.state.tr.setNodeMarkup(pos, null, {
                            ...currentNode.attrs,
                            alt: newAlt,
                        }),
                    );
                }
            }
            view.focus();
        }

        function cancel(): void {
            if (!isEditingAlt) {
                return;
            }
            isEditingAlt = false;
            cleanupAlt();
            view.focus();
        }

        function cleanupAlt(): void {
            detachAltUndo();
            toolbar.removeChild(input);
            toolbar.removeChild(confirmBtn);
            toolbar.removeChild(cancelBtn);
            Array.from(toolbar.children).forEach((el) => {
                (el as HTMLElement).style.display = "";
            });
        }
    }

    // ── Edit the image path (src attribute) ───────────────────
    let isEditingSrc = false;

    function startSrcEdit(): void {
        if (isEditingSrc) {
            return;
        }
        isEditingSrc = true;

        const input = document.createElement("input");
        input.className = "img-rename-input";
        // Show the relative path (rawSrc may be a webviewUri, which is more readable once converted)
        input.value = toDisplayPath(rawSrc);
        input.placeholder = t("Image path or URL");
        input.style.width = "240px";
        isolateInput(input);
        const detachSrcUndo = attachInputUndo(input);

        const confirmBtn = createButton({ className: "img-tb-btn", tabIndex: -1, icon: IconCheck, onClick: confirm });
        confirmBtn.style.color = "var(--vscode-charts-green, #4caf50)";
        const cancelBtn = createButton({ className: "img-tb-btn", tabIndex: -1, icon: IconX, onClick: cancel });

        Array.from(toolbar.children).forEach((el) => {
            (el as HTMLElement).style.display = "none";
        });

        toolbar.appendChild(input);
        toolbar.appendChild(confirmBtn);
        toolbar.appendChild(cancelBtn);
        input.focus();
        input.select();
        const detachComplete = attachImgPathComplete(input, confirm, cancel);

        function confirm(): void {
            if (!isEditingSrc) { return; }
            const displayVal = input.value.trim();
            // 1. The webviewUri stored in dataset during completion is the most reliable
            const datasetUri = (input.dataset.imgWebviewUri ?? "").trim();
            // 2. An existing mapping (established on init/revert)
            const mappedUri = displayVal ? toWebviewUri(displayVal) : "";
            isEditingSrc = false;
            cleanup();

            const applyUri = (newSrc: string) => {
                if (!newSrc || newSrc === rawSrc) { view.focus(); return; }
                const pos = getPos();
                if (pos === undefined) { view.focus(); return; }
                const nodeSize = currentNode.nodeSize;
                const tr = view.state.tr.setNodeMarkup(pos, null, { ...currentNode.attrs, src: newSrc });
                const afterPos = pos + nodeSize;
                if (afterPos <= tr.doc.content.size) {
                    try { tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos), 1)); } catch { /* ignore */ }
                }
                view.dispatch(tr);
                view.focus();
            };

            if (datasetUri) {
                // Chosen from completion: use it directly
                applyUri(datasetUri);
            } else if (mappedUri !== displayVal) {
                // Mapping hit (mappedUri is a webviewUri, different from displayVal)
                applyUri(mappedUri);
            } else if (displayVal) {
                // A new path typed manually: ask the Extension to resolve it
                resolveToWebviewUri(displayVal).then(applyUri);
            }
        }

        function cancel(): void {
            if (!isEditingSrc) {
                return;
            }
            isEditingSrc = false;
            cleanup();
            view.focus();
        }

        function cleanup(): void {
            detachComplete();
            detachSrcUndo();
            if (toolbar.contains(input)) toolbar.removeChild(input);
            if (toolbar.contains(confirmBtn)) toolbar.removeChild(confirmBtn);
            if (toolbar.contains(cancelBtn)) toolbar.removeChild(cancelBtn);
            Array.from(toolbar.children).forEach((el) => {
                (el as HTMLElement).style.display = "";
            });
        }
    }

    // ── NodeView interface ────────────────────────────────────
    return {
        dom: wrapper,

        update(updatedNode: PMNode): boolean {
            if (updatedNode.type !== currentNode.type) {
                return false;
            }
            const newSrc = (updatedNode.attrs["src"] as string) ?? "";
            const newAlt = (updatedNode.attrs["alt"] as string) ?? "";
            if (rawSrc !== newSrc) {
                rawSrc = newSrc;
                img.src = newSrc;
                // Reset the error state so the browser retries loading the new src
                if (imgErrored) {
                    imgErrored = false;
                    img.style.display = "";
                    errorPlaceholder.style.display = "none";
                }
                updateInfoElement(newSrc);
            }
            if (img.alt !== newAlt) {
                img.alt = newAlt;
            }
            updateInfo(rawSrc, newAlt);
            currentNode = updatedNode;
            return true;
        },

        selectNode(): void {
            wrapper.classList.add("image-wrapper--selected");
            toolbar.style.display = "flex";

            // Check whether the toolbar extends past the top of the viewport; if so, show it below the image instead
            const rect = wrapper.getBoundingClientRect();
            if (rect.top < 60) {
                toolbar.classList.add("image-toolbar--below");
            } else {
                toolbar.classList.remove("image-toolbar--below");
            }
        },

        deselectNode(): void {
            wrapper.classList.remove("image-wrapper--selected");
            toolbar.style.display = "none";
        },

        stopEvent(e: Event): boolean {
            // Events inside the toolbar (buttons, inputs) are kept from ProseMirror
            return toolbar.contains(e.target as Node);
        },

        ignoreMutation(_m: ViewMutationRecord): boolean {
            // No contentDOM; every DOM change is UI-layer only, so ProseMirror doesn't need to know
            return true;
        },

        destroy(): void {
            detachInfoUndo();
            // Clean up the lightbox (if the one triggered by this image is still showing)
            if (activeLightbox && document.body.contains(activeLightbox)) {
                const lbImg = activeLightbox.querySelector("img");
                if (lbImg && lbImg.src === img.src) {
                    document.body.removeChild(activeLightbox);
                    activeLightbox = null;
                }
            }
        },
    };
}
