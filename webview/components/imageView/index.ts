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
    IconX,
    IconImageOff,
} from "@/ui/icons";
import { t } from "@/i18n";
import { createButton, createSeparator, setupApplyOnBlur } from "@/ui/dom";
import { applyTooltip } from "@/ui/tooltip";
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
    // The markdown title (`![alt](src "title")`) is a hover tooltip in
    // published HTML — surface it the same way here
    img.title = (node.attrs["title"] as string) ?? "";
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

    // ── Alt-text caption (always visible when non-empty; edits apply to the doc on blur) ──
    const caption = document.createElement("input");
    caption.type = "text";
    caption.className = "image-caption img-quiet-input";
    caption.placeholder = t("Alt text");
    caption.setAttribute("aria-label", t("Alt text"));
    isolateInput(caption);
    const detachCaptionUndo = attachInputUndo(caption);

    function updateCaption(alt: string): void {
        // Sync only when the input isn't focused (to avoid overwriting what the user is editing)
        if (document.activeElement !== caption) {
            caption.value = alt;
        }
        caption.classList.toggle("image-caption--filled", alt.length > 0);
    }

    /** Commit an input's trimmed value into one node attr (no-op if unchanged). */
    function commitAttr(
        input: HTMLInputElement,
        attr: "alt" | "title",
        sync: (value: string) => void,
    ): void {
        const newValue = input.value.trim();
        const oldValue = (currentNode.attrs[attr] as string) ?? "";
        if (newValue === oldValue) {
            sync(oldValue);
            return;
        }
        const pos = getPos();
        if (pos === undefined) {
            sync(oldValue);
            return;
        }
        view.dispatch(
            view.state.tr.setNodeMarkup(pos, null, {
                ...currentNode.attrs,
                [attr]: newValue,
            }),
        );
    }

    setupApplyOnBlur(caption, {
        commit: () => commitAttr(caption, "alt", updateCaption),
        revert: () => {
            caption.value = (currentNode.attrs["alt"] as string) ?? "";
        },
        onClose: () => view.focus(),
    });

    // ── Toolbar: a controls row + an always-visible title row ─
    const toolbar = document.createElement("div");
    toolbar.className = "image-toolbar";
    toolbar.contentEditable = "false";

    const toolbarRow = document.createElement("div");
    toolbarRow.className = "image-toolbar-row";

    // Zoom button
    const zoomBtn = makeBtn(IconZoomIn, t("View Full Size"));
    zoomBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showGlobalLightbox(img.src, img.alt);
    });

    // File-name chip with a pencil: click to edit the image path (src attribute)
    const editPathBtn = document.createElement("button");
    editPathBtn.className = "img-tb-btn img-tb-path";
    editPathBtn.tabIndex = -1;
    editPathBtn.setAttribute("aria-label", t("Edit Image Path"));
    const pathName = document.createElement("span");
    pathName.className = "img-tb-path-name";
    editPathBtn.appendChild(pathName);
    const pathPencil = document.createElement("span");
    pathPencil.className = "img-tb-path-pencil";
    pathPencil.innerHTML = IconPencil;
    editPathBtn.appendChild(pathPencil);
    const pathTooltip = applyTooltip(editPathBtn, t("Edit Image Path"), { placement: "above" });
    editPathBtn.addEventListener("mousedown", (e) => {
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

    function updateInfo(src: string): void {
        const name = src.split("/").pop() ?? src;
        pathName.textContent = name;
        pathTooltip.setText(`${toDisplayPath(src)} — ${t("Edit Image Path")}`);
    }

    // ── Title row: always visible in the toolbar; edits the markdown
    //    title (`![alt](src "title")`), which renders as the hover tooltip ──
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "img-tb-title img-quiet-input";
    titleInput.placeholder = t("Title (shown on hover)");
    titleInput.setAttribute("aria-label", t("Image title"));
    isolateInput(titleInput);
    const detachTitleUndo = attachInputUndo(titleInput);

    function updateTitleField(title: string): void {
        // Sync only when the input isn't focused (to avoid overwriting what the user is editing)
        if (document.activeElement !== titleInput) {
            titleInput.value = title;
        }
    }

    setupApplyOnBlur(titleInput, {
        commit: () => commitAttr(titleInput, "title", updateTitleField),
        revert: () => {
            titleInput.value = (currentNode.attrs["title"] as string) ?? "";
        },
        onClose: () => view.focus(),
    });

    // ── Assemble the toolbar ──────────────────────────────────
    toolbarRow.appendChild(editPathBtn);
    toolbarRow.appendChild(makeSep());
    toolbarRow.appendChild(zoomBtn);
    toolbarRow.appendChild(makeSep());
    toolbarRow.appendChild(deleteBtn);
    toolbar.appendChild(toolbarRow);
    toolbar.appendChild(titleInput);

    wrapper.appendChild(img);
    wrapper.appendChild(errorPlaceholder);
    wrapper.appendChild(caption);
    wrapper.appendChild(toolbar);

    // ── Initialize the info area, caption, and title row ──────
    let rawSrc = (node.attrs["src"] as string) ?? "";
    updateInfo(rawSrc);
    updateCaption(img.alt);
    updateTitleField(img.title);

    // ── Edit the image path (src attribute) ───────────────────
    let isEditingSrc = false;

    function startSrcEdit(): void {
        if (isEditingSrc) {
            return;
        }
        isEditingSrc = true;

        const input = document.createElement("input");
        // img-path-input is a selector hook for tests only; img-rename-input styles it
        input.className = "img-rename-input img-path-input";
        // Show the relative path (rawSrc may be a webviewUri, which is more readable once converted)
        input.value = toDisplayPath(rawSrc);
        input.placeholder = t("Image path or URL");
        input.style.width = "240px";
        isolateInput(input);
        const detachSrcUndo = attachInputUndo(input);

        Array.from(toolbarRow.children).forEach((el) => {
            (el as HTMLElement).style.display = "none";
        });

        toolbarRow.appendChild(input);
        input.focus();
        input.select();
        const detachComplete = attachImgPathComplete(input, () => confirm(true), cancel);
        input.addEventListener("blur", onBlur);

        function onBlur(): void {
            // Delay so a dropdown selection (which keeps focus on the input)
            // never commits a half-applied value
            setTimeout(() => {
                if (isEditingSrc && document.activeElement !== input) {
                    confirm(false);
                }
            }, 150);
        }

        function confirm(refocus: boolean): void {
            if (!isEditingSrc) { return; }
            const displayVal = input.value.trim();
            // 1. The webviewUri stored in dataset during completion is the most reliable
            const datasetUri = (input.dataset.imgWebviewUri ?? "").trim();
            // 2. An existing mapping (established on init/revert)
            const mappedUri = displayVal ? toWebviewUri(displayVal) : "";
            isEditingSrc = false;
            cleanup();

            const applyUri = (newSrc: string) => {
                if (!newSrc || newSrc === rawSrc) {
                    if (refocus) { view.focus(); }
                    return;
                }
                const pos = getPos();
                if (pos === undefined) {
                    if (refocus) { view.focus(); }
                    return;
                }
                const nodeSize = currentNode.nodeSize;
                const tr = view.state.tr.setNodeMarkup(pos, null, { ...currentNode.attrs, src: newSrc });
                const afterPos = pos + nodeSize;
                if (afterPos <= tr.doc.content.size) {
                    try { tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos), 1)); } catch { /* ignore */ }
                }
                view.dispatch(tr);
                if (refocus) { view.focus(); }
            };

            if (datasetUri) {
                // Chosen from completion: use it directly
                applyUri(datasetUri);
            } else if (mappedUri !== displayVal) {
                // Mapping hit (mappedUri is a webviewUri, different from displayVal)
                applyUri(mappedUri);
            } else if (displayVal && displayVal !== toDisplayPath(rawSrc)) {
                // A new path typed manually: ask the Extension to resolve it
                resolveToWebviewUri(displayVal).then(applyUri);
            } else if (refocus) {
                view.focus();
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
            input.removeEventListener("blur", onBlur);
            if (toolbarRow.contains(input)) toolbarRow.removeChild(input);
            Array.from(toolbarRow.children).forEach((el) => {
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
            }
            if (img.alt !== newAlt) {
                img.alt = newAlt;
            }
            const newTitle = (updatedNode.attrs["title"] as string) ?? "";
            if (img.title !== newTitle) {
                img.title = newTitle;
            }
            updateInfo(rawSrc);
            updateCaption(newAlt);
            updateTitleField(newTitle);
            currentNode = updatedNode;
            return true;
        },

        selectNode(): void {
            wrapper.classList.add("image-wrapper--selected");
            toolbar.style.display = "flex";

            // If the toolbar would extend past the top of the viewport, show
            // it below the image instead. Measured, not hardcoded: the
            // toolbar is two rows tall and grows if more rows are added.
            const rect = wrapper.getBoundingClientRect();
            const clearance = toolbar.offsetHeight + 10; // 6px gap + margin
            toolbar.classList.toggle("image-toolbar--below", rect.top < clearance);
        },

        deselectNode(): void {
            wrapper.classList.remove("image-wrapper--selected");
            toolbar.style.display = "none";
        },

        stopEvent(e: Event): boolean {
            // Events inside the toolbar (buttons, inputs) and the caption are kept from ProseMirror
            const target = e.target as Node;
            return toolbar.contains(target) || caption.contains(target);
        },

        ignoreMutation(_m: ViewMutationRecord): boolean {
            // No contentDOM; every DOM change is UI-layer only, so ProseMirror doesn't need to know
            return true;
        },

        destroy(): void {
            detachCaptionUndo();
            detachTitleUndo();
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
