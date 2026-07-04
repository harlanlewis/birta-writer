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
    IconSpellCheck,
    IconStyleCheck,
    IconSearch,
    IconSettings,
} from "@/ui/icons";
import { applyTooltip } from "@/ui/tooltip";
import { t, kbd } from "@/i18n";
import { sampleDocPosition } from "../selectionToolbar";
import { notifyOpenSettings, notifyGetProjectImages, notifySetStyleCheckEnabled, notifySetSpellCheckEnabled } from "@/messaging";
import { getEditorView } from "@/editor";
import { getProofreadConfig, setProofreadConfig } from "@/plugins";
import { createButton, createSeparator } from "@/ui/dom";
import { attachImgPathComplete } from '../imageView/imgPathComplete';
import { attachLinkTargetComplete } from '../pathLink/linkTargetComplete';
import { attachInputUndo } from "@/utils/inputUndo";
import { createOverflowController } from './overflow';
import type { OverflowGroup } from './overflow';
import './toolbar.css';

type GetEditor = () => Editor | null;

function sep(): HTMLElement {
    return createSeparator("tb-sep");
}

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

    // 有预填文字则聚焦 URL，否则聚焦文字框
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
 * 图片插入面板：居中悬浮（无遮罩），支持三种模式：浏览项目 / URL / 上传本地
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

    // ── 标题栏 ────────────────────────────────────────
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

    // ── Tab 切换 ──────────────────────────────────────
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

    // ── Alt 文本（三种模式共用）─────────────────────
    const altInput = document.createElement("input");
    altInput.type = "text";
    altInput.className = "img-insert-input";
    altInput.placeholder = t("Alt text (alt)");
    panel.appendChild(altInput);

    // ── 浏览项目 tab ──────────────────────────────────
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

    // ── URL 模式内容 ──────────────────────────────────
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

    // ── 上传本地 tab ──────────────────────────────────
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

    // ── 确认 / 取消 ──────────────────────────────────
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

    // 居中定位
    const pw = Math.min(540, window.innerWidth - 32);
    panel.style.width = pw + "px";
    panel.style.left = Math.round((window.innerWidth - pw) / 2) + "px";
    panel.style.top =
        Math.round((window.innerHeight - panel.offsetHeight) / 2) + "px";
    // 初次渲染后再垂直居中（offsetHeight 需要元素在 DOM 后才准确）
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

    // ── 放大预览（lightbox）────────────────────────────
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

    // ── 渲染图片网格 ──────────────────────────────────
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

            // 点击选中/取消
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

            // 放大预览
            enlargeBtn.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                showLightbox(img.webviewUri, img.name);
            });
        });
    }

    // ── 加载项目图片 ──────────────────────────────────
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

    // 上传本地：file input
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
            // 补全选中时 dataset 存有 webviewUri，优先使用；否则直接用输入值
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

    // Tab 切换
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

    // 隐藏不可用 tab
    if (!onGetProjectImages) {
        tabProject.style.display = "none";
        switchTab("url");
    } else {
        loadProjectImages(); // 默认激活 project tab 时立即加载
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
): {
    onSelectionChange: (view: EditorView) => void;
    setDebugMode: (enabled: boolean) => void;
    /** Opens the Insert/Edit Link prompt (toolbar button and Cmd/Ctrl+K). */
    openLinkPrompt: () => void;
} {
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";

    // TOC toggling lives on the panel's edge tab; undo/redo stay on their
    // keyboard shortcuts — neither needs a toolbar button.

    // ── Priority groups (for the narrow-pane overflow menu) ──
    // Buttons are appended into `.tb-group` wrappers instead of directly
    // into the toolbar, so whole groups can be reparented into the ⋯ panel.
    const overflowGroups: OverflowGroup[] = [];
    let pendingSep: HTMLElement | null = null;

    function addSep(): HTMLElement {
        const s = sep();
        toolbar.appendChild(s);
        pendingSep = s;
        return s;
    }

    function addGroup(name: string): HTMLElement {
        const el = document.createElement("div");
        el.className = "tb-group";
        el.dataset["group"] = name;
        toolbar.appendChild(el);
        overflowGroups.push({ name, el, sepBefore: pendingSep });
        pendingSep = null;
        return el;
    }

    // ── Block-type dropdown (opens on hover, same style as the floating toolbar) ──
    const fmtWrap = document.createElement("div");
    fmtWrap.className = "tb-fmt-wrap";

    const fmtBtn = document.createElement("button");
    fmtBtn.className = "tb-btn tb-fmt-btn";
    fmtBtn.innerHTML = `<span class="tb-fmt-label">P</span>${IconChevronDown}`;
    fmtBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
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

    const fmtItems: HTMLElement[] = [];
    formats.forEach(([label, action]) => {
        const item = document.createElement("div");
        item.className = "tb-fmt-item";
        item.textContent = label;
        item.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            action();
            fmtMenu.style.display = "none";
        });
        fmtMenu.appendChild(item);
        fmtItems.push(item);
    });

    let fmtHideTimer: ReturnType<typeof setTimeout> | null = null;

    function positionFmtMenu(): void {
        const rect = fmtBtn.getBoundingClientRect();
        const approxMenuH = formats.length * 30;
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < approxMenuH + 8) {
            fmtMenu.style.top = "auto";
            fmtMenu.style.bottom = "calc(100% + 6px)";
        } else {
            fmtMenu.style.bottom = "auto";
            fmtMenu.style.top = "calc(100% + 6px)";
        }
    }

    fmtWrap.addEventListener("mouseenter", () => {
        if (fmtHideTimer) {
            clearTimeout(fmtHideTimer);
            fmtHideTimer = null;
        }
        positionFmtMenu();
        fmtMenu.style.display = "flex";
    });
    fmtWrap.addEventListener("mouseleave", () => {
        fmtHideTimer = setTimeout(() => {
            fmtMenu.style.display = "none";
        }, 100);
    });
    fmtMenu.addEventListener("mouseenter", () => {
        if (fmtHideTimer) {
            clearTimeout(fmtHideTimer);
            fmtHideTimer = null;
        }
    });

    fmtWrap.appendChild(fmtBtn);
    fmtWrap.appendChild(fmtMenu);
    addGroup("fmt").appendChild(fmtWrap);

    addSep();

    // ── Inline formatting ─────────────────────────────
    const inlineCoreGroup = addGroup("inline-core");
    inlineCoreGroup.appendChild(
        btn(IconBold, t("Bold") + " " + kbd("Mod-b"), () =>
            runEditorCommand("toggleBold", getEditor),
        ),
    );
    inlineCoreGroup.appendChild(
        btn(IconItalic, t("Italic") + " " + kbd("Mod-i"), () =>
            runEditorCommand("toggleItalic", getEditor),
        ),
    );
    const inlineExtraGroup = addGroup("inline-extra");
    inlineExtraGroup.appendChild(
        btn(
            IconStrikethrough,
            t("Strikethrough") + " " + kbd("Mod-Shift-x"),
            () => runEditorCommand("toggleStrikethrough", getEditor),
        ),
    );
    inlineExtraGroup.appendChild(
        btn(IconCode, t("Inline Code") + " " + kbd("Mod-e"), () =>
            runEditorCommand("toggleInlineCode", getEditor),
        ),
    );
    inlineExtraGroup.appendChild(
        btn(IconEraser, t("Clear Formatting"), () =>
            runEditorCommand("clearFormatting", getEditor),
        ),
    );

    addSep();

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
            linkBtnEl,
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
    addGroup("link").appendChild(linkBtnEl);

    // Image: open the insert panel, then insert an image node
    const insertGroup = addGroup("insert");
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
    insertGroup.appendChild(imgBtnEl);

    insertGroup.appendChild(
        btn(IconTable, t("Insert Table"), () =>
            runEditorCommand("insertTable", getEditor),
        ),
    );

    // Append both nodes at once (append accepts multiple children;
    // appendChild takes only one, which previously silently dropped the Math
    // button — see the 18b0fb8 fix on dev).
    insertGroup.append(
        btn(IconFootnote, t("Insert Footnote"), () =>
            runEditorCommand("insertFootnote", getEditor),
        ),
        btn(IconMath, t("Insert Math"), () =>
            runEditorCommand("insertMath", getEditor),
        ),
    );

    addSep();

    // Lists (toggle: clicking the active one again lifts out)
    const listsGroup = addGroup("lists");
    listsGroup.appendChild(
        btn(IconList, t("Bullet List"), () =>
            runEditorCommand("toggleBulletList", getEditor),
        ),
    );
    listsGroup.appendChild(
        btn(IconListOrdered, t("Ordered List"), () =>
            runEditorCommand("toggleOrderedList", getEditor),
        ),
    );
    listsGroup.appendChild(
        btn(IconCheckSquare, t("Task List"), () =>
            runEditorCommand("toggleTaskList", getEditor),
        ),
    );

    addSep();

    // Blocks (toggle)
    const blocksGroup = addGroup("blocks");
    blocksGroup.appendChild(
        btn(IconQuote, t("Blockquote"), () =>
            runEditorCommand("toggleBlockquote", getEditor),
        ),
    );
    blocksGroup.appendChild(
        btn(IconTerminal, t("Code Block"), () =>
            runEditorCommand("insertCodeBlock", getEditor),
        ),
    );
    blocksGroup.appendChild(
        btn(IconMinus, t("Horizontal Rule"), () =>
            runEditorCommand("insertHorizontalRule", getEditor),
        ),
    );

    // ── Debug tools (always created; setDebugMode controls visibility) ──
    let dbgSep: HTMLElement | null = null;
    let dbgGroup: HTMLElement | null = null;

    if (debugOpts) {
        const { getLineMap, getMarkdownSource } = debugOpts;

        dbgSep = addSep();
        dbgSep.style.display = "none";

        const dbgWrap = document.createElement("div");
        dbgWrap.className = "tb-fmt-wrap";

        const dbgBtn = document.createElement("button");
        dbgBtn.className = "tb-btn tb-fmt-btn";
        dbgBtn.innerHTML = IconList + IconChevronDown;
        applyTooltip(dbgBtn, t("Debug tools"));
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

        dbgWrap.addEventListener("mouseenter", () => {
            dbgMenu.style.display = "flex";
        });
        dbgWrap.addEventListener("mouseleave", () => {
            dbgMenu.style.display = "none";
        });

        dbgGroup = addGroup("debug");
        dbgGroup.style.display = "none";
        dbgGroup.appendChild(dbgWrap);
    }

    // ── Proofread toggles, find & settings ───────────────
    addSep();
    const proofreadGroup = addGroup("proofread");
    const styleCheckBtn = btn(IconStyleCheck, `${t("Style check")} (${kbd("Mod-Alt-Shift-d")})`, () => {
        const view = getEditorView();
        if (!view) { return; }
        const cfg = getProofreadConfig(view);
        const next = { ...cfg, styleCheck: !cfg.styleCheck };
        setProofreadConfig(view, next);
        notifySetStyleCheckEnabled(next.styleCheck);
    });
    const spellCheckBtn = btn(IconSpellCheck, t("Spelling & grammar"), () => {
        const view = getEditorView();
        if (!view) { return; }
        const cfg = getProofreadConfig(view);
        const next = { ...cfg, spellCheck: !cfg.spellCheck };
        setProofreadConfig(view, next);
        notifySetSpellCheckEnabled(next.spellCheck);
    });
    window.addEventListener("proofread-config-changed", (e) => {
        const config = (e as CustomEvent<{ styleCheck: boolean; spellCheck: boolean }>).detail;
        styleCheckBtn.classList.toggle("tb-btn--active", config.styleCheck);
        spellCheckBtn.classList.toggle("tb-btn--active", config.spellCheck);
    });
    proofreadGroup.appendChild(styleCheckBtn);
    proofreadGroup.appendChild(spellCheckBtn);
    const utilityGroup = addGroup("utility");
    if (onOpenFind) {
        utilityGroup.appendChild(
            btn(IconSearch, `${t("Find")} (${kbd("Mod-f")})`, onOpenFind),
        );
    }
    utilityGroup.appendChild(
        btn(IconSettings, t("Settings"), () => notifyOpenSettings()),
    );

    // ── Overflow (⋯) menu for narrow panes ─────────────
    // Reuses the tb-fmt-wrap hover/positioning pattern; collapsed groups
    // are physically reparented into the panel so listeners survive.
    const moreWrap = document.createElement("div");
    moreWrap.className = "tb-fmt-wrap tb-more-wrap";
    moreWrap.style.display = "none";

    const moreBtn = document.createElement("button");
    moreBtn.className = "tb-btn tb-more-btn";
    moreBtn.textContent = "⋯";
    applyTooltip(moreBtn, t("More…"));
    moreBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    const moreMenu = document.createElement("div");
    moreMenu.className = "tb-more-menu";
    moreMenu.style.display = "none";

    let moreHideTimer: ReturnType<typeof setTimeout> | null = null;

    function positionMoreMenu(): void {
        const rect = moreBtn.getBoundingClientRect();
        // Vertical flip when there is no room below (same as the fmt menu).
        const approxMenuH = moreMenu.childElementCount * 34 + 12;
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < approxMenuH + 8 && rect.top > approxMenuH + 8) {
            moreMenu.style.top = "auto";
            moreMenu.style.bottom = "calc(100% + 6px)";
        } else {
            moreMenu.style.bottom = "auto";
            moreMenu.style.top = "calc(100% + 6px)";
        }
        // Horizontal flip: right-align when the panel would clip at the
        // right edge (the ⋯ button sits near the end of the toolbar).
        moreMenu.style.left = "0";
        moreMenu.style.right = "auto";
        const menuW = moreMenu.offsetWidth || 160;
        if (rect.left + menuW > window.innerWidth - 8) {
            moreMenu.style.left = "auto";
            moreMenu.style.right = "0";
        }
    }

    moreWrap.addEventListener("mouseenter", () => {
        if (moreHideTimer) {
            clearTimeout(moreHideTimer);
            moreHideTimer = null;
        }
        moreMenu.style.display = "flex";
        positionMoreMenu();
    });
    moreWrap.addEventListener("mouseleave", () => {
        moreHideTimer = setTimeout(() => {
            moreMenu.style.display = "none";
        }, 100);
    });
    moreMenu.addEventListener("mouseenter", () => {
        if (moreHideTimer) {
            clearTimeout(moreHideTimer);
            moreHideTimer = null;
        }
    });

    moreWrap.appendChild(moreBtn);
    moreWrap.appendChild(moreMenu);
    toolbar.appendChild(moreWrap);

    topbar.appendChild(toolbar);

    // Collapse order: first to overflow → last. fmt, inline-core and link
    // never collapse ("debug" only participates while it is visible).
    const collapseOrder = ["insert", "blocks", "lists", "inline-extra", "proofread", "utility", "debug"]
        .map((name) => overflowGroups.findIndex((g) => g.name === name))
        .filter((i) => i >= 0);

    const overflowController = createOverflowController({
        toolbar,
        groups: overflowGroups,
        collapseOrder,
        moreWrap,
        panel: moreMenu,
    });

    if (typeof ResizeObserver !== "undefined") {
        const resizeObserver = new ResizeObserver(() => {
            overflowController.update(toolbar.clientWidth);
        });
        resizeObserver.observe(toolbar);
    }

    // If debugMode is already true at page load, show the tools immediately
    if (window.__i18n?.debugMode && dbgSep && dbgGroup) {
        dbgSep.style.display = "";
        dbgGroup.style.display = "";
    }

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
            // 更新按钮显示的格式标签
            const labelEl = fmtBtn.querySelector(".tb-fmt-label");
            if (labelEl) {
                const labels = ["P","H1","H2","H3","H4","H5","H6"];
                labelEl.textContent = activeLevel === -1 ? "—" : (labels[activeLevel] ?? "P");
            }
            fmtItems.forEach((item, i) => {
                // i=0 → P (activeLevel===0), i=1..6 → H1..H6 (activeLevel===i)
                item.classList.toggle(
                    "tb-fmt-item--active",
                    i === 0 ? activeLevel === 0 : i === activeLevel,
                );
            });
        },
        setDebugMode(enabled: boolean): void {
            if (!dbgSep || !dbgGroup) {
                return;
            }
            dbgSep.style.display = enabled ? "" : "none";
            dbgGroup.style.display = enabled ? "" : "none";
            // The debug group changes the toolbar's content width; re-run
            // the overflow computation with the last known available width.
            overflowController.refresh();
        },
        openLinkPrompt,
    };
}
