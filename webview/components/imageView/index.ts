import type { Node as PMNode } from "@/pm";
import { TextSelection } from "@/pm";
import type {
    Decoration,
    DecorationSource,
    EditorView,
} from "@/pm";
import {
    IconExpandHorizontal,
    IconShrinkHorizontal,
    IconMaximize2,
    IconPencil,
    IconImageOff,
} from "@/ui/icons";
import {
    applyBlockWidthClass,
    getBlockWidth,
    imageWidthAnchor,
    renameBlockWidthAnchor,
    setBlockWidth,
} from "@/blockWidth";
import { t } from "@/i18n";
import { setupApplyOnBlur } from "@/ui/dom";
import { applyTooltip } from "@/ui/tooltip";
import { createBlockControlsColumn, makeBlockControlButton } from "@/ui/blockControls";
import { attachImgPathComplete, resolveToWebviewUri } from './imgPathComplete';
import { attachInputUndo } from "@/utils/inputUndo";
import { openFullscreenSurface, type FullscreenSurface } from "@/ui/fullscreenSurface";
import { trackEditorReflow } from "@/ui/editorReflow";
import { safeAreaTop } from "@/utils/headingUtils";
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
// An image is an OBJECT, not a canvas: it has its own edges, and what those
// edges need behind them is contrast, so this opens on the scrim ground rather
// than the diagram surface's paper-coloured one. Everything else — the
// overlay, the Escape layer, the backdrop click, the body-scroll lock, the
// close button and its position — comes from the shared surface. Hand-rolling
// them here is what let this one silently skip lockBodyScroll for as long as
// it existed.
let activeLightbox: FullscreenSurface | null = null;

function showGlobalLightbox(src: string, alt: string): void {
    if (activeLightbox) {
        return;
    }

    const img = document.createElement("img");
    img.className = "img-editor-lightbox-img";
    img.src = src;
    img.alt = alt;

    const surface = openFullscreenSurface({
        ground: "scrim",
        title: alt,
        className: "img-editor-lightbox",
        onClose() { activeLightbox = null; },
    });
    surface.content.appendChild(img);
    activeLightbox = surface;
}

/**
 * Close the open lightbox if it is showing THIS image. Called from a NodeView's
 * destroy(), because a view can die with its lightbox open. It goes through the
 * surface's own close rather than removing the element, which is what leaves an
 * Escape-layer entry and a locked body scroll behind.
 */
