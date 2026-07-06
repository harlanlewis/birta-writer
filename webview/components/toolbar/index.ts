import { editorViewCtx } from "@milkdown/core";
import type { Editor } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { runEditorCommand, setEditorCommandHost } from "@/editorCommands";
import {
    IconBold,
    IconItalic,
    IconStrikethrough,
    IconCode,
    IconLink,
    IconImage,
    IconTable,
    IconFootnote,
    IconMath,
    IconQuote,
    IconTerminal,
    IconMinus,
    IconList,
    IconListOrdered,
    IconCheckSquare,
    IconCheck,
    IconX,
    IconChevronDown,
    IconEraser,
    IconStyleCheck,
    IconSearch,
    IconSettings,
    IconFileCode,
} from "@/ui/icons";
import { t, kbd, productName } from "@/i18n";
import { sampleDocPosition } from "../selectionToolbar";
import { notifyOpenSettings, notifySetProofreadOption, notifySetFontPreset, notifySetToolbarLayout } from "@/messaging";
import { getEditorView } from "@/editor";
import { getProofreadConfig, setProofreadConfig } from "@/plugins";
import { createButton } from "@/ui/dom";
import { attachImgPathComplete } from '../imageView/imgPathComplete';
import { attachLinkTargetComplete } from '../pathLink/linkTargetComplete';
import { attachInputUndo } from "@/utils/inputUndo";
import { createOverflowController } from './overflow';
import type { OverflowController, OverflowGroup } from './overflow';
import { computeZones } from './registry';
import type { ToolbarItemId } from './registry';
import { enterEditMode } from './dnd';
import { wireHoverMenu } from './hoverMenu';
import type { ToolbarConfig, FontPreset, ProofreadConfig, ProofreadOptionKey } from "../../../shared/messages";
import { FONT_PRESET_STACKS } from "../../../shared/fontPresets";
import './toolbar.css';

type GetEditor = () => Editor | null;

function btn(
    icon: string,
    title: string,
    onClick: () => void,
    extraClass = "",
): HTMLButtonElement {
    return createButton({
        className: `tb-btn${extraClass ? " " + extraClass : ""}`,
        icon,
        title,
        onClick,
    });
}

/**
 * A dropdown trigger button — the shared shape behind every hover-menu opener
 * (Format, Font, Settings, Checks, ⋯). Its mousedown is swallowed:
 * preventDefault so it never fires an action or starts a text selection,
 * stopPropagation so it never reaches the editor. Deliberately carries no
 * tooltip — a tooltip would open in the same spot as the menu and overlap it.
 */
function createMenuTrigger(opts: {
    html?: string;
    text?: string;
    className?: string;
    ariaLabel?: string;
}): HTMLButtonElement {
    const el = document.createElement("button");
    el.className = opts.className ?? "tb-btn tb-fmt-btn";
    if (opts.html !== undefined) { el.innerHTML = opts.html; }
    if (opts.text !== undefined) { el.textContent = opts.text; }
    if (opts.ariaLabel) { el.setAttribute("aria-label", opts.ariaLabel); }
    el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    return el;
}

/** A selectable/checkable menu row. */
interface CheckItem {
    el: HTMLElement;
    /** The label span, e.g. to apply a per-row font preview. */
    label: HTMLElement;
    /** Show/hide the leading check and set aria-checked. */
    setChecked: (on: boolean) => void;
}

/**
 * A checkable menu row: a leading ✓ (shown when checked) + a label. The shared
 * checkmark treatment for every toolbar menu with selectable state — Checks
 * (multi-toggle), Font and Format (single-select) — so they look identical.
 */
function createCheckItem(label: string): CheckItem {
    const el = document.createElement("div");
    el.className = "tb-fmt-item tb-check-item";
    el.setAttribute("role", "menuitemcheckbox");
    const mark = document.createElement("span");
    mark.className = "menu-check";
    mark.setAttribute("aria-hidden", "true");
    const labelEl = document.createElement("span");
    labelEl.className = "tb-check-label";
    labelEl.textContent = label;
    el.append(mark, labelEl);
    return {
        el,
        label: labelEl,
        setChecked: (on: boolean): void => {
            el.classList.toggle("tb-check-item--on", on);
            el.setAttribute("aria-checked", on ? "true" : "false");
        },
    };
}

// Custom inline link prompt (two inputs: link text + URL)
function showInlineLinkPrompt(
    near: HTMLElement,
    defaultText: string,
    defaultHref: string,
    onConfirm: (text: string, href: string) => void,
): void {
    const overlay = document.createElement("div");
    overlay.className = "tb-prompt-overlay";
    overlay.addEventListener("mousedown", (e) => e.stopPropagation());

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.className = "tb-prompt-input tb-prompt-input--short";
    textInput.placeholder = t("Link text");
    textInput.value = defaultText;

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "tb-prompt-input";
    urlInput.placeholder = "https://...";
    urlInput.value = defaultHref;

    const okBtn = document.createElement("button");
    okBtn.className = "tb-prompt-ok";
    okBtn.innerHTML = IconCheck;
    okBtn.title = t("Confirm");

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "tb-prompt-cancel";
    cancelBtn.innerHTML = IconX;
    cancelBtn.title = t("Cancel");

    overlay.appendChild(textInput);
    overlay.appendChild(urlInput);
    overlay.appendChild(okBtn);
    overlay.appendChild(cancelBtn);
    document.body.appendChild(overlay);

    // Local undo/redo: VS Code intercepts Cmd+Z before native inputs see it
    const detachUndoFns = [attachInputUndo(textInput), attachInputUndo(urlInput)];

    // Workspace file autocompletion on the URL field (local link targets)
    const detachLinkComplete = attachLinkTargetComplete(urlInput);

    // Position the overlay below the toolbar button
    const rect = near.getBoundingClientRect();
    overlay.style.top = `${rect.bottom + 4}px`;
    overlay.style.left = `${rect.left}px`;

    // Focus the URL field if there's pre-filled text, otherwise focus the text field
    if (defaultText) {
        urlInput.focus();
        urlInput.select();
    } else {
        textInput.focus();
    }

    function confirm(): void {
        const text = textInput.value.trim();
        const href = urlInput.value.trim();
        cleanup();
        onConfirm(text, href);
    }

    function cleanup(): void {
        detachUndoFns.forEach((detach) => detach());
        detachLinkComplete();
        if (document.body.contains(overlay)) {
            document.body.removeChild(overlay);
        }
        document.removeEventListener("mousedown", outsideClick);
    }

    function outsideClick(e: MouseEvent): void {
        const active = document.activeElement;
        if (
            !overlay.contains(e.target as Node) &&
            active !== textInput &&
            active !== urlInput
        ) {
            cleanup();
        }
    }

    okBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        confirm();
    });
    cancelBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cleanup();
    });
    [textInput, urlInput].forEach((inp) => {
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.stopPropagation();
                e.preventDefault();
                confirm();
            } else if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                cleanup();
            }
        });
    });

    setTimeout(() => {
        document.addEventListener("mousedown", outsideClick);
    }, 0);
}

