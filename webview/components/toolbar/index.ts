import type { Editor } from "@milkdown/core";
import { getView, type EditorView } from "@/pm";
import { runEditorCommand, setEditorCommandHost } from "@/editorCommands";
import {
    IconBold,
    IconItalic,
    IconStrikethrough,
    IconHighlighter,
    IconCode,
    IconLink,
    IconImage,
    IconTable,
    IconFootnote,
    IconMath,
    IconNetwork,
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
    IconAlertTriangle,
} from "@/ui/icons";
import { CALLOUT_ICONS } from "../callout";
import type { CalloutKind } from "@/plugins/callouts";
import { t, kbd, productName } from "@/i18n";
import { sampleDocPosition } from "@/utils/docPosition";
import { notifyOpenSettings, notifyOpenKeybindings, notifySetProofreadOption, notifySetFontPreset, notifySetFontSize, notifySetContentWidth, notifySetBlockHandles, notifySetToolbarLayout, notifySetToolbarVisible, notifyResolveSyncConflict } from "@/messaging";
import { getEditorView } from "@/editor";
import { getProofreadConfig, setProofreadConfig } from "@/plugins";
import { createButton } from "@/ui/dom";
import { onOutsideClick } from "@/ui/outsideClick";
import { attachImgPathComplete } from '../imageView/imgPathComplete';
import { attachInputUndo } from "@/utils/inputUndo";
import { openLinkEditor } from "../linkPopup";
import { createOverflowController } from './overflow';
import type { OverflowController, OverflowGroup } from './overflow';
import { computeZones } from './registry';
import type { ToolbarItemId } from './registry';
import { computeToolbarActiveState, DETACHED_STATE, type ToolbarActiveState } from './activeState';
import { enterEditMode } from './dnd';
import { wireHoverMenu } from './hoverMenu';
import type { ToolbarConfig, FontPreset, FontStacks, ProofreadConfig, ProofreadOptionKey } from "../../../shared/messages";
import {
    FONT_PRESET_STACKS,
    DEFAULT_FONT_PRESET,
    DEFAULT_FONT_SIZE_PERCENT,
    MIN_FONT_SIZE_PERCENT,
    MAX_FONT_SIZE_PERCENT,
    clampFontSizePercent,
    stepFontSizePercent,
} from "../../../shared/fontPresets";
import {
    CONTENT_WIDTH_MODES,
    DEFAULT_CONTENT_WIDTH_MODE,
    DEFAULT_MAX_WIDTH_CH,
    normalizeContentWidthMode,
    clampMaxWidthCh,
    type ContentWidthMode,
} from "../../../shared/contentWidth";
import { BLOCK_HANDLES_DISPLAY_ORDER, type BlockHandlesMode } from "../../../shared/blockHandles";
import { applyBlockHandles, currentBlockHandlesMode } from "../../utils/blockHandles";
import { TOOLBAR_MENU_COMMANDS, settingsMenuTitle } from "../../../shared/editorCommands";
import { openShortcutsHelp } from "../shortcutsHelp";
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