function dismissLightboxFor(src: string): void {
    if (activeLightbox?.content.querySelector("img")?.src === src) {
        activeLightbox.close();
        activeLightbox = null;
    }
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

    // File-name chip with a pencil: click to edit the image path (src attribute)
    const editPathBtn = document.createElement("button");
    editPathBtn.className = "ui-btn img-tb-btn img-tb-path";
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

    // ── The control column (shared block-controls primitive): zoom, then
    // width — the image's key actions, outside the image's top-right like
    // every other rich block. Hover-revealed like all columns, pinned open
    // while the image is selected. No delete button: deletion belongs to the
    // block menu and the keyboard (Backspace on the selected image).
    const controls = createBlockControlsColumn(wrapper);
    const controlsCol = controls.el;

    const zoomControl = makeBlockControlButton({
        className: "img-bc-zoom",
        icon: IconMaximize2,
        label: t("View Fullscreen"),
        onClick: () => showGlobalLightbox(img.src, img.alt),
    });

    // Width cycle button (blockWidth.ts): Natural size → Fit column width →
    // Full width → back. Presentation-only — the markdown image syntax has no
    // width slot, and the store lives in the webview state bag. Anchored on
    // the DISPLAY path (webview URIs are session-scoped), re-anchored on src
    // edits in update(). Icon + tooltip name the NEXT state (the word-wrap
    // toggle's contract).
    const widthMode = (): "natural" | "fixed" | "full" => getBlockWidth(widthAnchor) ?? "natural";
    // In FULL-width page mode the cycle's third step (full = break out of a
    // fixed column) is identical to fit-column, so it drops out: the toggle
    // never offers a state the user can't see.
    const pageIsFullWidth = (): boolean => document.body.classList.contains("editor-width-auto");
    const widthControl = makeBlockControlButton({
        className: "img-tb-width",
        icon: IconExpandHorizontal,
        label: t("Fit Column Width"),
        onClick: () => {
            const mode = widthMode();
            setBlockWidth(
                widthAnchor,
                mode === "natural" ? "fixed"
                : mode === "fixed" && !pageIsFullWidth() ? "full"
                : null,
            );
            syncWidthBtn();
        },
    });
    function syncWidthBtn(): void {
        const mode = widthMode();
        applyBlockWidthClass(wrapper, mode === "natural" ? null : mode);
        widthControl.setVerb(
            mode === "full" || (mode === "fixed" && pageIsFullWidth())
                ? IconShrinkHorizontal
                : IconExpandHorizontal,
            mode === "natural" ? t("Fit Column Width")
            : mode === "fixed" && !pageIsFullWidth() ? t("Full Width")
            : t("Natural Size"),
        );
        widthControl.setOn(mode !== "natural");
    }

    // The strip mounts empty; both buttons attach on its first reveal
    // (ui/blockControls.ts) — including the selectNode pin below, whose
    // `.bc-col--shown` animates the strip and so trips the same trigger.
    controls.add(zoomControl.button, widthControl.button);

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

    // ── Assemble the toolbar (the EDITORS: path chip + title; the icon
    // actions live in the control column) ─────────────────────
    toolbarRow.appendChild(editPathBtn);
    toolbar.appendChild(toolbarRow);
    toolbar.appendChild(titleInput);

    wrapper.appendChild(img);
    wrapper.appendChild(errorPlaceholder);
    wrapper.appendChild(caption);
    wrapper.appendChild(toolbar);
    wrapper.appendChild(controlsCol);

    // ── Initialize the info area, caption, title row, and width ──────
    let rawSrc = (node.attrs["src"] as string) ?? "";
    let widthAnchor = imageWidthAnchor(toDisplayPath(rawSrc));
    updateInfo(rawSrc);
    updateCaption(img.alt);
    updateTitleField(img.title);
    syncWidthBtn();

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

    // Open the toolbar above the image, or below it when the space above is
    // inside the fixed chrome. The band ends at the chrome's bottom edge, not
    // at y=0 — measured from y=0 an image sitting just under the topbar kept
    // its toolbar above and drew it behind the bar, which paints over it.
    function placeToolbar(): void {
        const rect = wrapper.getBoundingClientRect();
        const clearance = toolbar.offsetHeight + 10; // 6px gap + margin
        toolbar.classList.toggle(
            "image-toolbar--below",
            rect.top - safeAreaTop() < clearance,
        );
    }

    let reflowOff: (() => void) | null = null;

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
                // Carry a stored width preference across the src edit.
                const newAnchor = imageWidthAnchor(toDisplayPath(newSrc));
                if (newAnchor !== widthAnchor) {
                    renameBlockWidthAnchor(widthAnchor, newAnchor);
                    widthAnchor = newAnchor;
                    syncWidthBtn();
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
            // The hover-revealed control column stays pinned open while the
            // image is selected. Reveal explicitly rather than leaning on the
            // strip's opacity transition: a NodeSelection can land here in the
            // same frame the view mounts, before the strip has a previous
            // computed style to animate from, and then no `transitionrun`
            // would ever fire.
            controls.reveal();
            controlsCol.classList.add("bc-col--shown");

            placeToolbar();
            // The side that fits is a function of where the image is on
            // screen, so it has to be re-asked as the content moves under it —
            // decided once at selection, scrolling the image up under the
            // topbar left the toolbar in `above` mode and hid it behind the bar.
            reflowOff ??= trackEditorReflow(view.dom, placeToolbar);
        },

        deselectNode(): void {
            wrapper.classList.remove("image-wrapper--selected");
            toolbar.style.display = "none";
            controlsCol.classList.remove("bc-col--shown");
            reflowOff?.();
            reflowOff = null;
        },

        stopEvent(e: Event): boolean {
            // Events inside the toolbar (buttons, inputs), the caption, and
            // the column's BUTTONS are kept from ProseMirror. The column's
            // bare hit strip is not: it spans the block's right side as a
            // hover target, and clicks there should still reach the editor
            // like any margin click.
            const target = e.target as Node;
            return (
                toolbar.contains(target) ||
                caption.contains(target) ||
                (target instanceof Element && target.closest(".bc-btn") !== null &&
                    controlsCol.contains(target))
            );
        },

        ignoreMutation(_m: ViewMutationRecord): boolean {
            // No contentDOM; every DOM change is UI-layer only, so ProseMirror doesn't need to know
            return true;
        },

        destroy(): void {
            reflowOff?.();
            reflowOff = null;
            detachCaptionUndo();
            detachTitleUndo();
            dismissLightboxFor(img.src);
        },
    };
}