/**
 * Image insert panel: a centered floating panel (no backdrop) with three modes: Browse Project / URL / Upload local
 */
function showImageInsertPanel(
    onConfirm: (alt: string, src: string) => void,
    onUploadFile?: (file: File, altText: string) => Promise<string>,
    onGetProjectImages?: (
        id: string,
    ) => Promise<Array<{
        relPath: string;
        webviewUri: string;
        name: string;
    }> | null>,
): void {
    const panel = document.createElement("div");
    panel.className = "img-insert-panel";
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    // ── Title bar ─────────────────────────────────────
    const titleBar = document.createElement("div");
    titleBar.className = "img-insert-title";
    const titleText = document.createElement("span");
    titleText.textContent = t("Insert Image");
    const closeBtn = document.createElement("button");
    closeBtn.className = "img-insert-close-btn";
    closeBtn.innerHTML = IconX;
    closeBtn.type = "button";
    titleBar.appendChild(titleText);
    titleBar.appendChild(closeBtn);
    panel.appendChild(titleBar);

    // ── Tab switching ─────────────────────────────────
    const tabsRow = document.createElement("div");
    tabsRow.className = "img-insert-tabs";

    const tabProject = document.createElement("button");
    tabProject.className = "img-insert-tab img-insert-tab--active";
    tabProject.textContent = t("Browse Project");
    tabProject.type = "button";

    const tabUrl = document.createElement("button");
    tabUrl.className = "img-insert-tab";
    tabUrl.textContent = t("URL");
    tabUrl.type = "button";

    const tabUpload = document.createElement("button");
    tabUpload.className = "img-insert-tab";
    tabUpload.textContent = t("Upload");
    tabUpload.type = "button";

    tabsRow.appendChild(tabProject);
    tabsRow.appendChild(tabUrl);
    tabsRow.appendChild(tabUpload);
    panel.appendChild(tabsRow);

    // ── Alt text (shared by all three modes) ─────────────────────
    const altInput = document.createElement("input");
    altInput.type = "text";
    altInput.className = "img-insert-input";
    altInput.placeholder = t("Alt text (alt)");
    panel.appendChild(altInput);

    // ── Browse Project tab ─────────────────────────────
    const projectSection = document.createElement("div");
    projectSection.className = "img-insert-section";

    const gridStatus = document.createElement("div");
    gridStatus.className = "img-insert-status";
    gridStatus.textContent = t("Loading...");

    const imageGrid = document.createElement("div");
    imageGrid.className = "img-insert-grid";

    const selectedCount = document.createElement("div");
    selectedCount.className = "img-insert-selected-count";
    selectedCount.style.display = "none";

    projectSection.appendChild(gridStatus);
    projectSection.appendChild(imageGrid);
    projectSection.appendChild(selectedCount);
    panel.appendChild(projectSection);

    // ── URL mode content ──────────────────────────────
    const urlSection = document.createElement("div");
    urlSection.className = "img-insert-section";
    urlSection.style.display = "none";

    const srcInput = document.createElement("input");
    srcInput.type = "text";
    srcInput.className = "img-insert-input";
    srcInput.placeholder = t("Image URL https://...");
    urlSection.appendChild(srcInput);
    panel.appendChild(urlSection);
    const detachSrcComplete = attachImgPathComplete(srcInput);
    // Local undo/redo: VS Code intercepts Cmd+Z before native inputs see it
    const detachPanelUndoFns = [attachInputUndo(altInput), attachInputUndo(srcInput)];

    // ── Upload local tab ──────────────────────────────
    const uploadSection = document.createElement("div");
    uploadSection.className = "img-insert-section";
    uploadSection.style.display = "none";

    const selectFileBtn = document.createElement("button");
    selectFileBtn.className = "img-insert-browse-btn";
    selectFileBtn.type = "button";
    selectFileBtn.textContent = t("Select local image");

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";

    const uploadPreview = document.createElement("img");
    uploadPreview.className = "img-insert-preview";
    uploadPreview.style.display = "none";

    const statusText = document.createElement("div");
    statusText.className = "img-insert-status";
    statusText.style.display = "none";

    uploadSection.appendChild(selectFileBtn);
    uploadSection.appendChild(fileInput);
    uploadSection.appendChild(uploadPreview);
    uploadSection.appendChild(statusText);
    panel.appendChild(uploadSection);

    // ── Confirm / Cancel ──────────────────────────────
    const btnRow = document.createElement("div");
    btnRow.className = "img-insert-btn-row";

    const okBtn = document.createElement("button");
    okBtn.className = "img-insert-ok-btn";
    okBtn.innerHTML = IconCheck + " " + t("Confirm");
    okBtn.type = "button";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "img-insert-cancel-btn";
    cancelBtn.innerHTML = IconX + " " + t("Cancel");
    cancelBtn.type = "button";

    btnRow.appendChild(okBtn);
    btnRow.appendChild(cancelBtn);
    panel.appendChild(btnRow);

    document.body.appendChild(panel);

    // Center it
    const pw = Math.min(540, window.innerWidth - 32);
    panel.style.width = pw + "px";
    panel.style.left = Math.round((window.innerWidth - pw) / 2) + "px";
    panel.style.top =
        Math.round((window.innerHeight - panel.offsetHeight) / 2) + "px";
    // Re-center vertically after the first render (offsetHeight is only accurate once the element is in the DOM)
    requestAnimationFrame(() => {
        panel.style.top =
            Math.round((window.innerHeight - panel.offsetHeight) / 2) + "px";
    });

    type Tab = "project" | "url" | "upload";
    let activeTab: Tab = "project";
    let pendingUploadUrl = "";
    let selectedImages: Array<{
        relPath: string;
        webviewUri: string;
        name: string;
    }> = [];
    let imagesLoaded = false;

    function updateSelectedCount(): void {
        if (selectedImages.length === 0) {
            selectedCount.style.display = "none";
        } else {
            selectedCount.textContent =
                t("Selected") + ": " + selectedImages.length;
            selectedCount.style.display = "";
        }
    }

    // ── Enlarge preview (lightbox) ─────────────────────
    function showLightbox(src: string, name: string): void {
        const lb = document.createElement("div");
        lb.className = "img-lightbox";
        lb.addEventListener("mousedown", (e) => e.stopPropagation());

        const lbImg = document.createElement("img");
        lbImg.className = "img-lightbox-img";
        lbImg.src = src;
        lbImg.alt = name;

        const lbClose = document.createElement("button");
        lbClose.className = "img-lightbox-close";
        lbClose.innerHTML = IconX;
        lbClose.type = "button";

        lb.appendChild(lbImg);
        lb.appendChild(lbClose);
        document.body.appendChild(lb);

        const closeLb = (): void => {
            if (document.body.contains(lb)) {
                document.body.removeChild(lb);
            }
        };
        lb.addEventListener("mousedown", (e) => {
            if (e.target === lb) {
                closeLb();
            }
        });
        lbClose.addEventListener("mousedown", (e) => {
            e.preventDefault();
            closeLb();
        });
        document.addEventListener("keydown", function onKey(e) {
            if (e.key === "Escape") {
                closeLb();
                document.removeEventListener("keydown", onKey);
            }
        });
    }

    // ── Render the image grid ──────────────────────────
    function renderGrid(
        images: Array<{ relPath: string; webviewUri: string; name: string }>,
    ): void {
        imageGrid.innerHTML = "";
        selectedImages = [];
        updateSelectedCount();

        if (images.length === 0) {
            gridStatus.textContent = t("No images found");
            gridStatus.style.display = "";
            return;
        }

        gridStatus.style.display = "none";

        images.forEach((img) => {
            const item = document.createElement("div");
            item.className = "img-insert-thumb-item";
            item.title = img.name;

            const thumb = document.createElement("img");
            thumb.className = "img-insert-thumb";
            thumb.src = img.webviewUri;
            thumb.alt = img.name;
            thumb.loading = "lazy";

            const checkmark = document.createElement("div");
            checkmark.className = "img-insert-thumb-check";
            checkmark.innerHTML = IconCheck;

            const enlargeBtn = document.createElement("button");
            enlargeBtn.className = "img-insert-thumb-enlarge";
            enlargeBtn.innerHTML = "⤢";
            enlargeBtn.type = "button";
            enlargeBtn.title = t("Enlarge");

            item.appendChild(thumb);
            item.appendChild(checkmark);
            item.appendChild(enlargeBtn);
            imageGrid.appendChild(item);

            // Click to select/deselect
            item.addEventListener("mousedown", (e) => {
                if (
                    (e.target as Element).closest(".img-insert-thumb-enlarge")
                ) {
                    return;
                }
                e.preventDefault();
                const idx = selectedImages.findIndex(
                    (s) => s.webviewUri === img.webviewUri,
                );
                if (idx >= 0) {
                    selectedImages.splice(idx, 1);
                    item.classList.remove("img-insert-thumb-item--selected");
                } else {
                    selectedImages.push(img);
                    item.classList.add("img-insert-thumb-item--selected");
                }
                updateSelectedCount();
            });

            // Enlarge preview
            enlargeBtn.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                showLightbox(img.webviewUri, img.name);
            });
        });
    }

    // ── Load project images ────────────────────────────
    function loadProjectImages(): void {
        if (imagesLoaded) {
            return;
        }
        imagesLoaded = true;
        gridStatus.textContent = t("Loading...");
        gridStatus.style.display = "";
        imageGrid.innerHTML = "";
        const id = `gimgs_${Date.now().toString(36)}`;
        onGetProjectImages?.(id)
            .then((images) => {
                renderGrid(images ?? []);
            })
            .catch(() => {
                gridStatus.textContent = t("Failed to load images");
                gridStatus.style.display = "";
            });
    }

    function switchTab(tab: Tab): void {
        activeTab = tab;
        tabProject.classList.toggle(
            "img-insert-tab--active",
            tab === "project",
        );
        tabUrl.classList.toggle("img-insert-tab--active", tab === "url");
        tabUpload.classList.toggle("img-insert-tab--active", tab === "upload");
        projectSection.style.display = tab === "project" ? "" : "none";
        urlSection.style.display = tab === "url" ? "" : "none";
        uploadSection.style.display = tab === "upload" ? "" : "none";
        if (tab === "url") {
            srcInput.focus();
        }
        if (tab === "project") {
            loadProjectImages();
        }
    }

    // Upload local: file input
    selectFileBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        fileInput.click();
    });
    fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file) {
            handleFile(file);
        }
    });

    function handleFile(file: File): void {
        if (!file.type.startsWith("image/")) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            uploadPreview.src = reader.result as string;
            uploadPreview.style.display = "";
        };
        reader.readAsDataURL(file);
        pendingUploadUrl = "";

        if (!onUploadFile) {
            return;
        }

        statusText.textContent = t("Uploading...");
        statusText.className = "img-insert-status img-insert-status--loading";
        statusText.style.display = "";
        okBtn.disabled = true;

        onUploadFile(file, altInput.value.trim())
            .then((url) => {
                pendingUploadUrl = url;
                statusText.style.display = "none";
                okBtn.disabled = false;
            })
            .catch((err: Error) => {
                statusText.textContent = err.message;
                statusText.className =
                    "img-insert-status img-insert-status--error";
                okBtn.disabled = false;
                pendingUploadUrl = "";
            });
    }

    function confirm(): void {
        const alt = altInput.value.trim();
        if (activeTab === "project") {
            if (selectedImages.length === 0) {
                return;
            }
            cleanup();
            selectedImages.forEach((img) => onConfirm(alt, img.webviewUri));
        } else if (activeTab === "url") {
            // When chosen via completion, dataset holds a webviewUri — prefer it; otherwise use the input value directly
            const src = (srcInput.dataset.imgWebviewUri ?? "").trim() || srcInput.value.trim();
            cleanup();
            if (src) {
                onConfirm(alt, src);
            }
        } else {
            cleanup();
            if (pendingUploadUrl) {
                onConfirm(alt, pendingUploadUrl);
            }
        }
    }

    function cleanup(): void {
        detachSrcComplete();
        detachPanelUndoFns.forEach((detach) => detach());
        if (document.body.contains(panel)) {
            document.body.removeChild(panel);
        }
        document.removeEventListener("mousedown", outsideClick);
    }

    function outsideClick(e: MouseEvent): void {
        if (!panel.contains(e.target as Node)) {
            cleanup();
        }
    }

    // Tab switching
    tabProject.addEventListener("mousedown", (e) => {
        e.preventDefault();
        switchTab("project");
    });
    tabUrl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        switchTab("url");
    });
    tabUpload.addEventListener("mousedown", (e) => {
        e.preventDefault();
        switchTab("upload");
    });

    closeBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cleanup();
    });
    okBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        confirm();
    });
    cancelBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cleanup();
    });

    [altInput, srcInput].forEach((inp) => {
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.stopPropagation();
                e.preventDefault();
                confirm();
            } else if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                cleanup();
            }
        });
    });

    // Hide unavailable tabs
    if (!onGetProjectImages) {
        tabProject.style.display = "none";
        switchTab("url");
    } else {
        loadProjectImages(); // load immediately since the project tab is active by default
    }
    if (!onUploadFile) {
        tabUpload.style.display = "none";
    }

    setTimeout(() => {
        document.addEventListener("mousedown", outsideClick);
    }, 0);
}