/** A horizontal menu divider — the shared separator idiom for every dropdown. */
function makeSep(): HTMLElement {
    const sep = document.createElement("div");
    sep.className = "tb-menu-sep";
    sep.setAttribute("role", "separator");
    return sep;
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

/** A menu row whose active state is shown by filling the row (no leading check). */
interface FillItem {
    el: HTMLElement;
    setActive: (on: boolean) => void;
}

/**
 * A fill-idiom menu row: a label whose active state is an accent-filled row (the
 * `.tb-list-item--on` treatment shared by the Lists/Quote/Code pickers), not a
 * leading checkmark. The Format (P / H1–H6) menu uses this so it reads the same
 * as the other container pickers — a single-select where the current row lights.
 */
function createFillItem(label: string): FillItem {
    const el = document.createElement("div");
    el.className = "tb-fmt-item tb-fmt-fill-item";
    el.setAttribute("role", "menuitemradio");
    el.setAttribute("aria-checked", "false");
    el.textContent = label;
    return {
        el,
        setActive: (on: boolean): void => {
            el.classList.toggle("tb-fmt-item--on", on);
            el.setAttribute("aria-checked", on ? "true" : "false");
        },
    };
}

/**
 * A switch menu row: a label on the left and an on/off switch on the right. Used
 * by the Checks menu (proofreading), where every row is an independent on/off,
 * not a selection from a set — so a switch reads truer than a checkmark. The row
 * itself is role=switch (the track/knob are decorative) so the menu's Enter/Space
 * handling activates it without a duplicate focus stop. Same CheckItem shape as
 * createCheckItem, so callers treat the two interchangeably.
 */
function createSwitchItem(label: string): CheckItem {
    const el = document.createElement("div");
    el.className = "tb-fmt-item tb-switch-item";
    el.setAttribute("role", "switch");
    el.setAttribute("aria-checked", "true");
    const labelEl = document.createElement("span");
    labelEl.className = "tb-switch-item-label";
    labelEl.textContent = label;
    const track = document.createElement("span");
    track.className = "tb-switch";
    track.setAttribute("aria-hidden", "true");
    track.appendChild(document.createElement("span")).className = "tb-switch-knob";
    el.append(labelEl, track);
    return {
        el,
        label: labelEl,
        setChecked: (on: boolean): void => {
            el.classList.toggle("tb-switch-item--on", on);
            el.setAttribute("aria-checked", on ? "true" : "false");
        },
    };
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
        outsideOff?.();
        outsideOff = null;
    }

    /** Outside-click detach handle (null until the deferred attach below). */
    let outsideOff: (() => void) | null = null;

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

    // Deferred one tick so the opening click can't instantly dismiss the
    // dialog. Bubble phase (`capture: false`), matching the hand-rolled
    // original.
    setTimeout(() => {
        outsideOff = onOutsideClick([panel], cleanup, { capture: false });
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
    /** Blank the bar while focus is in a nested editable island (a callout title). */
    setDetached: () => void;
    setDebugMode: (enabled: boolean) => void;
    /** Show/hide the disk-drift badge (file on disk changed vs unsaved edits). */
    setSyncConflict: (active: boolean) => void;
    /** Rebuild the toolbar for a changed per-item placement config. */
    applyConfig: (config: ToolbarConfig) => void;
    /** Update the font picker's active-preset indicator (and optional stack previews). */
    setFontPreset: (preset: FontPreset, stacks?: FontStacks) => void;
    /** Update the font picker's size-stepper display (percent). */
    setFontSize: (size: number) => void;
    /** Update the typography menu's content-width segmented control (and cache the fixed width). */
    setContentWidth: (mode: ContentWidthMode, fixedCss?: string) => void;
    /** Update the typography menu's block-handles radio rows. */
    setBlockHandles: (mode: BlockHandlesMode) => void;
    /** Apply + persist a font preset (slash-menu action; works with the bar hidden). */
    chooseFontPreset: (preset: FontPreset) => void;
    /** Step the content font size up/down (slash-menu action; works with the bar hidden). */
    stepFontSize: (delta: 1 | -1) => void;
    /** Toggle a proofread option (slash-menu action; works with the bar hidden). */
    toggleProofread: (key: ProofreadOptionKey) => void;
    /** Whether the bar is currently shown (drives the slash toggle's label). */
    isVisible: () => boolean;
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
    // (see computeZones). The ⋯ overflow menu collapses the left zone's
    // tail on narrow panes (see setupOverflow).
    const leftZone = document.createElement("div");
    leftZone.className = "tb-zone tb-zone--left";
    const rightZone = document.createElement("div");
    rightZone.className = "tb-zone tb-zone--right";
    toolbar.append(leftZone, rightZone);

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
    let currentFontPreset: FontPreset = window.__i18n?.fontPreset ?? DEFAULT_FONT_PRESET;
    // Effective per-preset stacks (user's fontFamilySans/Serif/Mono overrides
    // applied by the extension) — used for the row previews and button glyph.
    let currentFontStacks: FontStacks = window.__i18n?.fontStacks ?? FONT_PRESET_STACKS;
    const fontEntries: { preset: FontPreset; item: CheckItem }[] = [];
    // The picker button's "A" glyph, rendered in the active preset's stack so
    // the control previews its own choice.
    let fontLabelEl: HTMLElement | null = null;
    // The "editor" preset has no stack of its own — previews render in the
    // VS Code editor font it inherits.
    const EDITOR_FONT = "var(--vscode-editor-font-family, monospace)";
    function setFontActive(preset: FontPreset, stacks?: FontStacks): void {
        currentFontPreset = preset;
        if (stacks) {
            currentFontStacks = stacks;
        }
        for (const { preset: p, item } of fontEntries) {
            item.setChecked(p === preset);
            item.label.style.fontFamily = p === "editor" ? EDITOR_FONT : currentFontStacks[p];
        }
        if (fontLabelEl) {
            fontLabelEl.style.fontFamily =
                preset === "editor" ? EDITOR_FONT : currentFontStacks[preset];
        }
    }
    // ── Font size state ──
    // Percent of the VS Code editor font size (100 = same). Like the preset,
    // the persisted value is echoed back by the extension after the settings
    // write, which re-syncs the stepper via setFontSize() on the controller.
    let currentFontSize: number = clampFontSizePercent(
        window.__i18n?.fontSize ?? DEFAULT_FONT_SIZE_PERCENT,
    );
    let sizeValueEl: HTMLElement | null = null;
    let sizeDecBtn: HTMLButtonElement | null = null;
    let sizeIncBtn: HTMLButtonElement | null = null;
    function setFontSizeActive(size: number): void {
        currentFontSize = clampFontSizePercent(size);
        if (sizeValueEl) {
            sizeValueEl.textContent = `${currentFontSize}%`;
        }
        if (sizeDecBtn) {
            sizeDecBtn.disabled = currentFontSize <= MIN_FONT_SIZE_PERCENT;
        }
        if (sizeIncBtn) {
            sizeIncBtn.disabled = currentFontSize >= MAX_FONT_SIZE_PERCENT;
        }
    }
    function pickFontSize(size: number): void {
        if (size === currentFontSize) {
            return;
        }
        setFontSizeActive(size);
        // Apply immediately so repeated clicks give live feedback; the settings
        // round-trip re-broadcasts the same value to every open editor.
        document.documentElement.style.setProperty(
            "--content-font-scale",
            String(currentFontSize / 100),
        );
        notifySetFontSize(currentFontSize);
    }

    // ── Content width state ──
    // Full Width (fills the pane) / Fixed (capped at the maxContentWidth ch
    // setting), chosen via a segmented control. The active mode echoes back
    // from the extension after the settings write, re-syncing the segments.
    let currentContentWidth: ContentWidthMode = normalizeContentWidthMode(
        window.__i18n?.contentWidth ?? DEFAULT_CONTENT_WIDTH_MODE,
    );
    // Kept in sync with the extension's authoritative resolution so the
    // optimistic apply on a Fixed click never flashes a stale width after the
    // setting changes elsewhere.
    let fixedWidthCss = `${clampMaxWidthCh(window.__i18n?.maxContentWidth ?? DEFAULT_MAX_WIDTH_CH)}ch`;
    const widthSegments = new Map<ContentWidthMode, HTMLButtonElement>();
    function setContentWidthActive(mode: ContentWidthMode): void {
        currentContentWidth = normalizeContentWidthMode(mode);
        for (const [m, btnEl] of widthSegments) {
            const on = m === currentContentWidth;
            btnEl.classList.toggle("tb-seg-btn--on", on);
            btnEl.setAttribute("aria-checked", on ? "true" : "false");
        }
    }
    // Apply the max-width to the live document optimistically; the settings
    // round-trip re-broadcasts the resolved value to every open editor.
    function applyContentWidthLive(): void {
        document.documentElement.style.setProperty(
            "--editor-max-width",
            currentContentWidth === "fixed" ? fixedWidthCss : "none",
        );
        document.body.classList.toggle("editor-width-auto", currentContentWidth === "full");
    }
    function pickContentWidth(mode: ContentWidthMode): void {
        if (mode === currentContentWidth) {
            return;
        }
        setContentWidthActive(mode);
        applyContentWidthLive();
        notifySetContentWidth(mode);
    }

    // ── Resting block-handles state ──
    // Always / Headings / Hover (the `blockHandles` setting), radio rows
    // under the width control. The body class is the single source of truth
    // (baked in by the provider, kept current by the setBlockHandles echo),
    // so there is no cached mode here — the rows re-read it.
    const handleEntries = new Map<BlockHandlesMode, CheckItem>();
    function setBlockHandlesActive(mode: BlockHandlesMode): void {
        for (const [m, item] of handleEntries) {
            item.setChecked(m === mode);
        }
    }
    function pickBlockHandles(mode: BlockHandlesMode): void {
        if (mode === currentBlockHandlesMode()) {
            return;
        }
        setBlockHandlesActive(mode);
        // Apply immediately — the menu stays open, so the gutter updates in
        // view; the settings round-trip re-broadcasts to every open editor.
        applyBlockHandles(mode);
        notifySetBlockHandles(mode);
    }

    function createFontPicker(): HTMLElement {
        const fontWrap = document.createElement("div");
        fontWrap.className = "tb-fmt-wrap";

        const fontBtn = createMenuTrigger({
            html: `<span class="tb-fmt-label tb-fmt-label--font">A</span>${IconChevronDown}`,
            ariaLabel: t("Font"),
        });
        fontLabelEl = fontBtn.querySelector(".tb-fmt-label--font");

        const fontMenu = document.createElement("div");
        fontMenu.className = "tb-fmt-menu tb-font-menu";
        fontMenu.style.display = "none";

        // ── Content width: Full Width / Fixed segmented control ──
        // Full Width (default) fills the pane; Fixed caps the content at the
        // maxContentWidth ch setting and centers it. Clicks keep the menu open.
        const widthRow = document.createElement("div");
        widthRow.className = "tb-seg-row";
        widthRow.setAttribute("role", "radiogroup");
        widthRow.setAttribute("aria-label", t("Content width"));
        const widthLabels: Record<ContentWidthMode, { label: string; title: string }> = {
            full: { label: t("Full Width"), title: t("Full width — fill the pane") },
            fixed: { label: t("Fixed"), title: t("Fixed — cap at the configured max content width") },
        };
        for (const mode of CONTENT_WIDTH_MODES) {
            const segBtn = document.createElement("button");
            segBtn.type = "button";
            segBtn.className = "tb-seg-btn";
            segBtn.setAttribute("role", "radio");
            segBtn.textContent = widthLabels[mode].label;
            segBtn.title = widthLabels[mode].title;
            segBtn.setAttribute("aria-label", widthLabels[mode].title);
            segBtn.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                pickContentWidth(mode);
            });
            widthRow.appendChild(segBtn);
            widthSegments.set(mode, segBtn);
        }

        // ── Block handles: Always show / Headings and hover / Hover only ──
        // Which block handles stay visible at rest (hover always reveals).
        // Radio rows like the font-family presets below — the labels are too
        // long for segments — under a caption that names the subject. Clicks
        // keep the menu open so the gutter visibly updates.
        const handlesCaption = document.createElement("div");
        handlesCaption.className = "tb-seg-caption";
        handlesCaption.id = "tb-block-handles-caption";
        handlesCaption.textContent = t("Show Block Handles");
        const handlesLabels: Record<BlockHandlesMode, { label: string; title: string }> = {
            always: { label: t("Always show"), title: t("Every block's handle stays visible") },
            headings: { label: t("Headings and hover"), title: t("Heading badges stay visible; the rest appear on hover") },
            hover: { label: t("Hover only"), title: t("Handles appear only on hover") },
        };
        // The trio is one labelled group for assistive tech (the caption is
        // visual-only otherwise). role="group", not "radiogroup": the rows
        // are menuitemradio, whose ARIA container inside a menu is a group.
        // wireHoverMenu's roving rows() matches .tb-fmt-item DESCENDANTS of
        // the menu, so the extra wrapper is transparent to keyboard nav.
        const handlesGroup = document.createElement("div");
        handlesGroup.setAttribute("role", "group");
        handlesGroup.setAttribute("aria-labelledby", handlesCaption.id);
        for (const mode of BLOCK_HANDLES_DISPLAY_ORDER) {
            const item = createCheckItem(handlesLabels[mode].label);
            // Single-select trio, not independent toggles.
            item.el.setAttribute("role", "menuitemradio");
            item.el.title = handlesLabels[mode].title;
            item.el.setAttribute("aria-label", handlesLabels[mode].title);
            item.el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                pickBlockHandles(mode);
            });
            handlesGroup.appendChild(item.el);
            handleEntries.set(mode, item);
        }

        // ── Size stepper: A− <percent> A+ ──
        // Scales the document content (and frontmatter) relative to the VS Code
        // editor font size; clicking the percent resets to the default. Clicks
        // keep the menu open, like the checks menu, so steps can be repeated.
        const sizeRow = document.createElement("div");
        sizeRow.className = "tb-font-size-row";
        const sizeBtn = (
            cls: string,
            label: string,
            onPick: () => void,
        ): HTMLButtonElement => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = `tb-font-size-btn ${cls}`;
            b.textContent = "A";
            b.title = label;
            b.setAttribute("aria-label", label);
            b.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                onPick();
            });
            return b;
        };
        sizeDecBtn = sizeBtn("tb-font-size-btn--dec", t("Decrease font size"), () =>
            pickFontSize(stepFontSizePercent(currentFontSize, -1)),
        );
        sizeIncBtn = sizeBtn("tb-font-size-btn--inc", t("Increase font size"), () =>
            pickFontSize(stepFontSizePercent(currentFontSize, 1)),
        );
        sizeValueEl = document.createElement("button");
        sizeValueEl.setAttribute("type", "button");
        sizeValueEl.className = "tb-font-size-value";
        sizeValueEl.title = t("Reset font size");
        sizeValueEl.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            pickFontSize(DEFAULT_FONT_SIZE_PERCENT);
        });
        sizeRow.append(sizeDecBtn, sizeValueEl, sizeIncBtn);

        // ── Font family presets ──
        // "Editor font" (the default) follows the VS Code editor font; the
        // other presets use their stack, user-customizable via the
        // fontFamilySans/Serif/Mono settings. Each row previews its own font.
        const choices: { preset: FontPreset; label: string; stack: string }[] = [
            { preset: "editor", label: t("Editor font"), stack: EDITOR_FONT },
            { preset: "sans", label: t("Sans serif"), stack: currentFontStacks.sans },
            { preset: "serif", label: t("Serif"), stack: currentFontStacks.serif },
            { preset: "mono", label: t("Monospace"), stack: currentFontStacks.mono },
        ];
        const fontItemEls: HTMLElement[] = [];
        for (const { preset, label, stack } of choices) {
            const item = createCheckItem(label);
            item.el.classList.add("tb-font-item");
            if (stack) {
                item.label.style.fontFamily = stack; // preview the font on its own label
            }
            item.el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Shared close, never a direct hide: it owns the Escape-layer
                // unregister (a direct hide leaks the entry and the next
                // editor-focused Escape dies on it) and the aria state.
                closeFontMenu();
                setFontActive(preset);
                notifySetFontPreset(preset);
            });
            fontItemEls.push(item.el);
            fontEntries.push({ preset, item });
        }

        // Jump to the native Settings UI filtered to the font settings, where
        // the per-preset stacks (fontFamilySans/Serif/Mono) can be customized.
        // Grouped with the family presets above it (no divider between them).
        const fontSettingsEntry = document.createElement("div");
        fontSettingsEntry.className = "tb-fmt-item";
        fontSettingsEntry.textContent = t("Font settings");
        fontSettingsEntry.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeFontMenu();
            notifyOpenSettings("birta.font");
        });

        // Assemble top→bottom: font size, content width + block handles
        // (the two page-layout controls share a group), the family presets,
        // then Font settings — each group separated by a divider.
        fontMenu.append(
            sizeRow,
            makeSep(),
            widthRow,
            handlesCaption,
            handlesGroup,
            makeSep(),
            ...fontItemEls,
            makeSep(),
            fontSettingsEntry,
        );

        setFontActive(currentFontPreset);
        setFontSizeActive(currentFontSize);
        setContentWidthActive(currentContentWidth);
        setBlockHandlesActive(currentBlockHandlesMode());

        // The item handlers above close over closeFontMenu; they only ever run
        // after this wiring (the menu must be open to click a row).
        const { close: closeFontMenu } = wireHoverMenu(fontWrap, fontBtn, fontMenu);

        fontWrap.appendChild(fontBtn);
        fontWrap.appendChild(fontMenu);
        return fontWrap;
    }

    // ── Block-type dropdown (opens on hover, same style as the floating toolbar) ──
    const fmtWrap = document.createElement("div");
    fmtWrap.className = "tb-fmt-wrap";

    const fmtBtn = createMenuTrigger({
        html: `<span class="tb-fmt-label">P</span>${IconChevronDown}`,
        ariaLabel: t("Format"),
    });

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

    const fmtItems: FillItem[] = [];
    formats.forEach(([label, action]) => {
        const item = createFillItem(label);
        item.el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            action();
            // Shared close (owns the Escape-layer unregister) — never a
            // direct hide, which would leak the layer entry.
            closeFmtMenu();
        });
        fmtMenu.appendChild(item.el);
        fmtItems.push(item);
    });

    const { close: closeFmtMenu } = wireHoverMenu(fmtWrap, fmtBtn, fmtMenu);

    fmtWrap.appendChild(fmtBtn);
    fmtWrap.appendChild(fmtMenu);
    items.format = wrap("format", fmtWrap);

    // ── Font picker (serif / sans-serif / monospace presets) ──
    items.fontPreset = wrap("fontPreset", createFontPicker());

    // ── Inline formatting ─────────────────────────────
    // Button refs kept so onSelectionChange can light up the mark currently under
    // the caret (the toolbar reflects the selection's state).
    const boldBtn = btn(IconBold, t("Bold") + " " + kbd("Mod-b"), () =>
        runEditorCommand("toggleBold", getEditor));
    items.bold = wrap("bold", boldBtn);
    const italicBtn = btn(IconItalic, t("Italic") + " " + kbd("Mod-i"), () =>
        runEditorCommand("toggleItalic", getEditor));
    items.italic = wrap("italic", italicBtn);
    const strikeBtn = btn(
        IconStrikethrough,
        t("Strikethrough") + " " + kbd("Mod-Shift-x"),
        () => runEditorCommand("toggleStrikethrough", getEditor),
    );
    items.strikethrough = wrap("strikethrough", strikeBtn);
    const highlightBtn = btn(IconHighlighter, t("Highlight"), () =>
        runEditorCommand("toggleHighlight", getEditor));
    items.highlight = wrap("highlight", highlightBtn);
    const inlineCodeBtn = btn(IconCode, t("Inline Code") + " " + kbd("Mod-e"), () =>
        runEditorCommand("toggleInlineCode", getEditor));
    items.inlineCode = wrap("inlineCode", inlineCodeBtn);
    items.clearFormatting = wrap("clearFormatting", btn(IconEraser, t("Clear Formatting"), () =>
        runEditorCommand("clearFormatting", getEditor),
    ));

    // ── Insert ────────────────────────────────────────
    // Link: capture the current selection text and any existing link first,
    // then collect text and URL through the link palette, anchored at the
    // captured range itself. Also invoked by the Cmd/Ctrl+K shortcut
    // (webview/keyboardShortcuts.ts), so it is exposed on the returned
    // controller as openLinkPrompt.
    let linkBtnEl: HTMLButtonElement;
    const openLinkPrompt = (): void => {
        const editor = getEditor();
        if (!editor) {
            return;
        }

        const view = editor.action((ctx) => getView(ctx));
        const { state } = view;
        const linkType = state.schema.marks["link"];
        if (!linkType) {
            return;
        }

        const capturedFrom = state.selection.from;
        let capturedTo = state.selection.to;
        let existingHref = "";
        let selectedText = "";

        // A selection spanning several textblocks (paragraphs, headings,
        // list items, ...) cannot become ONE inline link without fusing
        // the blocks' texts together. Clamp to the portion inside the
        // first textblock: the editor pre-fills and the apply covers
        // that range only, leaving the other blocks untouched.
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

        // Anchor the editor at the captured range (coordsAtPos returns
        // viewport coordinates, matching the popup's positioning). When
        // measurement fails (jsdom, detached view) fall back to the link
        // button / toolbar.
        let anchorRect: { left: number; right: number; top: number; bottom: number };
        try {
            const start = view.coordsAtPos(capturedFrom);
            const end = view.coordsAtPos(capturedTo, -1);
            anchorRect = {
                left: Math.min(start.left, end.left),
                right: Math.max(start.right, end.right),
                top: Math.min(start.top, end.top),
                bottom: Math.max(start.bottom, end.bottom),
            };
        } catch {
            const near = linkBtnEl.isConnected ? linkBtnEl : toolbar;
            const r = near.getBoundingClientRect();
            anchorRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }

        // Open the single link editor (the hover popup) at the captured
        // range. The popup owns the transaction, the pending-range highlight,
        // and returning focus to the editor on close. It is a singleton, so a
        // second open (Cmd/Ctrl+K twice, or the button while it is up) simply
        // re-anchors the same editor rather than stacking a second one.
        openLinkEditor({
            view,
            anchorRect,
            from: capturedFrom,
            to: capturedTo,
            text: selectedText,
            href: existingHref,
        });
    };
    // No shortcut label: insert-link is a user-rebindable contributed
    // keybinding and the webview cannot query its effective binding.
    linkBtnEl = btn(
        IconLink,
        t("Insert/Edit Link"),
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
                    const view = getView(ctx);
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
    const tableBtn = btn(IconTable, t("Insert Table"), () =>
        runEditorCommand("insertTable", getEditor));
    items.table = wrap("table", tableBtn);
    const footnoteBtnEl = btn(IconFootnote, t("Insert Footnote"), () =>
        runEditorCommand("insertFootnote", getEditor),
    );
    items.footnote = wrap("footnote", footnoteBtnEl);
    const mathBtnEl = btn(IconMath, t("Inline Math"), () =>
        runEditorCommand("insertMath", getEditor),
    );
    items.math = wrap("math", mathBtnEl);

    // ── Lists dropdown (bullet / ordered / task) ──
    // One hover-menu picker with an icon+label row per list type. Each row is a
    // TOGGLE (clicking the active one again lifts out of the list), not a
    // select-one, and the caret is often in no list at all — so the active list
    // is marked with a filled/accent row (the toolbar's "on" idiom, like the
    // segmented width control) rather than a leading checkmark. A checkmark would
    // reserve an empty gutter in the common "not in a list" case and, beside the
    // row icons, read as a broken two-column layout. onSelectionChange refreshes
    // which row (if any) is active. The three standalone list buttons collapsed
    // into this to slim the default bar.
    type ListType = "bullet" | "ordered" | "task";
    const listRows: { type: ListType; setActive: (on: boolean) => void }[] = [];
    // Trigger refs for the container dropdowns, so onSelectionChange can light up
    // the bar button when the caret is inside that container (like the mark
    // buttons). The menu row shows WHICH one; the trigger shows THAT one.
    let listTriggerBtn: HTMLElement | null = null;
    function createListPicker(): HTMLElement {
        const listWrap = document.createElement("div");
        listWrap.className = "tb-fmt-wrap";

        const listBtn = createMenuTrigger({
            html: IconList + IconChevronDown,
            ariaLabel: t("Lists"),
        });
        listTriggerBtn = listBtn;

        const listMenu = document.createElement("div");
        listMenu.className = "tb-fmt-menu tb-list-menu";
        listMenu.style.display = "none";
        listMenu.setAttribute("role", "menu");

        const choices: { type: ListType; icon: string; label: string; command: string }[] = [
            { type: "bullet", icon: IconList, label: t("Bullet List"), command: "toggleBulletList" },
            { type: "ordered", icon: IconListOrdered, label: t("Ordered List"), command: "toggleOrderedList" },
            { type: "task", icon: IconCheckSquare, label: t("Task List"), command: "toggleTaskList" },
        ];
        for (const { type, icon, label, command } of choices) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "tb-fmt-item tb-list-item";
            row.setAttribute("role", "menuitemcheckbox");
            row.setAttribute("aria-checked", "false");
            const iconEl = document.createElement("span");
            iconEl.className = "tb-list-item-icon";
            iconEl.innerHTML = icon;
            const labelEl = document.createElement("span");
            labelEl.className = "tb-list-item-label";
            labelEl.textContent = label;
            row.append(iconEl, labelEl);
            row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                runEditorCommand(command, getEditor);
                closeListMenu(); // shared close — owns the Escape-layer unregister
            });
            listMenu.appendChild(row);
            listRows.push({
                type,
                setActive: (on: boolean): void => {
                    row.classList.toggle("tb-list-item--on", on);
                    row.setAttribute("aria-checked", on ? "true" : "false");
                },
            });
        }

        const { close: closeListMenu } = wireHoverMenu(listWrap, listBtn, listMenu);

        listWrap.appendChild(listBtn);
        listWrap.appendChild(listMenu);
        return listWrap;
    }
    items.listMenu = wrap("listMenu", createListPicker());

    // ── Code dropdown (plain code block + Mermaid diagram + Math block) ──
    // Mermaid and a math block are both just fenced code blocks with a set
    // language, so they live in one "Code" family dropdown alongside the plain
    // block — mirroring the Quote picker. The top row inserts a plain code
    // block; below a separator, Mermaid and Math Block bake in their fence
    // language. All three are also in the slash menu.
    type CodeRowKey = "code" | "mermaid" | "math";
    const codeRows: { key: CodeRowKey; setActive: (on: boolean) => void }[] = [];
    let codeTriggerBtn: HTMLElement | null = null;
    function createCodePicker(): HTMLElement {
        const codeWrap = document.createElement("div");
        codeWrap.className = "tb-fmt-wrap";

        const codeBtn = createMenuTrigger({
            html: IconTerminal + IconChevronDown,
            ariaLabel: t("Code Block"),
        });
        codeTriggerBtn = codeBtn;

        const codeMenu = document.createElement("div");
        codeMenu.className = "tb-fmt-menu tb-callout-menu";
        codeMenu.style.display = "none";
        codeMenu.setAttribute("role", "menu");

        // `key` matches computeToolbarActiveState().code so onSelectionChange can
        // fill the row for the code block you're inside.
        const addRow = (key: CodeRowKey, icon: string, label: string, run: () => void): void => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "tb-fmt-item tb-callout-item";
            row.setAttribute("role", "menuitemcheckbox");
            row.setAttribute("aria-checked", "false");
            row.innerHTML = icon;
            const name = document.createElement("span");
            name.textContent = label;
            row.appendChild(name);
            row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                run();
                closeCodeMenu(); // shared close — owns the Escape-layer unregister
            });
            codeMenu.appendChild(row);
            codeRows.push({
                key,
                setActive: (on: boolean): void => {
                    row.classList.toggle("tb-callout-item--on", on);
                    row.setAttribute("aria-checked", on ? "true" : "false");
                },
            });
        };

        // Plain code block first — the common case and the dropdown's identity.
        addRow("code", IconTerminal, t("Code Block"), () => runEditorCommand("insertCodeBlock", getEditor));

        codeMenu.appendChild(makeSep());

        // Language-typed blocks (same insertCodeBlock command, fence language baked in).
        addRow("mermaid", IconNetwork, t("Mermaid Diagram"), () => runEditorCommand("insertCodeBlock", getEditor, "mermaid"));
        addRow("math", IconMath, t("Math Block"), () => runEditorCommand("insertCodeBlock", getEditor, "LaTeX"));

        const { close: closeCodeMenu } = wireHoverMenu(codeWrap, codeBtn, codeMenu);

        codeWrap.appendChild(codeBtn);
        codeWrap.appendChild(codeMenu);
        return codeWrap;
    }
    items.codeBlock = wrap("codeBlock", createCodePicker());
    const hrBtnEl = btn(IconMinus, t("Horizontal Rule"), () =>
        runEditorCommand("insertHorizontalRule", getEditor),
    );
    items.horizontalRule = wrap("horizontalRule", hrBtnEl);

    // ── Quote dropdown (plain blockquote + GitHub callout types) ──
    // A callout is a typed blockquote, so the two live in one "Quote" family
    // dropdown: the top row toggles a plain blockquote; below a separator, one
    // row per callout type inserts a callout of that kind (insertCallout takes a
    // kind arg). Folding the two together frees a toolbar slot and surfaces the
    // callout types on the default (visible) bar, where the standalone Callouts
    // dropdown used to ship hidden.
    const quoteRows: { key: string; setActive: (on: boolean) => void }[] = [];
    let quoteTriggerBtn: HTMLElement | null = null;
    function createQuotePicker(): HTMLElement {
        const quoteWrap = document.createElement("div");
        quoteWrap.className = "tb-fmt-wrap";

        const quoteBtn = createMenuTrigger({
            html: IconQuote + IconChevronDown,
            ariaLabel: t("Quote"),
        });
        quoteTriggerBtn = quoteBtn;

        const quoteMenu = document.createElement("div");
        quoteMenu.className = "tb-fmt-menu tb-callout-menu";
        quoteMenu.style.display = "none";
        quoteMenu.setAttribute("role", "menu");

        // `key` matches computeToolbarActiveState().quote ("blockquote" or a
        // callout kind) so onSelectionChange can fill the row you're inside.
        const addRow = (key: string, icon: string, label: string, run: () => void): void => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "tb-fmt-item tb-callout-item";
            row.setAttribute("role", "menuitemcheckbox");
            row.setAttribute("aria-checked", "false");
            row.innerHTML = icon;
            const name = document.createElement("span");
            name.textContent = label;
            row.appendChild(name);
            // mousedown (not click): wireHoverMenu activates rows via a
            // synthetic mousedown.
            row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                run();
                closeQuoteMenu(); // shared close — owns the Escape-layer unregister
            });
            quoteMenu.appendChild(row);
            quoteRows.push({
                key,
                setActive: (on: boolean): void => {
                    row.classList.toggle("tb-callout-item--on", on);
                    row.setAttribute("aria-checked", on ? "true" : "false");
                },
            });
        };

        // Plain blockquote first — the common case, and the dropdown's identity.
        addRow("blockquote", IconQuote, t("Blockquote"), () => runEditorCommand("toggleBlockquote", getEditor));

        quoteMenu.appendChild(makeSep());

        const calloutKinds: [CalloutKind, string][] = [
            ["note", t("Note")],
            ["tip", t("Tip")],
            ["important", t("Important")],
            ["warning", t("Warning")],
            ["caution", t("Caution")],
        ];
        for (const [kind, label] of calloutKinds) {
            // toggleCallout keeps the checkbox honest: the checked kind
            // lifts out, another kind retypes in place, outside wraps —
            // insertCallout itself now always nests (slash/block menus).
            addRow(kind, CALLOUT_ICONS[kind], label, () => runEditorCommand("toggleCallout", getEditor, kind));
        }

        const { close: closeQuoteMenu } = wireHoverMenu(quoteWrap, quoteBtn, quoteMenu);

        quoteWrap.appendChild(quoteBtn);
        quoteWrap.appendChild(quoteMenu);
        return quoteWrap;
    }
    items.quote = wrap("quote", createQuotePicker());

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
        dbgBtn.setAttribute("aria-label", t("Debug"));
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
            closeDbgMenu(); // shared close — owns the Escape-layer unregister
            const editor = getEditor();
            if (!editor) {
                return;
            }
            const view: EditorView = editor.action((ctx) =>
                getView(ctx),
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

        const { close: closeDbgMenu } = wireHoverMenu(dbgWrap, dbgBtn, dbgMenu);

        dbgItem = wrap("debug", dbgWrap);
    }

    // ── Disk-drift badge (pinned at the front of the right zone, not
    //    user-placeable; hidden unless the extension flags disk drift: the file
    //    changed on disk while there are unsaved edits). Advisory only —
    //    clicking opens the native reload/compare picker; nothing auto-edits. ──
    let syncConflictVisible = false;
    const syncConflictItem = wrap(
        "syncConflict",
        btn(
            IconAlertTriangle,
            t("This file changed on disk since your last edit — click to reload or compare"),
            () => notifyResolveSyncConflict(),
            "tb-sync-conflict-btn",
        ),
    );
    syncConflictItem.style.display = "none";

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

    // Every option key except the gate maps 1:1 to a boolean ProofreadConfig
    // field (the gate's key "proofreading" ↔ field "proofreadingEnabled"), so the
    // domain rows use this narrowed key and index the config directly.
    type DomainCheckKey = Exclude<ProofreadOptionKey, "proofreading">;
    type CheckRow = { key: DomainCheckKey; item: CheckItem };
    const checkRows: CheckRow[] = [];
    // Two levels of show/hide, both by *detaching* the container (not dimming):
    //   • the whole body (domain masters + style sub-checks) is detached when the
    //     master Proofreading gate is off, so the menu collapses to just the gate;
    //   • the style sub-checks are detached when Check style is off.
    // Detaching (not display:none) also keeps hidden rows out of keyboard focus,
    // since hoverMenu.rows() only skips a row by its own inline display, not an
    // ancestor's. All refs are assigned when the menu is built.
    let checksMenuEl: HTMLElement | null = null;
    let bodyEl: HTMLElement | null = null;
    let styleChildrenEl: HTMLElement | null = null;
    // The master "Proofreading" gate switch (handled separately from checkRows
    // because its config field name differs from its option key).
    let masterItem: CheckItem | null = null;

    /** Attach `child` into `parent` iff `show`, else detach it. */
    const setAttached = (parent: HTMLElement, child: HTMLElement, show: boolean): void => {
        if (show && !child.isConnected) { parent.appendChild(child); }
        else if (!show && child.isConnected) { child.remove(); }
    };

    const repaintChecks = (cfg: ProofreadConfig): void => {
        for (const { key, item } of checkRows) {
            item.setChecked(Boolean(cfg[key]));
        }
        masterItem?.setChecked(cfg.proofreadingEnabled);
        // Signal a globally-off gate on the toolbar button itself: with the gate
        // off there are simply no underlines, which looks identical to clean
        // text, so dim the button to say "proofreading is off" without opening
        // the menu. (A domain being off is a per-check choice, not shown here.)
        checksBtn.classList.toggle("tb-checks-btn--off", !cfg.proofreadingEnabled);
        // Gate: the whole body shows only while the master switch is on.
        if (checksMenuEl && bodyEl) {
            setAttached(checksMenuEl, bodyEl, cfg.proofreadingEnabled);
        }
        // Nested: style sub-checks show only while Check style is on (and, since
        // they live inside the body, only when the gate is on too).
        if (bodyEl && styleChildrenEl) {
            setAttached(bodyEl, styleChildrenEl, cfg.styleCheck);
        }
    };

    /** Flip one proofread toggle — shared by the Checks rows and slash menu. */
    function toggleProofread(key: ProofreadOptionKey): void {
        // The gate is a special case (its field name differs); everything else is
        // a boolean field keyed by its own name.
        if (key === "proofreading") { toggleProofreadingGate(); return; }
        const view = getEditorView();
        if (!view) { return; }
        const cfg = getProofreadConfig(view);
        const field = key as DomainCheckKey;
        const value = !cfg[field];
        setProofreadConfig(view, { ...cfg, [field]: value });
        notifySetProofreadOption(field, value);
    }

    /**
     * Flip the master proofreading gate. Unlike the domain rows, its config field
     * (`proofreadingEnabled`) differs from its option key (`proofreading`), and it
     * never touches the per-domain switches — so turning it back on restores
     * exactly what was enabled before. Mirrors the `toggleProofreading` command.
     */
    function toggleProofreadingGate(): void {
        const view = getEditorView();
        if (!view) { return; }
        const cfg = getProofreadConfig(view);
        const value = !cfg.proofreadingEnabled;
        setProofreadConfig(view, { ...cfg, proofreadingEnabled: value });
        notifySetProofreadOption("proofreading", value);
    }

    function createChecksControl(): HTMLElement {
        const wrapEl = document.createElement("div");
        wrapEl.className = "tb-fmt-wrap tb-checks-wrap";
        wrapEl.appendChild(checksBtn);

        const menu = document.createElement("div");
        menu.className = "tb-fmt-menu tb-checks-menu";
        menu.style.display = "none";
        menu.setAttribute("role", "menu");
        checksMenuEl = menu;

        const addRow = (parent: HTMLElement, key: DomainCheckKey, label: string): void => {
            const item = createSwitchItem(label);
            item.el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleProofread(key);
                // Menu stays open so several checks can be toggled in a row.
            });
            parent.appendChild(item.el);
            checkRows.push({ key, item });
        };
        const addHeader = (parent: HTMLElement, title: string): void => {
            const header = document.createElement("div");
            header.className = "tb-fmt-header";
            header.textContent = title;
            parent.appendChild(header);
        };

        // Master "Proofreading" gate — the top-level switch that governs
        // everything below. Flipping it off silences spelling, grammar, and style
        // at once and hides the rest of the menu; flipping it on brings back
        // exactly what was enabled before (it never rewrites the domain switches).
        // It's emphasized (tb-checks-master) but otherwise the same switch idiom.
        masterItem = createSwitchItem(t("Proofreading"));
        masterItem.el.classList.add("tb-checks-master");
        masterItem.el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleProofreadingGate();
        });
        menu.appendChild(masterItem.el);

        // The body holds everything the gate governs. A leading separator sits
        // inside it so that when the gate is off and the body is detached, the
        // menu collapses cleanly to just the master switch (no dangling divider).
        const body = document.createElement("div");
        body.className = "tb-checks-body";
        bodyEl = body;
        body.appendChild(makeSep());

        // Domain masters
        addRow(body, "spellCheck", t("Check spelling"));
        addRow(body, "grammarCheck", t("Check grammar"));
        addRow(body, "styleCheck", t("Check style"));

        // Style sub-checks live in their own indented container (a left rail ties
        // them to the "Check style" master above), shown only while it's on.
        const children = document.createElement("div");
        children.className = "tb-checks-children";
        styleChildrenEl = children;

        const groups: { title: string; opts: [DomainCheckKey, string][] }[] = [
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
            addHeader(children, group.title);
            for (const [key, label] of group.opts) { addRow(children, key, label); }
        }
        body.appendChild(children); // repaintChecks detaches it when Check style is off
        menu.appendChild(body); // repaintChecks detaches it when the gate is off

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
    // Same code path as the switch-to-text-editor keybinding and the tab-bar
    // button (the callback captures the first visible source line so the
    // viewport is preserved). No shortcut labels on these tooltips: both are
    // user-rebindable contributed keybindings and the webview cannot query
    // their effective bindings.
    if (onSwitchToSource) {
        items.viewSource = wrap("viewSource", btn(
            IconFileCode,
            t("Edit Raw Markdown"),
            onSwitchToSource,
        ));
    }
    if (onOpenFind) {
        items.find = wrap("find", btn(IconSearch, t("Find"), onOpenFind));
    }
    // Settings gear is a hover dropdown: open the native settings, or enter the
    // drag-and-drop "Customize toolbar" mode.
    function createSettingsMenu(): HTMLElement {
        const wrapEl = document.createElement("div");
        wrapEl.className = "tb-fmt-wrap";

        const gearBtn = createMenuTrigger({
            html: IconSettings + IconChevronDown,
            ariaLabel: t("Settings"),
        });

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
                closeSettingsMenu(); // shared close — owns the Escape-layer unregister
                onSelect();
            });
            menu.appendChild(entry);
        };
        // The entries mirror the toolbar right-click menu exactly: both are
        // built from TOOLBAR_MENU_COMMANDS (shared/editorCommands.ts), so ids,
        // order, and labels can't drift, and both draw a separator on every
        // `menuGroup` change — here via makeSep(), natively via the
        // 1_layout/2_shortcuts/3_settings group prefixes (the contributions
        // test guards the package.json side). Edit Keyboard Shortcuts opens
        // the native UI filtered to this extension, where the user's
        // effective (possibly rebound) bindings are accurate.
        const menuActions: Record<string, () => void> = {
            customizeToolbar: () => startCustomize(),
            hideToolbar: () => setToolbarVisible(false),
            // Show (the in-editor cheatsheet overlay) above Edit (the native
            // UI) — table order in TOOLBAR_MENU_COMMANDS.
            openShortcutsHelp: () => openShortcutsHelp(),
            openKeyboardShortcuts: () => notifyOpenKeybindings(),
            openExtensionSettings: () => notifyOpenSettings(),
        };
        let prevGroup: string | undefined;
        for (const meta of TOOLBAR_MENU_COMMANDS) {
            const action = menuActions[meta.id];
            if (!action) { continue; }
            if (prevGroup !== undefined && meta.menuGroup !== prevGroup) {
                menu.appendChild(makeSep());
            }
            prevGroup = meta.menuGroup;
            // The settings row names the product with the RUNTIME display
            // name, so a rename never leaves the menu stale.
            const label = meta.id === "openExtensionSettings"
                ? settingsMenuTitle(productName)
                : t(meta.title);
            addEntry(label, action);
        }

        const { close: closeSettingsMenu } = wireHoverMenu(wrapEl, gearBtn, menu);

        wrapEl.appendChild(gearBtn);
        wrapEl.appendChild(menu);
        return wrapEl;
    }
    items.settings = wrap("settings", createSettingsMenu());

    // ── Overflow (⋯) menu for the left zone on narrow panes ──
    // Reuses the tb-fmt-wrap hover/positioning pattern; collapsed items are
    // physically reparented into the panel so listeners survive.
    const moreWrap = document.createElement("div");
    moreWrap.className = "tb-fmt-wrap tb-more-wrap";
    moreWrap.style.display = "none";

    const moreBtn = createMenuTrigger({
        text: "⋯",
        className: "tb-btn tb-more-btn",
        ariaLabel: t("More"),
    });

    const moreMenu = document.createElement("div");
    moreMenu.className = "tb-more-menu";
    moreMenu.style.display = "none";

    wireHoverMenu(moreWrap, moreBtn, moreMenu);

    moreWrap.appendChild(moreBtn);
    moreWrap.appendChild(moreMenu);
    leftZone.appendChild(moreWrap);

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

    // ── Whole-bar visibility (birta.toolbar.visible) ──
    // Hiding slides the fixed topbar up (a body class the CSS keys off) and
    // shows a slim expand tab at the top edge (the TOC toggle tab, rotated to
    // the horizontal axis). The bar is hidden, not destroyed, so its host
    // hooks (link prompt, image panel, find) keep serving the slash menu and
    // command palette while it is off screen.
    let toolbarVisible = latestConfig?.visible !== false;

    const showTab = createButton({
        className: "toolbar-toggle-tab",
        icon: IconChevronDown,
        title: t("Show toolbar"),
        onClick: () => setToolbarVisible(true),
    });
    // The tab carries its own context section so its right-click menu offers
    // exactly "Show Toolbar" — the hidden state must never read "Hide Toolbar".
    showTab.dataset["vscodeContext"] = JSON.stringify({
        webviewSection: "toolbarTab",
        preventDefaultContextMenuItems: true,
    });
    document.body.appendChild(showTab);

    function applyVisibility(visible: boolean): void {
        toolbarVisible = visible;
        topbar.classList.toggle("editor-topbar--hidden", !visible);
        document.body.classList.toggle("toolbar-hidden", !visible);
        // The TOC anchors its panel and tab to the topbar's bottom edge;
        // nudge it (and anything else geometry-bound) to re-measure.
        window.dispatchEvent(new Event("resize"));
    }

    /** Optimistic write-through; the setting echo arrives as a toolbarConfig. */
    function setToolbarVisible(visible: boolean): void {
        if (visible === toolbarVisible) {
            return;
        }
        applyVisibility(visible);
        notifySetToolbarVisible(visible);
    }


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
            zones: { left: leftZone, right: rightZone, hidden: trayItems },
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

    // Width available to the collapsible (left-zone) items = toolbar minus
    // the right zone's CONTENT. The zones fill their flex tracks, so
    // scrollWidth/clientWidth report the (large) track width, not the
    // content — using those made a lone item look like it overflowed. Sum
    // the right items' own widths instead; the left items are the overflow
    // groups themselves, so the controller already accounts for them. The
    // slack absorbs the inter-zone gaps.
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
    function availableWidth(): number {
        return Math.max(
            0,
            toolbar.clientWidth - measureContentWidth(rightZone) - ZONE_GAP_SLACK,
        );
    }

    function setupOverflow(): void {
        // The left zone holds every collapsible item (the right zone's
        // utilities never collapse); each group's comment marker remembers
        // its home slot.
        const wrappers = Array.from(leftZone.children).filter(
            (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("tb-item"),
        );
        const groups: OverflowGroup[] = wrappers.map((el) => ({
            name: el.dataset["itemId"] ?? "",
            el,
            sepBefore: null,
        }));
        // Collapse from the end of the left zone; never collapse the format
        // (text-level) dropdown — it is the toolbar's anchor control.
        const collapseOrder = groups
            .map((_, i) => i)
            .filter((i) => groups[i]!.name !== "format")
            .reverse();
        overflow = createOverflowController({
            groups,
            collapseOrder,
            moreWrap,
            panel: moreMenu,
        });
        overflow.update(availableWidth());
        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => overflow?.update(availableWidth()));
            resizeObserver.observe(toolbar);
        }
    }

    function render(config: ToolbarConfig | undefined): void {
        resizeObserver?.disconnect();
        resizeObserver = null;
        overflow = null;
        // Detach every item wrapper (from its zone or the ⋯ panel) plus any
        // stale overflow markers; the persistent moreWrap is re-homed below.
        moreWrap.remove();
        leftZone.replaceChildren();
        rightZone.replaceChildren();
        moreMenu.replaceChildren();

        const zones = computeZones(config);
        for (const id of zones.left) {
            const el = items[id];
            if (el) { leftZone.appendChild(el); }
        }
        for (const id of zones.right) {
            const el = items[id];
            if (el) { rightZone.appendChild(el); }
        }
        // The ⋯ button sits at the end of the left zone, after the
        // collapsible tail.
        leftZone.appendChild(moreWrap);

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

        // Disk-drift badge: pinned at the front of the right zone.
        rightZone.insertBefore(syncConflictItem, rightZone.firstChild);
        syncConflictItem.style.display = syncConflictVisible ? "" : "none";

        setupOverflow();
    }

    render(window.__i18n?.toolbar);
    if (!toolbarVisible) {
        applyVisibility(false);
    }

    // Expose the toolbar-owned actions to the shared editor-command registry so
    // the command palette / context menu reach the exact same code paths.
    // (openFindReplace, toggleToc and editFrontmatter are wired in index.ts.)
    setEditorCommandHost({
        openLinkPrompt,
        openImagePanel,
        ...(onOpenFind ? { openFind: onOpenFind } : {}),
        // Toolbar right-click menu entries (mirroring the settings gear).
        hideToolbar: () => setToolbarVisible(false),
        showToolbar: () => setToolbarVisible(true),
        customizeToolbar: startCustomize,
        openExtensionSettings: () => notifyOpenSettings(),
        openKeyboardShortcuts: () => notifyOpenKeybindings(),
        // Font/proofread controls — the same code paths as the toolbar rows and
        // the slash menu, reachable from the palette even with the bar hidden.
        chooseFontPreset: (preset) => {
            setFontActive(preset);
            notifySetFontPreset(preset);
        },
        stepFontSize: (delta) => pickFontSize(stepFontSizePercent(currentFontSize, delta)),
        toggleProofread,
        toggleToolbar: () => setToolbarVisible(!toolbarVisible),
    });

    // Reflect a derived active-state across the whole bar. Split out from
    // onSelectionChange so the same wiring drives the "detached" state (focus in a
    // contenteditable island outside ProseMirror — see setDetached below).
    const applyActiveState = (active: ToolbarActiveState): void => {
        // Bar buttons: quiet toggle-on for the inline mark / container / selected
        // atom the caret sits on. A hidden/overflowed button still exists —
        // toggling its class is harmless.
        const setBtnActive = (el: HTMLElement | null, on: boolean): void => {
            el?.classList.toggle("tb-btn--active", on);
        };
        setBtnActive(boldBtn, active.marks.bold);
        setBtnActive(italicBtn, active.marks.italic);
        setBtnActive(strikeBtn, active.marks.strikethrough);
        setBtnActive(highlightBtn, active.marks.highlight);
        setBtnActive(inlineCodeBtn, active.marks.inlineCode);
        // A real `[text](url)` link is a mark; a `[[wikilink]]` is a node-selected
        // atom. Both light the one Link button.
        setBtnActive(linkBtnEl, active.marks.link || active.wikiLink);
        setBtnActive(mathBtnEl, active.inlineMath);
        setBtnActive(imgBtnEl, active.imageSelected);
        setBtnActive(footnoteBtnEl, active.footnote);
        setBtnActive(hrBtnEl, active.hr);
        setBtnActive(tableBtn, active.inTable);
        setBtnActive(listTriggerBtn, active.list !== null);
        setBtnActive(quoteTriggerBtn, active.quote !== null);
        setBtnActive(codeTriggerBtn, active.code !== null);

        // Format (text hierarchy): label the level and fill its menu row; grey the
        // control out where the text type can't become a heading (table cell /
        // code block / a selected atom).
        const labelEl = fmtBtn.querySelector(".tb-fmt-label");
        if (labelEl) {
            const labels = ["P", "H1", "H2", "H3", "H4", "H5", "H6"];
            labelEl.textContent = active.formatApplicable ? (labels[active.headingLevel] ?? "P") : "—";
        }
        fmtWrap.classList.toggle("tb-fmt-wrap--disabled", !active.formatApplicable);
        fmtItems.forEach((item, i) => {
            // i=0 → P (level 0), i=1..6 → H1..H6; nothing filled when N/A.
            item.setActive(active.formatApplicable && (i === 0 ? active.headingLevel === 0 : i === active.headingLevel));
        });

        // Container menu rows: fill the row for the exact container you're in.
        for (const { type, setActive } of listRows) { setActive(type === active.list); }
        for (const { key, setActive } of quoteRows) { setActive(key === active.quote); }
        for (const { key, setActive } of codeRows) { setActive(key === active.code); }
    };

    return {
        onSelectionChange(view: EditorView): void {
            // One derivation of "what state is the caret in"; the toolbar mirrors it.
            applyActiveState(computeToolbarActiveState(view.state));
        },
        setDetached(): void {
            // Focus is in a nested editable island (a callout title) — the frozen
            // PM selection no longer describes where the user is typing, so blank
            // the bar rather than assert a stale block.
            applyActiveState(DETACHED_STATE);
        },
        setDebugMode(enabled: boolean): void {
            debugVisible = enabled;
            if (dbgItem) {
                dbgItem.style.display = enabled ? "" : "none";
            }
            // Toggling debug changes the right zone's width, which changes
            // the space available to the collapsible left zone.
            overflow?.update(availableWidth());
        },
        setSyncConflict(active: boolean): void {
            syncConflictVisible = active;
            syncConflictItem.style.display = active ? "" : "none";
            // Body-level flag: with the toolbar hidden, the badge would be
            // invisible — the collapsed bar's expand tab tints instead, so drift
            // is never a state the UI silently sits in.
            document.body.classList.toggle("has-sync-conflict", active);
            // Same as debug: the right zone's width changed.
            overflow?.update(availableWidth());
        },
        applyConfig(config: ToolbarConfig): void {
            latestConfig = config;
            const visible = config.visible !== false;
            if (visible !== toolbarVisible) {
                applyVisibility(visible);
            }
            // Defer while dragging: the DOM already reflects the change, and a
            // rebuild would drop the edit-mode decorations. Applied on exit.
            if (!editing) {
                render(config);
            }
        },
        setFontPreset(preset: FontPreset, stacks?: FontStacks): void {
            setFontActive(preset, stacks);
        },
        setFontSize(size: number): void {
            setFontSizeActive(size);
        },
        setContentWidth(mode: ContentWidthMode, fixedCss?: string): void {
            if (mode === "fixed" && fixedCss) { fixedWidthCss = fixedCss; }
            setContentWidthActive(mode);
        },
        setBlockHandles(mode: BlockHandlesMode): void {
            setBlockHandlesActive(mode);
        },
        // Slash-menu action hooks — the same code paths as the menu rows,
        // usable while the bar itself is hidden.
        chooseFontPreset(preset: FontPreset): void {
            setFontActive(preset);
            notifySetFontPreset(preset);
        },
        stepFontSize(delta: 1 | -1): void {
            pickFontSize(stepFontSizePercent(currentFontSize, delta));
        },
        toggleProofread,
        isVisible: () => toolbarVisible,
        openLinkPrompt,
    };
}
