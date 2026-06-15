import './toc.css';
import type { EditorView } from "@milkdown/prose/view";
import { applyTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";

interface HeadingEntry {
    level: number;
    text: string;
    pos: number;
}

const TOC_WIDTH = 220;
const DOCKED_MIN_CONTENT_WIDTH = 720;
const HEADING_STICKY_ACTIVE_CHANGE_EVENT = "heading-sticky-active-change";
const tocAutoHideThreshold = window.__i18n?.tocAutoHideThreshold ?? 3;
type TocMode = "docked" | "overlay";

export function initToc(getEditorView: () => EditorView | null): {
    panel: HTMLElement;
    toggle: () => void;
    refresh: () => void;
} {
    const panel = document.createElement("div");
    panel.className = "toc-panel";

    const header = document.createElement("div");
    header.className = "toc-header";
    header.textContent = t("Table of Contents");

    const list = document.createElement("div");
    list.className = "toc-list";

    panel.appendChild(header);
    panel.appendChild(list);

    // ── 右侧收起/展开 Tab（独立 fixed 元素，不受 panel overflow:hidden 影响）──
    const tabEl = document.createElement("button");
    tabEl.className = "toc-toggle-tab";
    tabEl.tabIndex = -1;
    document.body.appendChild(tabEl);

    let tocMode: TocMode = "overlay";
    let isOpen = false;
    let dockedUserCollapsed = false;
    let userToggled = false;
    let activeHeadingPos: number | null = null;

    function setActiveHeadingPos(pos: number | null): void {
        activeHeadingPos = pos;
        let activeItem: HTMLElement | null = null;
        list.querySelectorAll<HTMLElement>(".toc-item").forEach((item) => {
            const isActive = pos !== null && item.dataset["headingPos"] === String(pos);
            item.classList.toggle("toc-item--active", isActive);
            if (isActive) {
                activeItem = item;
            }
        });
        if (activeItem) {
            (activeItem as HTMLElement).scrollIntoView({ block: "nearest" });
        }
    }

    function updateTab(): void {
        tabEl.textContent = isOpen ? "‹" : "›";
        tabEl.style.left = isOpen ? `${TOC_WIDTH}px` : "0px";
    }

    function updateBodyClasses(): void {
        document.body.classList.toggle("toc-docked", tocMode === "docked");
        document.body.classList.toggle("toc-overlay", tocMode === "overlay");
        document.body.classList.toggle("toc-open", isOpen && tocMode === "docked");
        document.body.classList.toggle("toc-overlay-open", isOpen && tocMode === "overlay");
    }

    function syncOutsideClickHandler(): void {
        document.removeEventListener("mousedown", outsideClickHandler);
        if (isOpen && tocMode === "overlay") {
            setTimeout(() => {
                if (isOpen && tocMode === "overlay") {
                    document.addEventListener("mousedown", outsideClickHandler);
                }
            }, 0);
        }
    }

    function syncTocState(): void {
        panel.classList.toggle("toc-panel--open", isOpen);
        panel.classList.toggle("toc-panel--docked", tocMode === "docked");
        panel.classList.toggle("toc-panel--overlay", tocMode === "overlay");
        updateBodyClasses();
        updateTab();
        syncOutsideClickHandler();
        if (isOpen) {
            renderHeadings(getHeadings());
        }
    }

    // ── 从 ProseMirror 文档中提取所有 heading 节点 ────────
    function getHeadings(): HeadingEntry[] {
        const view = getEditorView();
        if (!view) {
            return [];
        }
        const headings: HeadingEntry[] = [];
        view.state.doc.nodesBetween(
            0,
            view.state.doc.content.size,
            (node, pos) => {
                if (node.type.name === "heading") {
                    const text = node.textContent.trim();
                    if (text) {
                        headings.push({
                            level: node.attrs["level"] as number,
                            text,
                            pos,
                        });
                    }
                }
            },
        );
        return headings;
    }

    function shouldAutoOpen(headings: HeadingEntry[]): boolean {
        return tocMode === "docked" && headings.length > tocAutoHideThreshold;
    }

    function syncAutoOpenState(headings: HeadingEntry[]): void {
        if (!userToggled) {
            isOpen = shouldAutoOpen(headings);
        }
    }

    function renderHeadings(headings: HeadingEntry[]): void {
        list.innerHTML = "";
        if (headings.length === 0) {
            const empty = document.createElement("div");
            empty.className = "toc-empty";
            empty.textContent = t("No headings");
            list.appendChild(empty);
            return;
        }
        headings.forEach(({ level, text, pos }) => {
            const item = document.createElement("div");
            item.className = `toc-item toc-item--h${level}`;
            item.dataset["headingPos"] = String(pos);
            item.style.paddingLeft = `${(level - 1) * 12 + 8}px`;
            item.textContent = text || `${t("Heading")} ${level}`;
            item.classList.toggle("toc-item--active", activeHeadingPos === pos);
            applyTooltip(item, text, {
                placement: "above",
                truncatedOnly: true,
            });
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const view = getEditorView();
                if (!view) {
                    return;
                }
                try {
                    const { node } = view.domAtPos(pos + 1);
                    let el: HTMLElement | null =
                        node.nodeType === Node.TEXT_NODE
                            ? node.parentElement
                            : (node as HTMLElement);
                    while (el && !el.matches("h1,h2,h3,h4,h5,h6")) {
                        el = el.parentElement;
                    }
                    if (el) {
                        const topbar = document.querySelector(
                            ".editor-topbar",
                        ) as HTMLElement | null;
                        const topbarH =
                            topbar?.getBoundingClientRect().height ?? 40;
                        const top =
                            el.getBoundingClientRect().top +
                            window.scrollY -
                            topbarH -
                            8;
                        window.scrollTo({ top, behavior: "smooth" });
                    }
                } catch {
                    /* 文档结构异常时忽略 */
                }
            });
            list.appendChild(item);
        });
        setActiveHeadingPos(activeHeadingPos);
    }

    function refresh(): void {
        const headings = getHeadings();
        syncAutoOpenState(headings);
        syncTocState();
    }

    function handleStickyActiveChange(event: Event): void {
        const detail = (event as CustomEvent<{ headingPos: number | null }>).detail;
        setActiveHeadingPos(typeof detail?.headingPos === "number" ? detail.headingPos : null);
    }

    function outsideClickHandler(e: MouseEvent): void {
        if (!panel.contains(e.target as Node)) {
            close();
        }
    }

    function close(): void {
        isOpen = false;
        syncTocState();
    }

    function openPanel(): void {
        isOpen = true;
        syncTocState();
    }

    function toggle(): void {
        userToggled = true;
        if (tocMode === "docked") {
            dockedUserCollapsed = isOpen;
            isOpen = !isOpen;
            syncTocState();
        } else {
            if (isOpen) {
                close();
            } else {
                openPanel();
            }
        }
    }

    // Tab 点击：始终调用 toggle
    tabEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
    });

    // ── 自动展开检测 ──────────────────────────────────────
    function hasEnoughSpace(): boolean {
        if (document.body.classList.contains("editor-width-auto")) {
            return window.innerWidth >= TOC_WIDTH + DOCKED_MIN_CONTENT_WIDTH;
        }
        const editorEl = document.getElementById("editor");
        if (!editorEl) {
            return false;
        }
        const rect = editorEl.getBoundingClientRect();
        return rect.left >= TOC_WIDTH && rect.width >= DOCKED_MIN_CONTENT_WIDTH;
    }

    function resolveMode(): TocMode {
        return hasEnoughSpace() ? "docked" : "overlay";
    }

    function checkResponsiveMode(): void {
        const nextMode = resolveMode();
        if (nextMode === tocMode) {
            return;
        }

        tocMode = nextMode;
        if (tocMode === "docked") {
            const headings = getHeadings();
            isOpen = userToggled ? !dockedUserCollapsed : shouldAutoOpen(headings);
        } else {
            isOpen = false;
        }
        syncTocState();
    }

    // ── 动态对齐到 topbar 底部，同步 tab 垂直位置 ──────────
    function updatePanelPosition(): void {
        const topbar = document.querySelector(
            ".editor-topbar",
        ) as HTMLElement | null;
        const topbarBottom = topbar?.getBoundingClientRect().bottom ?? 40;
        panel.style.top = `${topbarBottom}px`;
        panel.style.height = `calc(100vh - ${topbarBottom}px)`;
        // tab 垂直居中于面板
        const tabTop =
            topbarBottom + (window.innerHeight - topbarBottom) / 2 - 24;
        tabEl.style.top = `${tabTop}px`;
    }

    requestAnimationFrame(() => {
        tocMode = resolveMode();
        const headings = getHeadings();
        isOpen = userToggled ? tocMode === "docked" && !dockedUserCollapsed : shouldAutoOpen(headings);
        updatePanelPosition();
        syncTocState();
    });

    window.addEventListener("resize", () => {
        updatePanelPosition();
        checkResponsiveMode();
    });
    window.addEventListener(HEADING_STICKY_ACTIVE_CHANGE_EVENT, handleStickyActiveChange);

    return { panel, toggle, refresh };
}