export function initToolbar(
    topbar: HTMLElement,
    getEditor: GetEditor,
    debugOpts?: {
        getLineMap: () => number[];
        getMarkdownSource: () => string;
    },
    onUploadImage?: (file: File, altText: string) => Promise<string>,
    onGetProjectImages?: (
        id: string,
    ) => Promise<Array<{
        relPath: string;
        webviewUri: string;
        name: string;
    }> | null>,
    onOpenFind?: () => void,
    onSwitchToSource?: () => void,
): {
    onSelectionChange: (view: EditorView) => void;
    setDebugMode: (enabled: boolean) => void;
    /** Rebuild the toolbar for a changed per-item placement config. */
    applyConfig: (config: ToolbarConfig) => void;
    /** Update the font picker's active-preset indicator. */
    setFontPreset: (preset: FontPreset) => void;
    /** Opens the Insert/Edit Link prompt (toolbar button and Cmd/Ctrl+K). */
    openLinkPrompt: () => void;
} {
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";

    // TOC toggling lives on the panel's edge tab; undo/redo stay on their
    // keyboard shortcuts — neither needs a toolbar button.

    // ── Placement zones ──
    // Items are assigned to a zone (or hidden) by the per-item
    // `toolbar.items.*` settings and ordered within a zone by `toolbar.order`
    // (see computeZones). The ⋯ overflow menu collapses only the center zone
    // (see setupOverflow).
    const leftZone = document.createElement("div");
    leftZone.className = "tb-zone tb-zone--left";
    const centerZone = document.createElement("div");
    centerZone.className = "tb-zone tb-zone--center";
    const rightZone = document.createElement("div");
    rightZone.className = "tb-zone tb-zone--right";
    toolbar.append(leftZone, centerZone, rightZone);

    // Every item is built exactly once and wrapped in a `.tb-item`; render()
    // re-parents the wrappers into their zones, so button listeners survive a
    // layout change without rebuilding.
    const items: Partial<Record<ToolbarItemId, HTMLElement>> = {};
    function wrap(id: string, child: HTMLElement): HTMLElement {
        const w = document.createElement("div");
        w.className = "tb-item";
        w.dataset["itemId"] = id;
        w.appendChild(child);
        return w;
    }

    // ── Font picker state ──
    // The active preset is echoed back from the extension after a settings
    // write, which updates the checkmark via setFontPreset() on the controller.
    let currentFontPreset: FontPreset = window.__i18n?.fontPreset ?? "mono";
    const fontEntries: { preset: FontPreset; item: CheckItem }[] = [];
    // The picker button's "A" glyph, rendered in the active preset's stack so
    // the control previews its own choice.
    let fontLabelEl: HTMLElement | null = null;
    function setFontActive(preset: FontPreset): void {
        currentFontPreset = preset;
        for (const { preset: p, item } of fontEntries) {
            item.setChecked(p === preset);
        }
        if (fontLabelEl) {
            fontLabelEl.style.fontFamily =
                preset === "default" ? "" : FONT_PRESET_STACKS[preset];
        }
    }
    function createFontPicker(): HTMLElement {
        const fontWrap = document.createElement("div");
        fontWrap.className = "tb-fmt-wrap";

        const fontBtn = createMenuTrigger({
            html: `<span class="tb-fmt-label tb-fmt-label--font">A</span>${IconChevronDown}`,
        });
        fontLabelEl = fontBtn.querySelector(".tb-fmt-label--font");

        const fontMenu = document.createElement("div");
        fontMenu.className = "tb-fmt-menu tb-font-menu";
        fontMenu.style.display = "none";

        // The picker offers the three built-in font stacks; "default" (inherit the
        // VS Code font / the Font Family setting) stays a valid setting value for
        // power users, just not a menu item. Monospace is the default preset.
        const choices: { preset: FontPreset; label: string; stack: string }[] = [
            { preset: "sans", label: t("Sans serif"), stack: FONT_PRESET_STACKS.sans },
            { preset: "serif", label: t("Serif"), stack: FONT_PRESET_STACKS.serif },
            { preset: "mono", label: t("Monospace"), stack: FONT_PRESET_STACKS.mono },
        ];
        for (const { preset, label, stack } of choices) {
            const item = createCheckItem(label);
            item.el.classList.add("tb-font-item");
            if (stack) {
                item.label.style.fontFamily = stack; // preview the font on its own label
            }
            item.el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                fontMenu.style.display = "none";
                setFontActive(preset);
                notifySetFontPreset(preset);
            });
            fontMenu.appendChild(item.el);
            fontEntries.push({ preset, item });
        }
        setFontActive(currentFontPreset);

        wireHoverMenu(fontWrap, fontBtn, fontMenu);

        fontWrap.appendChild(fontBtn);
        fontWrap.appendChild(fontMenu);
        return fontWrap;
    }

    // ── Block-type dropdown (opens on hover, same style as the floating toolbar) ──
    const fmtWrap = document.createElement("div");
    fmtWrap.className = "tb-fmt-wrap";

    const fmtBtn = createMenuTrigger({ html: `<span class="tb-fmt-label">P</span>${IconChevronDown}` });

    const fmtMenu = document.createElement("div");
    fmtMenu.className = "tb-fmt-menu";
    fmtMenu.style.display = "none";

    const formats: [string, () => void][] = [
        ["P", () => runEditorCommand("setParagraph", getEditor)],
        ["H1", () => runEditorCommand("setHeading1", getEditor)],
        ["H2", () => runEditorCommand("setHeading2", getEditor)],
        ["H3", () => runEditorCommand("setHeading3", getEditor)],
        ["H4", () => runEditorCommand("setHeading4", getEditor)],
        ["H5", () => runEditorCommand("setHeading5", getEditor)],
        ["H6", () => runEditorCommand("setHeading6", getEditor)],
    ];

    const fmtItems: CheckItem[] = [];
    formats.forEach(([label, action]) => {
        const item = createCheckItem(label);
        item.el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            action();
            fmtMenu.style.display = "none";
        });
        fmtMenu.appendChild(item.el);
        fmtItems.push(item);
    });

    wireHoverMenu(fmtWrap, fmtBtn, fmtMenu);

    fmtWrap.appendChild(fmtBtn);
    fmtWrap.appendChild(fmtMenu);
    items.format = wrap("format", fmtWrap);

    // ── Font picker (serif / sans-serif / monospace presets) ──
    items.fontPreset = wrap("fontPreset", createFontPicker());

    // ── Inline formatting ─────────────────────────────
    items.bold = wrap("bold", btn(IconBold, t("Bold") + " " + kbd("Mod-b"), () =>
        runEditorCommand("toggleBold", getEditor),
    ));
    items.italic = wrap("italic", btn(IconItalic, t("Italic") + " " + kbd("Mod-i"), () =>
        runEditorCommand("toggleItalic", getEditor),
    ));
    items.strikethrough = wrap("strikethrough", btn(
        IconStrikethrough,
        t("Strikethrough") + " " + kbd("Mod-Shift-x"),
        () => runEditorCommand("toggleStrikethrough", getEditor),
    ));
    items.inlineCode = wrap("inlineCode", btn(IconCode, t("Inline Code") + " " + kbd("Mod-e"), () =>
        runEditorCommand("toggleInlineCode", getEditor),
    ));
    items.clearFormatting = wrap("clearFormatting", btn(IconEraser, t("Clear Formatting"), () =>
        runEditorCommand("clearFormatting", getEditor),
    ));

    // ── Insert ────────────────────────────────────────
    // Link: capture the current selection text and any existing link first,
    // then collect text and URL through the two-input prompt. Also invoked
    // by the Cmd/Ctrl+K shortcut (webview/keyboardShortcuts.ts), so it is
    // exposed on the returned controller as openLinkPrompt.
    let linkBtnEl: HTMLButtonElement;
    const openLinkPrompt = (): void => {
        const editor = getEditor();
        if (!editor) {
            return;
        }

        let capturedFrom = 0;
        let capturedTo = 0;
        let existingHref = "";
        let selectedText = "";

        editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state } = view;
            const linkType = state.schema.marks["link"];
            if (!linkType) {
                return;
            }
            capturedFrom = state.selection.from;
            capturedTo = state.selection.to;
            // A selection spanning several textblocks (paragraphs, headings,
            // list items, ...) cannot become ONE inline link without fusing
            // the blocks' texts together. Clamp to the portion inside the
            // first textblock: the prompt pre-fills and the confirm applies
            // to that range only, leaving the other blocks untouched.
            const $from = state.selection.$from;
            if ($from.parent.isTextblock) {
                const firstBlockEnd = $from.end();
                if (capturedTo > firstBlockEnd) {
                    capturedTo = firstBlockEnd;
                }
            }
            if (capturedFrom !== capturedTo) {
                selectedText = state.doc.textBetween(capturedFrom, capturedTo);
            }
            state.doc.nodesBetween(capturedFrom, capturedTo, (node) => {
                const mark = linkType.isInSet(node.marks);
                if (mark) {
                    existingHref =
                        (mark.attrs as Record<string, string>)["href"] ?? "";
                }
            });
        });

        showInlineLinkPrompt(
            // The link button may be hidden; fall back to anchoring on the toolbar.
            linkBtnEl.isConnected ? linkBtnEl : toolbar,
            selectedText,
            existingHref,
            (text, href) => {
                editor.action((ctx) => {
                    const view = ctx.get(editorViewCtx);
                    const { state } = view;
                    const lType = state.schema.marks["link"];
                    if (!lType) {
                        return;
                    }
                    let tr = state.tr;
                    if (capturedFrom === capturedTo) {
                        // No selection: insert new text and link it
                        const insertText = text || href;
                        if (!insertText) {
                            return;
                        }
                        tr = tr.insertText(insertText, capturedFrom);
                        if (href) {
                            tr = tr.addMark(
                                capturedFrom,
                                capturedFrom + insertText.length,
                                lType.create({ href, title: null }),
                            );
                        }
                    } else {
                        // Selection: replace the text and update the link
                        const newText = text || selectedText;
                        tr = tr.removeMark(capturedFrom, capturedTo, lType);
                        tr = tr.insertText(newText, capturedFrom, capturedTo);
                        if (href && newText) {
                            tr = tr.addMark(
                                capturedFrom,
                                capturedFrom + newText.length,
                                lType.create({ href, title: null }),
                            );
                        }
                    }
                    view.dispatch(tr);
                    view.focus();
                });
            },
        );
    };
    linkBtnEl = btn(
        IconLink,
        t("Insert/Edit Link") + " " + kbd("Mod-k"),
        openLinkPrompt,
    );
    items.link = wrap("link", linkBtnEl);

    // Image: open the insert panel, then insert an image node
    const openImagePanel = (): void => {
        showImageInsertPanel(
            (alt, src) => {
                const editor = getEditor();
                if (!editor) {
                    return;
                }
                editor.action((ctx) => {
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
            },
            onUploadImage,
            onGetProjectImages,
        );
    };
    const imgBtnEl = btn(IconImage, t("Insert Image"), openImagePanel);
    items.image = wrap("image", imgBtnEl);
    items.table = wrap("table", btn(IconTable, t("Insert Table"), () =>
        runEditorCommand("insertTable", getEditor),
    ));
    items.footnote = wrap("footnote", btn(IconFootnote, t("Insert Footnote"), () =>
        runEditorCommand("insertFootnote", getEditor),
    ));
    items.math = wrap("math", btn(IconMath, t("Insert Math"), () =>
        runEditorCommand("insertMath", getEditor),
    ));

    // Lists (toggle: clicking the active one again lifts out)
    items.bulletList = wrap("bulletList", btn(IconList, t("Bullet List"), () =>
        runEditorCommand("toggleBulletList", getEditor),
    ));
    items.orderedList = wrap("orderedList", btn(IconListOrdered, t("Ordered List"), () =>
        runEditorCommand("toggleOrderedList", getEditor),
    ));
    items.taskList = wrap("taskList", btn(IconCheckSquare, t("Task List"), () =>
        runEditorCommand("toggleTaskList", getEditor),
    ));

    // Blocks (toggle)
    items.blockquote = wrap("blockquote", btn(IconQuote, t("Blockquote"), () =>
        runEditorCommand("toggleBlockquote", getEditor),
    ));
    items.codeBlock = wrap("codeBlock", btn(IconTerminal, t("Code Block"), () =>
        runEditorCommand("insertCodeBlock", getEditor),
    ));
    items.horizontalRule = wrap("horizontalRule", btn(IconMinus, t("Horizontal Rule"), () =>
        runEditorCommand("insertHorizontalRule", getEditor),
    ));

    // ── Debug tools (dev-only dropdown, gated by debugMode; pinned before
    //    Settings in the right zone, not user-placeable) ──
    let dbgItem: HTMLElement | null = null;

    if (debugOpts) {
        const { getLineMap, getMarkdownSource } = debugOpts;

        const dbgWrap = document.createElement("div");
        dbgWrap.className = "tb-fmt-wrap";

        const dbgBtn = document.createElement("button");
        dbgBtn.className = "tb-btn tb-fmt-btn";
        dbgBtn.innerHTML = IconList + IconChevronDown;
        // No tooltip: it would overlap the dropdown menu (see the font picker).
        dbgBtn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        const dbgMenu = document.createElement("div");
        dbgMenu.className = "tb-fmt-menu";
        dbgMenu.style.display = "none";

        const testLineItem = document.createElement("button");
        testLineItem.className = "tb-fmt-item";
        testLineItem.textContent = t("Test get line number");
        testLineItem.addEventListener("click", async () => {
            dbgMenu.style.display = "none";
            const editor = getEditor();
            if (!editor) {
                return;
            }
            const view: EditorView = editor.action((ctx) =>
                ctx.get(editorViewCtx),
            );
            if (!view) {
                return;
            }

            const nodeCount = view.state.doc.childCount;
            const step = Math.max(1, Math.floor(nodeCount / 10));
            const samples: object[] = [];
            let offset = 0;

            for (let idx = 0; idx < nodeCount; idx++) {
                const node = view.state.doc.child(idx);
                if (idx % step === 0 && samples.length < 10) {
                    samples.push({
                        n: samples.length + 1,
                        ...sampleDocPosition(
                            view,
                            offset + 1,
                            getLineMap,
                            getMarkdownSource,
                        ),
                    });
                }
                offset += node.nodeSize;
            }

            const json = JSON.stringify(
                {
                    ts: new Date().toISOString(),
                    docNodes: nodeCount,
                    lineMapLen: getLineMap().length,
                    srcLines: getMarkdownSource().split("\n").length,
                    samples,
                },
                null,
                2,
            );

            try {
                await navigator.clipboard.writeText(json);
            } catch {
                console.log(
                    "[Debug] line-number test result (clipboard write failed, falling back to console):",
                    json,
                );
            }
        });

        dbgMenu.appendChild(testLineItem);
        dbgWrap.appendChild(dbgBtn);
        dbgWrap.appendChild(dbgMenu);

        wireHoverMenu(dbgWrap, dbgBtn, dbgMenu);

        dbgItem = wrap("debug", dbgWrap);
    }

    // ── Checks menu (spelling, grammar, style + per-check toggles) ───────────
    // One toolbar button opens a menu of checkmarkable items: the three masters
    // up top, then the style sub-checks grouped under headers. Every row toggles
    // one option live (webview state) and persists it (settings). The menu opens
    // on hover, like the font picker; the button itself is just its anchor.
    // The chevron signals it opens a menu; aria-label names it for assistive tech.
    const checksBtn = createMenuTrigger({
        html: `${IconStyleCheck}${IconChevronDown}`,
        ariaLabel: t("Checks"),
    });

    type CheckRow = { key: ProofreadOptionKey; item: CheckItem; styleDependent: boolean };
    const checkRows: CheckRow[] = [];

    const repaintChecks = (cfg: ProofreadConfig): void => {
        for (const { key, item, styleDependent } of checkRows) {
            item.setChecked(Boolean(cfg[key]));
            // A style sub-check is inert while "Check Style" is off — dim it so
            // the dependency reads, but keep it clickable (pre-arm for later).
            if (styleDependent) {
                item.el.classList.toggle("tb-check-item--muted", !cfg.styleCheck);
            }
        }
        // The button carries no on/off highlight: with a dozen sub-toggles inside,
        // a single boolean state is more distracting than informative. The menu's
        // own checkmarks are the source of truth.
    };

    function createChecksControl(): HTMLElement {
        const wrapEl = document.createElement("div");
        wrapEl.className = "tb-fmt-wrap tb-checks-wrap";
        wrapEl.appendChild(checksBtn);

        const menu = document.createElement("div");
        menu.className = "tb-fmt-menu tb-checks-menu";
        menu.style.display = "none";
        menu.setAttribute("role", "menu");

        const addRow = (key: ProofreadOptionKey, label: string, styleDependent: boolean): void => {
            const item = createCheckItem(label);
            item.el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const view = getEditorView();
                if (!view) { return; }
                const cfg = getProofreadConfig(view);
                const value = !cfg[key];
                setProofreadConfig(view, { ...cfg, [key]: value });
                notifySetProofreadOption(key, value);
                // Menu stays open so several checks can be toggled in a row.
            });
            menu.appendChild(item.el);
            checkRows.push({ key, item, styleDependent });
        };
        const addSep = (): void => {
            const sep = document.createElement("div");
            sep.className = "tb-menu-sep";
            sep.setAttribute("role", "separator");
            menu.appendChild(sep);
        };
        const addHeader = (title: string): void => {
            const header = document.createElement("div");
            header.className = "tb-fmt-header";
            header.textContent = title;
            menu.appendChild(header);
        };

        // Masters
        addRow("spellCheck", t("Check spelling"), false);
        addRow("grammarCheck", t("Check grammar"), false);
        addRow("styleCheck", t("Check style"), false);

        // Style sub-checks, grouped
        const groups: { title: string; opts: [ProofreadOptionKey, string][] }[] = [
            { title: t("Phrases"), opts: [
                ["fillers", t("Fillers")],
                ["redundancies", t("Redundancies")],
                ["cliches", t("Cliches")],
                ["wordiness", t("Wordiness")],
            ] },
            { title: t("AI tells"), opts: [
                ["aiVocabulary", t("AI vocabulary")],
                ["aiArtifacts", t("AI boilerplate")],
                ["negativeParallelism", t("Not X, but Y")],
                ["ruleOfThree", t("Rule of three")],
            ] },
            { title: t("Prose"), opts: [
                ["passive", t("Passive voice")],
                ["longSentences", t("Long sentences")],
                ["emDash", t("Em dash")],
                ["nonAsciiPunct", t("Curly punctuation")],
            ] },
        ];
        for (const group of groups) {
            addSep();
            addHeader(group.title);
            for (const [key, label] of group.opts) { addRow(key, label, true); }
        }

        wireHoverMenu(wrapEl, checksBtn, menu, {
            onOpen: () => {
                const view = getEditorView();
                if (view) { repaintChecks(getProofreadConfig(view)); }
            },
        });

        wrapEl.appendChild(menu);
        return wrapEl;
    }
    const checksControl = createChecksControl();

    window.addEventListener("proofread-config-changed", (e) => {
        repaintChecks((e as CustomEvent<ProofreadConfig>).detail);
    });
    {
        // Paint the initial state if the editor already exists at build time.
        const view = getEditorView();
        if (view) { repaintChecks(getProofreadConfig(view)); }
    }
    items.styleCheck = wrap("styleCheck", checksControl);
    // Mode switch: leave the rendered editor for the raw markdown text editor.
    // Same code path as Cmd/Ctrl+Shift+M and the tab-bar button (the callback
    // captures the first visible source line so the viewport is preserved).
    if (onSwitchToSource) {
        items.viewSource = wrap("viewSource", btn(
            IconFileCode,
            `${t("Edit Raw Markdown")} ${kbd("Mod-Shift-m")}`,
            onSwitchToSource,
        ));
    }
    if (onOpenFind) {
        items.find = wrap("find", btn(IconSearch, `${t("Find")} (${kbd("Mod-f")})`, onOpenFind));
    }
    // Settings gear is a hover dropdown: open the native settings, or enter the
    // drag-and-drop "Customize toolbar" mode.
    function createSettingsMenu(): HTMLElement {
        const wrapEl = document.createElement("div");
        wrapEl.className = "tb-fmt-wrap";

        const gearBtn = createMenuTrigger({ html: IconSettings + IconChevronDown });

        const menu = document.createElement("div");
        menu.className = "tb-fmt-menu tb-settings-menu";
        menu.style.display = "none";

        const addEntry = (label: string, onSelect: () => void): void => {
            const entry = document.createElement("div");
            entry.className = "tb-fmt-item";
            entry.textContent = label;
            entry.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                menu.style.display = "none";
                onSelect();
            });
            menu.appendChild(entry);
        };
        addEntry(t("Customize toolbar"), () => startCustomize());
        // Names the product so it's clear which settings open (t()-templated for
        // future translation); the name is the single package.json value.
        addEntry(t("Open {product} settings").replace("{product}", productName), () => notifyOpenSettings());

        wireHoverMenu(wrapEl, gearBtn, menu);

        wrapEl.appendChild(gearBtn);
        wrapEl.appendChild(menu);
        return wrapEl;
    }
    items.settings = wrap("settings", createSettingsMenu());

    // ── Overflow (⋯) menu for the center zone on narrow panes ──
    // Reuses the tb-fmt-wrap hover/positioning pattern; collapsed center items
    // are physically reparented into the panel so listeners survive.
    const moreWrap = document.createElement("div");
    moreWrap.className = "tb-fmt-wrap tb-more-wrap";
    moreWrap.style.display = "none";

    const moreBtn = createMenuTrigger({ text: "⋯", className: "tb-btn tb-more-btn" });

    const moreMenu = document.createElement("div");
    moreMenu.className = "tb-more-menu";
    moreMenu.style.display = "none";

    wireHoverMenu(moreWrap, moreBtn, moreMenu);

    moreWrap.appendChild(moreBtn);
    moreWrap.appendChild(moreMenu);
    centerZone.appendChild(moreWrap);

    topbar.appendChild(toolbar);

    // ── Render + responsive overflow ──────────────────────
    let overflow: OverflowController | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let debugVisible = !!window.__i18n?.debugMode;
    // The last placement config we know about, and whether the user is in the
    // drag-and-drop customize mode. While editing, the DOM is the source of
    // truth and incoming config echoes (from our own writes) are deferred so
    // they don't tear down the drag state mid-session.
    let latestConfig: ToolbarConfig | undefined = window.__i18n?.toolbar;
    let editing = false;

    function startCustomize(): void {
        if (editing) {
            return;
        }
        editing = true;

        // Hidden tray: a bar below the toolbar holding every off item, plus the
        // Done button. Dragging between it and the zones shows/hides items.
        const tray = document.createElement("div");
        tray.className = "tb-hidden-tray";

        const label = document.createElement("span");
        label.className = "tb-hidden-tray-label";
        label.textContent = t("Hidden — drag to add");

        const trayItems = document.createElement("div");
        trayItems.className = "tb-hidden-tray-items tb-zone";

        const doneBtn = document.createElement("button");
        doneBtn.className = "tb-edit-done";
        doneBtn.textContent = t("Done");

        tray.append(label, trayItems, doneBtn);

        for (const id of computeZones(latestConfig).hidden) {
            const el = items[id];
            if (el) { trayItems.appendChild(el); }
        }
        document.body.appendChild(tray);

        const exit = enterEditMode({
            toolbar,
            zones: { left: leftZone, center: centerZone, right: rightZone, hidden: trayItems },
            moreWrap,
            expandOverflow: () => overflow?.update(Number.MAX_SAFE_INTEGER),
            onChange: (change) => notifySetToolbarLayout(change.item, change.order),
            onExit: () => {
                editing = false;
                // The DOM already reflects every drag; don't rebuild from config
                // (which may lag behind the write echo). Detach the tray (drops
                // any still-hidden items) and re-sync overflow to the live DOM.
                tray.remove();
                resyncOverflow();
            },
        });
        doneBtn.addEventListener("click", exit);
    }

    function resyncOverflow(): void {
        resizeObserver?.disconnect();
        resizeObserver = null;
        overflow = null;
        setupOverflow();
    }

    // Width available to the center zone = toolbar minus the sides' CONTENT.
    // The side zones fill their `1fr` grid tracks, so scrollWidth/clientWidth
    // report the (large) track width, not the content — using those made a lone
    // center item look like it overflowed. Sum the side items' own widths
    // instead. Measured from the sides (not center) so collapse never feeds
    // back into the measurement. The slack absorbs the inter-zone grid gaps.
    const ZONE_GAP_SLACK = 8;
    function measureContentWidth(zone: HTMLElement): number {
        let total = 0;
        let count = 0;
        for (const el of Array.from(zone.children)) {
            if (el instanceof HTMLElement && el.classList.contains("tb-item")) {
                total += el.getBoundingClientRect().width;
                count++;
            }
        }
        if (count > 1) {
            total += 2 * (count - 1); // inter-item flex gaps (2px each)
        }
        return total;
    }
    function availableCenterWidth(): number {
        return Math.max(
            0,
            toolbar.clientWidth - measureContentWidth(leftZone) - measureContentWidth(rightZone) - ZONE_GAP_SLACK,
        );
    }

    function setupOverflow(): void {
        const wrappers = Array.from(centerZone.children).filter(
            (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("tb-item"),
        );
        const groups: OverflowGroup[] = wrappers.map((el) => ({
            name: el.dataset["itemId"] ?? "",
            el,
            sepBefore: null,
        }));
        // Collapse from the end of the center zone; never collapse the format
        // (text-level) dropdown — it is the toolbar's anchor control.
        const collapseOrder = groups
            .map((_, i) => i)
            .filter((i) => groups[i]!.name !== "format")
            .reverse();
        overflow = createOverflowController({
            toolbar: centerZone,
            groups,
            collapseOrder,
            moreWrap,
            panel: moreMenu,
        });
        overflow.update(availableCenterWidth());
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => overflow?.update(availableCenterWidth()));
            resizeObserver.observe(toolbar);
        }
    }

    function render(config: ToolbarConfig | undefined): void {
        resizeObserver?.disconnect();
        resizeObserver = null;
        overflow = null;
        // Detach every item wrapper (from its zone or the ⋯ panel) plus any
        // stale overflow markers, keeping the persistent moreWrap in place.
        leftZone.replaceChildren();
        rightZone.replaceChildren();
        Array.from(centerZone.childNodes).forEach((n) => {
            if (n !== moreWrap) { centerZone.removeChild(n); }
        });
        moreMenu.replaceChildren();

        const zones = computeZones(config);
        for (const id of zones.left) {
            const el = items[id];
            if (el) { leftZone.appendChild(el); }
        }
        for (const id of zones.center) {
            const el = items[id];
            if (el) { centerZone.insertBefore(el, moreWrap); }
        }
        for (const id of zones.right) {
            const el = items[id];
            if (el) { rightZone.appendChild(el); }
        }

        // Debug dropdown: pinned just before Settings in the right zone.
        if (dbgItem) {
            const settingsEl = items.settings;
            if (settingsEl && settingsEl.parentElement === rightZone) {
                rightZone.insertBefore(dbgItem, settingsEl);
            } else {
                rightZone.appendChild(dbgItem);
            }
            dbgItem.style.display = debugVisible ? "" : "none";
        }

        setupOverflow();
    }

    render(window.__i18n?.toolbar);

    // Expose the toolbar-owned actions to the shared editor-command registry so
    // the command palette / context menu reach the exact same code paths.
    // (openFindReplace, toggleToc and editFrontmatter are wired in index.ts.)
    setEditorCommandHost({
        openLinkPrompt,
        openImagePanel,
        ...(onOpenFind ? { openFind: onOpenFind } : {}),
    });

    return {
        onSelectionChange(view: EditorView): void {
            const { $from } = view.state.selection;
            let activeLevel = 0; // 0 = paragraph
            for (let d = $from.depth; d >= 0; d--) {
                const n = $from.node(d);
                if (n.type.name === "heading") {
                    activeLevel = n.attrs["level"] as number;
                    break;
                }
                if (n.type.name === "code_block") {
                    activeLevel = -1;
                    break;
                }
            }
            // Update the format button's label (may be detached when hidden).
            const labelEl = fmtBtn.querySelector(".tb-fmt-label");
            if (labelEl) {
                const labels = ["P","H1","H2","H3","H4","H5","H6"];
                labelEl.textContent = activeLevel === -1 ? "—" : (labels[activeLevel] ?? "P");
            }
            fmtItems.forEach((item, i) => {
                // i=0 → P (activeLevel===0), i=1..6 → H1..H6 (activeLevel===i)
                item.setChecked(i === 0 ? activeLevel === 0 : i === activeLevel);
            });
        },
        setDebugMode(enabled: boolean): void {
            debugVisible = enabled;
            if (dbgItem) {
                dbgItem.style.display = enabled ? "" : "none";
            }
            // Toggling debug changes the right zone's width, which changes the
            // space available to the center zone.
            overflow?.update(availableCenterWidth());
        },
        applyConfig(config: ToolbarConfig): void {
            latestConfig = config;
            // Defer while dragging: the DOM already reflects the change, and a
            // rebuild would drop the edit-mode decorations. Applied on exit.
            if (!editing) {
                render(config);
            }
        },
        setFontPreset(preset: FontPreset): void {
            setFontActive(preset);
        },
        openLinkPrompt,
    };
}
