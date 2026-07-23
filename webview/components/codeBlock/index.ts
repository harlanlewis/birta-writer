import type { Node as PMNode } from "@/pm";
import type {
    Decoration,
    DecorationSource,
    EditorView,
} from "@/pm";

type ViewMutationRecord = MutationRecord | { type: "selection"; target: Node };
import {
    IconCopy, IconCheck, IconChevronDown,
    IconChevronUp, IconChevronLeft, IconChevronRight,
    IconCode, IconEye,
    IconZoomIn, IconZoomOut, IconMaximize2, IconResetZoom,
    IconAlertCircle, IconX, IconWrapText,
} from "@/ui/icons";
import { applyTooltip, hideTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { loadMermaid } from "@/utils/mermaidLoader";
import { isMermaidDark } from "./mermaidTheme";
import { normalizeMermaidThemeMode, type MermaidThemeMode } from "../../../shared/mermaid";
import { CODE_LANGUAGES, normalizeCodeLanguage } from "@/codeLanguages";
import { evaluateCalcBlock } from "@/utils/calc";
import { renderKatexInto } from "@/utils/katexLoader";
import { highlight, ensureGrammars } from "@/highlighter";
import { lockBodyScroll, unlockBodyScroll, animateCloseLightbox, bindLightboxDismiss } from "@/utils";
import { attachInputUndo } from "@/utils/inputUndo";
import { createButton } from "@/ui/dom";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";
import { onOutsideClick } from "@/ui/outsideClick";
import { createFoldEllipsis } from "@/ui/foldEllipsis";
import { foldPluginKey, type FoldMeta } from "@/plugins/foldState";
import './codeBlock.css';

const shouldAutoConvertCodeBlock = (): boolean =>
    window.__i18n?.codeBlockAutoConvert ?? true;

const shouldWordWrapCodeBlock = (): boolean =>
    window.__i18n?.codeBlockWordWrap ?? false;

function getLangLabel(val: string): string {
    const normalized = normalizeCodeLanguage(val);
    const label = CODE_LANGUAGES.find(([v]) => v === normalized)?.[1] ?? val;
    return label === "Plain Text" ? t("Plain Text") : label;
}

export function isSameLanguage(a: string, b: string): boolean {
    return normalizeCodeLanguage(a) === normalizeCodeLanguage(b);
}

/**
 * Build one language-picker row: a leading shared check column (visible only
 * when this is the current language, via `.lang-picker-item--active .menu-check`)
 * plus the label. Mirrors the toolbar menus' selected-row treatment so both use
 * the same check glyph and a checkmark — not a color/weight change — marks the
 * current selection, matching VS Code's own picker.
 */
export function createLangPickerItem(
    value: string,
    label: string,
    selected: boolean,
): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "lang-picker-item";
    item.dataset["value"] = value;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) item.classList.add("lang-picker-item--active");

    const check = document.createElement("span");
    check.className = "menu-check";
    check.setAttribute("aria-hidden", "true");

    const labelEl = document.createElement("span");
    labelEl.className = "lang-picker-item-label";
    labelEl.textContent = label === "Plain Text" ? t("Plain Text") : label;

    item.append(check, labelEl);
    return item;
}

// ─── Line-number update ──────────────────────────────────
function getLineHeightPx(target: HTMLElement): number {
    const style = getComputedStyle(target);
    const lineHeight = Number.parseFloat(style.lineHeight);
    if (Number.isFinite(lineHeight)) {
        return lineHeight;
    }

    const fontSize = Number.parseFloat(style.fontSize);
    return Number.isFinite(fontSize) ? fontSize * 1.5 : 21;
}

function getWrapColumnCount(target: HTMLElement): number {
    const style = getComputedStyle(target);
    const paddingX =
        Number.parseFloat(style.paddingLeft || "0") +
        Number.parseFloat(style.paddingRight || "0");
    const width = Math.max(1, target.clientWidth - paddingX);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return 80;
    }
    ctx.font = style.font;
    const charWidth = Math.max(1, ctx.measureText("M").width);
    return Math.max(1, Math.floor(width / charWidth));
}

function getVisualLineCounts(target: HTMLElement, text: string, wordWrap: boolean): number[] | undefined {
    if (!wordWrap || target.clientWidth <= 0) {
        return undefined;
    }

    const columns = getWrapColumnCount(target);
    return text.split("\n").map((line) => {
        const expanded = line.replace(/\t/g, "    ");
        return Math.max(1, Math.ceil(expanded.length / columns));
    });
}

function updateLineNumbers(gutter: HTMLElement, text: string, visualLineCounts?: number[]): void {
    const lines = text.split("\n");
    const count = Math.max(1, lines.length);
    while (gutter.childElementCount < count) {
        gutter.appendChild(document.createElement("span"));
    }
    while (gutter.childElementCount > count) {
        gutter.removeChild(gutter.lastChild!);
    }
    Array.from(gutter.children).forEach((el, i) => {
        const span = el as HTMLElement;
        span.textContent = String(i + 1);
        if (visualLineCounts) {
            span.style.height = `${visualLineCounts[i] * getLineHeightPx(gutter)}px`;
        } else {
            span.style.height = "";
        }
    });
}

// ─── Mermaid module-level initialization ─────────────────
let mermaidInitialized = false;
let lastMermaidTheme = "";

// The active `birta.mermaid.theme` mode, seeded from the injected config and
// kept current by setMermaidThemeMode() when the setting changes live.
let mermaidThemeMode: MermaidThemeMode = normalizeMermaidThemeMode(window.__i18n?.mermaidTheme);

/** The live editor background, used only when the mode is `auto`. */
function currentEditorBg(): string {
    return getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-editor-background")
        .trim();
}

/**
 * Effective dark/light for the current mode. Reads the editor background (a
 * forced `getComputedStyle` reflow) only in `auto` mode — `light`/`dark` are
 * fixed, so on the mount path and on theme events those modes cost nothing.
 */
function mermaidDarkNow(): boolean {
    return isMermaidDark(mermaidThemeMode, mermaidThemeMode === "auto" ? currentEditorBg() : "");
}

/**
 * Reflect the effective (light/dark) Mermaid canvas onto <body>, so the CSS
 * `--mermaid-canvas` variable — white by default, dark under this class — backs
 * every diagram surface (inline preview and lightbox) consistently. Idempotent;
 * safe to call on every render and on theme/setting changes.
 */
export function syncMermaidCanvasClass(): void {
    document.body.classList.toggle("mermaid-canvas-dark", mermaidDarkNow());
}

/** Re-render every visible Mermaid diagram (after a theme or setting change). */
function rerenderAllMermaid(): void {
    for (const instance of mermaidInstances) {
        if (instance.isMermaid && instance.isPreviewMode && instance.lastRenderedCode) {
            instance.renderMermaid(instance.lastRenderedCode);
        }
    }
}

/**
 * Live-apply a `birta.mermaid.theme` change: update the mode, force a re-init on
 * the next render, resync the canvas class, and re-render open diagrams.
 */
export function setMermaidThemeMode(mode: MermaidThemeMode): void {
    if (mode === mermaidThemeMode) return;
    mermaidThemeMode = mode;
    mermaidInitialized = false;
    syncMermaidCanvasClass();
    rerenderAllMermaid();
}

/**
 * Load Mermaid on demand (lazily code-split) and (re-)initialize it for the
 * current mode/theme, returning the module so the caller can render. Only
 * invoked when a diagram actually renders, so documents without ```mermaid
 * blocks never pull the Mermaid bundle into the launch path.
 */
async function ensureMermaid(): Promise<typeof import("mermaid")["default"]> {
    const mermaid = await loadMermaid();
    const dark = mermaidDarkNow();
    document.body.classList.toggle("mermaid-canvas-dark", dark);
    const currentTheme = dark ? "dark" : "default";

    // If the theme hasn't changed and it's already initialized, skip re-init.
    if (mermaidInitialized && lastMermaidTheme === currentTheme) return mermaid;

    mermaidInitialized = true;
    lastMermaidTheme = currentTheme;
    mermaid.initialize({
        startOnLoad: false,
        theme: currentTheme,
        securityLevel: "strict",
        // Disable Mermaid setting max-width:100% on the SVG, to avoid conflicting with the fixed width/height attributes we write back
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
    });
    return mermaid;
}

// ─── Mermaid instance registry (used to re-render on theme change) ──────────
type MermaidInstance = {
    isMermaid: boolean;
    isPreviewMode: boolean;
    lastRenderedCode: string;
    renderMermaid: (code: string) => Promise<void>;
};
const mermaidInstances = new Set<MermaidInstance>();

// Listen for theme-change events and re-render all Mermaid diagrams. Only `auto`
// mode tracks the editor theme; `light`/`dark` render a fixed palette that a
// theme switch cannot change, so we skip the re-init + re-render of every open
// diagram entirely in those modes.
if (typeof window !== 'undefined') {
    window.addEventListener('theme-changed', () => {
        if (mermaidThemeMode !== 'auto') return;
        mermaidInitialized = false;
        syncMermaidCanvasClass();
        rerenderAllMermaid();
    });
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Builds the language-picker button's inner HTML. The language token comes from the
// fenced-code-block info string (document-controlled), so getLangLabel's raw fallback
// MUST be escaped before it reaches innerHTML — otherwise a crafted fence such as
// ```<img/src=x/onerror=...> would execute on render. Exported so tests drive the real render.
export function langLabelHtml(lang: string): string {
    return `<span class="lang-picker-label">${escapeHtml(getLangLabel(lang))}</span>${IconChevronDown}`;
}

// ─── Language-picker dropdown component ────────────────────────────────────────
function createLangPicker(
    currentLang: string,
    onSelect: (lang: string) => void,
): { el: HTMLElement; update: (lang: string) => void; destroy: () => void } {
    const wrapper = document.createElement("div");
    wrapper.className = "lang-picker";

    const triggerBtn = document.createElement("button");
    triggerBtn.className = "lang-picker-btn";
    triggerBtn.tabIndex = -1;
    triggerBtn.innerHTML = langLabelHtml(currentLang);

    const dropdown = document.createElement("div");
    dropdown.className = "lang-picker-dropdown";
    dropdown.style.display = "none";
    document.body.appendChild(dropdown);

    const searchInput = document.createElement("input");
    searchInput.className = "lang-picker-search";
    searchInput.type = "text";
    searchInput.placeholder = t("Search language...");
    searchInput.setAttribute("autocomplete", "off");
    searchInput.setAttribute("spellcheck", "false");
    // Local undo/redo: VS Code's Electron layer swallows Cmd/Ctrl+Z before
    // native inputs see it (same as the other overlay inputs)
    const detachSearchUndo = attachInputUndo(searchInput);

    const listEl = document.createElement("ul");
    listEl.className = "lang-picker-list";

    dropdown.appendChild(searchInput);
    dropdown.appendChild(listEl);
    wrapper.appendChild(triggerBtn);

    let isOpen = false;
    let activeIndex = -1;
    /** Escape-layer unregister handle (null while the dropdown is closed). */
    let escapeLayerOff: (() => void) | null = null;

    function scrollListItemIntoView(item: HTMLElement): void {
        const itemTop = item.offsetTop;
        const itemBottom = itemTop + item.offsetHeight;
        const visibleTop = listEl.scrollTop;
        const visibleBottom = visibleTop + listEl.clientHeight;

        if (itemTop < visibleTop) {
            listEl.scrollTop = itemTop;
        } else if (itemBottom > visibleBottom) {
            listEl.scrollTop = itemBottom - listEl.clientHeight;
        }
    }

    function setActiveIdx(idx: number): void {
        const items = listEl.querySelectorAll<HTMLElement>(".lang-picker-item");
        if (items.length === 0) {
            activeIndex = -1;
            return;
        }

        const nextIdx = Math.max(0, Math.min(idx, items.length - 1));
        items.forEach((el, i) =>
            el.classList.toggle("lang-picker-item--focused", i === nextIdx),
        );
        scrollListItemIntoView(items[nextIdx]);
        activeIndex = nextIdx;
    }

    function renderList(filter = ""): void {
        const q = filter.trim().toLowerCase();
        const filtered = CODE_LANGUAGES.filter(
            ([val, label, aliases]) =>
                label.toLowerCase().includes(q) ||
                val.toLowerCase().includes(q) ||
                (aliases?.some((alias) => alias.toLowerCase().includes(q)) ?? false),
        );
        listEl.innerHTML = "";
        activeIndex = -1;
        filtered.forEach(([val, label], i) => {
            const selected = isSameLanguage(val, currentLang);
            const item = createLangPickerItem(val, label, selected);
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectLang(val);
            });
            listEl.appendChild(item);
            if (selected) activeIndex = i;
        });
        if (filtered.length > 0) {
            setActiveIdx(activeIndex >= 0 ? activeIndex : 0);
        }
    }

    let outsideOff: (() => void) | null = null;
    function closeOnScroll(e: Event): void {
        if (dropdown.contains(e.target as Node)) return;
        close();
    }

    function open(): void {
        isOpen = true;
        // Escape layer: search-input Esc self-closes, but an editor-focused
        // Esc while the picker is open must close it before block-selecting.
        escapeLayerOff ??= registerEscapeLayer(close);
        const rect = triggerBtn.getBoundingClientRect();
        const dropW = Math.max(rect.width, 160);
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.width = `${dropW}px`;
        dropdown.style.top = "";
        dropdown.style.bottom = "";

        dropdown.style.visibility = "hidden";
        dropdown.style.display = "block";
        const dropH = dropdown.offsetHeight;
        dropdown.style.display = "none";
        dropdown.style.visibility = "";

        // Below by default, above when that's the larger side; an above
        // placement pins `bottom` so the list grows upward as it re-filters.
        const placed = computeAnchoredPosition(
            rect,
            { width: dropW, height: dropH },
            viewportSize(),
            { gap: 2 },
        );
        if (placed.above) {
            dropdown.style.bottom = `${placed.cssBottom}px`;
        } else {
            dropdown.style.top = `${placed.top}px`;
        }

        dropdown.style.display = "block";
        triggerBtn.classList.add("lang-picker-btn--open");
        searchInput.value = "";
        renderList();
        searchInput.focus();

        setTimeout(() => {
            // Bubble phase (capture: false), preserved from the original
            // listener: chrome elsewhere that swallows its own mousedowns
            // (stopPropagation) has always left this picker open, and a
            // capture-phase listener would start closing it on those.
            outsideOff = onOutsideClick([wrapper, dropdown], close, { capture: false });
            window.addEventListener("scroll", closeOnScroll, { capture: true });
        }, 0);
    }

    function close(): void {
        escapeLayerOff?.();
        escapeLayerOff = null;
        isOpen = false;
        dropdown.style.display = "none";
        triggerBtn.classList.remove("lang-picker-btn--open");
        outsideOff?.();
        outsideOff = null;
        window.removeEventListener("scroll", closeOnScroll, true);
    }

    function selectLang(val: string): void {
        currentLang = val;
        triggerBtn.querySelector(".lang-picker-label")!.textContent = getLangLabel(val);
        close();
        onSelect(val);
    }

    triggerBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        isOpen ? close() : open();
    });

    searchInput.addEventListener("input", () => renderList(searchInput.value));
    // Stop propagation only for keys the picker actually consumes (list
    // navigation and plain filter typing). Modifier chords it does not
    // handle (Cmd+Shift+M, other workbench keybindings, ...) must keep
    // propagating; undo/redo chords are stopped by attachInputUndo itself.
    searchInput.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        const items = listEl.querySelectorAll<HTMLElement>(".lang-picker-item");
        if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            setActiveIdx(Math.min(activeIndex + 1, items.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            setActiveIdx(Math.max(activeIndex - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const focused = listEl.querySelector<HTMLElement>(".lang-picker-item--focused");
            if (focused) selectLang(focused.dataset["value"] ?? "");
            else if (items[0]) selectLang(items[0].dataset["value"] ?? "");
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        } else if (
            !e.metaKey && !e.ctrlKey && !e.altKey &&
            (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete")
        ) {
            // Plain typing/editing that mutates the filter: keep it inside
            // the picker so document-level shortcut handlers never see it
            e.stopPropagation();
        }
    });

    return {
        el: wrapper,
        update(lang: string) {
            currentLang = lang;
            triggerBtn.querySelector(".lang-picker-label")!.textContent = getLangLabel(lang);
        },
        destroy() {
            close();
            detachSearchUndo();
            if (document.body.contains(dropdown)) document.body.removeChild(dropdown);
        },
    };
}

// ─── NodeView factory ─────────────────────────────────────
export function createCodeBlockView(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    _decorations?: readonly Decoration[],
    _innerDecorations?: DecorationSource,
): {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update: (n: PMNode) => boolean;
    ignoreMutation: (m: ViewMutationRecord) => boolean;
    destroy: () => void;
} {
    const _id = Math.random().toString(36).slice(2, 6);
    void _id; // kept for debugging

    // Ensure the syntax grammars are loaded for this (and every later) code
    // block. On the initial render of a document that already has code, editor.ts
    // has awaited this so it resolves immediately; for a code block added to a
    // previously code-free document this kicks off the lazy grammar chunk, and
    // prism re-highlights the block on the next edit inside it.
    void ensureGrammars();

    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";

    const header = document.createElement("div");
    header.className = "code-block-header";
    header.contentEditable = "false";

    const currentLang = (node.attrs["language"] as string) || "";
    const picker = createLangPicker(currentLang, (newLang) => {
        const pos = getPos();
        if (pos === undefined) return;
        view.dispatch(
            view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, language: newLang }),
        );
        view.focus();
    });

    // ── Mermaid state ─────────────────────────────────────
    let isMermaid = currentLang === "mermaid";
    // ── LaTeX state (block math preview via KaTeX) ────────
    let isLatex = normalizeCodeLanguage(currentLang) === "latex";
    // ── Calc state (living-calculation preview, MAR-196) ──
    let isCalc = normalizeCodeLanguage(currentLang) === "calc";
    // A block that shows a rendered preview instead of raw code — mermaid,
    // LaTeX, or calc. All reuse the same code/preview toggle and container.
    const isPreviewable = (): boolean => isMermaid || isLatex || isCalc;
    let isPreviewMode = false;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRenderedCode = "";
    let isRendering = false;
    let panX = 0, panY = 0, zoomLevel = 1.0;
    let naturalSvgW = 0, naturalSvgH = 0; // SVG viewBox natural size (fixed)
    const ZOOM_MIN = 0.05, ZOOM_MAX = 10.0, ZOOM_BTN = 0.25;
    const PAN_STEP = 80;
    let lbActiveLightbox: HTMLElement | null = null;
    // bindLightboxDismiss cleanup (Escape-layer entry + document key
    // listener) for the open lightbox; null while no lightbox is open OR
    // once a close has begun. Held at NodeView scope so destroy() can run it
    // when the view dies with the lightbox open (external sync/revert).
    let lbDismissCleanup: (() => void) | null = null;
    // Element showing the current zoom percentage (center of the overlay)
    let zoomValueDisplay: HTMLButtonElement | null = null;
    let isWordWrap = shouldWordWrapCodeBlock();

    function makeMermaidBtn(icon: string, tipText: string, extraClass = ""): HTMLButtonElement {
        return createButton({
            className: "mermaid-zoom-btn" + (extraClass ? ` ${extraClass}` : ""),
            icon,
            tabIndex: -1,
            title: tipText,
            tooltipPlacement: "above",
        });
    }

    // ── Header buttons (after the spacer, right-aligned) ────────────────
    const spacer = document.createElement("div");
    spacer.style.flex = "1";

    // Code/preview toggle button (shown only for mermaid)
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "code-view-toggle-btn";
    toggleBtn.tabIndex = -1;
    toggleBtn.innerHTML = IconEye;
    toggleBtn.style.display = isPreviewable() ? "inline-flex" : "none";
    const previewTip = (): string =>
        isCalc ? t("Preview Calculations") : isLatex ? t("Preview Formula") : t("Preview Diagram");
    const toggleTooltip = applyTooltip(toggleBtn, previewTip(), { placement: "above" });

    // Word-wrap toggle for the current code block (local override, not written to Markdown)
    const wordWrapBtn = document.createElement("button");
    wordWrapBtn.className = "code-wrap-toggle-btn";
    wordWrapBtn.tabIndex = -1;
    wordWrapBtn.innerHTML = IconWrapText;
    const wordWrapTooltip = applyTooltip(wordWrapBtn, t("Toggle Word Wrap"), { placement: "above" });

    // Fullscreen button (always present)
    const fullscreenBtn = document.createElement("button");
    fullscreenBtn.className = "mermaid-zoom-btn code-block-fullscreen-btn";
    fullscreenBtn.tabIndex = -1;
    fullscreenBtn.innerHTML = IconMaximize2;
    applyTooltip(fullscreenBtn, t("View Fullscreen"), { placement: "above" });

    // Copy button
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.tabIndex = -1;
    copyBtn.innerHTML = IconCopy;
    const copyTooltip = applyTooltip(copyBtn, t("Copy Code"), { placement: "above" });
    let copyRestoreTimer: ReturnType<typeof setTimeout> | null = null;

    copyBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const code = codeEl.textContent ?? "";
        copyBtn.innerHTML = IconCheck;
        copyBtn.classList.add("copy-btn--done");
        copyTooltip.setText(t("Copied!"));
        copyTooltip.show();
        if (copyRestoreTimer) clearTimeout(copyRestoreTimer);
        copyRestoreTimer = setTimeout(() => {
            copyBtn.innerHTML = IconCopy;
            copyBtn.classList.remove("copy-btn--done");
            copyTooltip.setText(t("Copy Code"));
            copyRestoreTimer = null;
        }, 1500);
        navigator.clipboard?.writeText(code).catch(() => {
            const ta = document.createElement("textarea");
            ta.value = code;
            ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            try { document.execCommand("copy"); } catch { /* ignore */ }
            document.body.removeChild(ta);
        });
    });

    function applyWordWrapState(): void {
        wrapper.classList.toggle("code-block-wrapper--word-wrap", isWordWrap);
        wrapper.classList.toggle("code-block-wrapper--no-word-wrap", !isWordWrap);
        wordWrapBtn.classList.toggle("code-wrap-toggle-btn--active", isWordWrap);
        wordWrapTooltip.setText(isWordWrap ? t("Disable Word Wrap") : t("Enable Word Wrap"));
    }

    wordWrapBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        isWordWrap = !isWordWrap;
        applyWordWrapState();
        scheduleLineNumberRefresh();
        hideTooltip();
    });

    applyWordWrapState();

    // Collapsed `…` (MAR-125): the shared fold-ellipsis mounted beside the
    // lang picker, shown only while the fold plugin's decoration marks the
    // wrapper `collapsed` (the callout-NodeView protocol). The content area
    // and any preview hide; this chrome row stays.
    const codeLineCount = (text: string): number =>
        text === "" ? 0 : text.split("\n").length;
    const foldEllipsis = createFoldEllipsis(
        codeLineCount(node.textContent),
        () => {
            const pos = getPos();
            if (pos === undefined) return;
            view.dispatch(
                view.state.tr
                    .setMeta(foldPluginKey, { type: "set", pos, folded: false } satisfies FoldMeta)
                    .setMeta("addToHistory", false),
            );
            view.focus();
        },
        "lines",
    );
    foldEllipsis.dom.classList.add("code-fold-ellipsis");

    // header: [picker][…][spacer][toggleBtn][wordWrapBtn][fullscreenBtn][copyBtn]
    header.appendChild(picker.el);
    header.appendChild(foldEllipsis.dom);
    header.appendChild(spacer);
    header.appendChild(toggleBtn);
    header.appendChild(wordWrapBtn);
    header.appendChild(fullscreenBtn);
    header.appendChild(copyBtn);

    // ── Code area ─────────────────────────────────────────
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    const currentClassLang = normalizeCodeLanguage(currentLang);
    if (currentClassLang) codeEl.className = `language-${currentClassLang}`;

    const lineGutter = document.createElement("div");
    lineGutter.className = "line-numbers-gutter";
    lineGutter.contentEditable = "false";
    updateLineNumbers(lineGutter, node.textContent);

    pre.appendChild(lineGutter);
    pre.appendChild(codeEl);

    let lineNumberRaf: number | null = null;
    const refreshLineNumbers = (): void => {
        updateLineNumbers(
            lineGutter,
            node.textContent,
            getVisualLineCounts(codeEl, node.textContent, isWordWrap),
        );
    };
    const scheduleLineNumberRefresh = (): void => {
        if (lineNumberRaf !== null) {
            cancelAnimationFrame(lineNumberRaf);
        }
        lineNumberRaf = requestAnimationFrame(() => {
            lineNumberRaf = null;
            refreshLineNumbers();
        });
    };

    // ── Mermaid preview area ───────────────────────────────
    const mermaidPreview = document.createElement("div");
    mermaidPreview.className = "mermaid-preview";
    mermaidPreview.contentEditable = "false";

    // SVG container (the transform is applied here)
    const svgContainer = document.createElement("div");
    svgContainer.className = "mermaid-svg-container";
    mermaidPreview.appendChild(svgContainer);

    // ── Top-right zoom overlay: [-] [percentage] [+] ─────────────
    const zoomOverlay = document.createElement("div");
    zoomOverlay.className = "mermaid-zoom-overlay";
    zoomOverlay.contentEditable = "false";

    const overlayZoomOut = makeMermaidBtn(IconZoomOut, t("Zoom Out"), "mermaid-overlay-btn");
    const overlayZoomVal = document.createElement("button");
    overlayZoomVal.className = "mermaid-zoom-btn mermaid-overlay-btn mermaid-overlay-val";
    overlayZoomVal.tabIndex = -1;
    overlayZoomVal.textContent = "100%";
    applyTooltip(overlayZoomVal, t("Reset Zoom"), { placement: "above" });
    const overlayZoomIn = makeMermaidBtn(IconZoomIn, t("Zoom In"), "mermaid-overlay-btn");

    zoomValueDisplay = overlayZoomVal;
    zoomOverlay.append(overlayZoomOut, overlayZoomVal, overlayZoomIn);
    mermaidPreview.appendChild(zoomOverlay);

    // ── Bottom-right direction controls: ↑←[reset]→↓ ─────────────────────
    const panControls = document.createElement("div");
    panControls.className = "mermaid-pan-controls";
    panControls.contentEditable = "false";

    // Center reset button (fit-to-view)
    const panResetBtn = document.createElement("button");
    panResetBtn.className = "mermaid-pan-btn mermaid-pan-reset";
    panResetBtn.tabIndex = -1;
    panResetBtn.innerHTML = IconResetZoom;
    applyTooltip(panResetBtn, t("Reset Zoom"), { placement: "above" });
    panResetBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        fitToView();
    });

    const panUp    = makePanBtn(IconChevronUp,    "up");
    const panDown  = makePanBtn(IconChevronDown,  "down");
    const panLeft  = makePanBtn(IconChevronLeft,  "left");
    const panRight = makePanBtn(IconChevronRight, "right");

    const panGrid = document.createElement("div");
    panGrid.className = "mermaid-pan-grid";
    // row1: _ ↑ _
    panGrid.appendChild(document.createElement("span"));
    panGrid.appendChild(panUp);
    panGrid.appendChild(document.createElement("span"));
    // row2: ← [reset] →
    panGrid.appendChild(panLeft);
    panGrid.appendChild(panResetBtn);
    panGrid.appendChild(panRight);
    // row3: _ ↓ _
    panGrid.appendChild(document.createElement("span"));
    panGrid.appendChild(panDown);
    panGrid.appendChild(document.createElement("span"));

    panControls.appendChild(panGrid);
    mermaidPreview.appendChild(panControls);

    function makePanBtn(icon: string, dir: string): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.className = "mermaid-pan-btn";
        btn.tabIndex = -1;
        btn.innerHTML = icon;
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation();
            switch (dir) {
                case "up":    panY += PAN_STEP; break;
                case "down":  panY -= PAN_STEP; break;
                case "left":  panX += PAN_STEP; break;
                case "right": panX -= PAN_STEP; break;
            }
            applyTransform();
        });
        return btn;
    }

    // ── Drag handle ────────────────────────────────────────
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "code-block-resize-handle";
    resizeHandle.contentEditable = "false";
    applyTooltip(resizeHandle, t("Drag to resize"), { placement: "above" });

    resizeHandle.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        // Measure the starting height from whichever element is currently visible
        const visibleEl = isPreviewMode ? previewEl() : pre;
        const startY = e.clientY;
        const startH = visibleEl.getBoundingClientRect().height;

        const onMove = (ev: MouseEvent) => {
            const newH = Math.max(80, startH + ev.clientY - startY);
            // Keep every element's height in sync so switching modes preserves it
            pre.style.maxHeight = `${newH}px`;
            pre.style.height = `${newH}px`;
            mermaidPreview.style.maxHeight = `${newH}px`;
            mermaidPreview.style.height = `${newH}px`;
            latexPreview.style.maxHeight = `${newH}px`;
            latexPreview.style.height = `${newH}px`;
            calcPreview.style.maxHeight = `${newH}px`;
            calcPreview.style.height = `${newH}px`;
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    // ── LaTeX preview area (block math) ───────────────────
    const latexPreview = document.createElement("div");
    latexPreview.className = "latex-preview";
    latexPreview.contentEditable = "false";
    const latexRender = document.createElement("div");
    latexRender.className = "latex-render";
    latexPreview.appendChild(latexRender);

    // ── Calc preview area (living calculations) ───────────
    const calcPreview = document.createElement("div");
    calcPreview.className = "calc-preview";
    calcPreview.contentEditable = "false";
    const calcRender = document.createElement("div");
    calcRender.className = "calc-render";
    calcPreview.appendChild(calcRender);

    let calcRenderTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * Paint each source line beside its computed value (a two-column ledger).
     * Synchronous, deterministic, and network-free — no lazy dependency, so it
     * is cheap enough to re-run on every edit (the "living" recompute). The
     * source is never mutated; results live only here, so the block round-trips
     * as ordinary Markdown.
     */
    function renderCalc(code: string): void {
        if (!isCalc || !isPreviewMode) { return; }
        const rows = evaluateCalcBlock(code);
        calcRender.replaceChildren();
        for (const { raw, result } of rows) {
            const row = document.createElement("div");
            row.className = "calc-row";
            const src = document.createElement("span");
            src.className = "calc-row-src";
            src.textContent = raw || " "; // keep blank lines visible/tall
            row.appendChild(src);
            if (result !== null) {
                const res = document.createElement("span");
                res.className = "calc-row-result";
                res.textContent = result;
                row.appendChild(res);
            }
            calcRender.appendChild(row);
        }
    }

    // The single element that is visible while in preview mode.
    const previewEl = (): HTMLElement =>
        isCalc ? calcPreview : isLatex ? latexPreview : mermaidPreview;

    let latexRenderTimer: ReturnType<typeof setTimeout> | null = null;
    async function renderLatex(code: string): Promise<void> {
        if (!isLatex || !isPreviewMode) return;
        const trimmed = code.trim();
        if (!trimmed) {
            latexRender.innerHTML = `<div class="latex-empty">${t("Empty formula")}</div>`;
            return;
        }
        try {
            await renderKatexInto(latexRender, trimmed, true);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            latexRender.innerHTML = `<div class="mermaid-error"><span>${IconAlertCircle}</span><pre class="mermaid-error-msg">${escapeHtml(msg)}</pre></div>`;
        }
    }

    wrapper.appendChild(header);
    wrapper.appendChild(pre);
    wrapper.appendChild(mermaidPreview);
    wrapper.appendChild(latexPreview);
    wrapper.appendChild(calcPreview);
    wrapper.appendChild(resizeHandle);
    scheduleLineNumberRefresh();

    const lineNumberResizeObserver = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => scheduleLineNumberRefresh())
        : null;
    lineNumberResizeObserver?.observe(codeEl);

    // ── Transform helpers ──────────────────────────────────
    function applyTransform(): void {
        svgContainer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
        // Sync the percentage display
        if (zoomValueDisplay) {
            zoomValueDisplay.textContent = `${Math.round(zoomLevel * 100)}%`;
        }
    }

    // fitToView: read the SVG viewBox and scale to fill the container
    function fitToView(): void {
        const svgEl = svgContainer.querySelector("svg");
        if (!svgEl) return;

        requestAnimationFrame(() => {
            const containerW = mermaidPreview.clientWidth;
            const containerH = mermaidPreview.clientHeight;
            if (!containerW || !containerH) return;

            if (!naturalSvgW || !naturalSvgH) return;

            const padding = 40;
            const scaleX = (containerW - padding) / naturalSvgW;
            const scaleY = (containerH - padding) / naturalSvgH;
            zoomLevel = Math.min(scaleX, scaleY, ZOOM_MAX);
            zoomLevel = Math.max(ZOOM_MIN, zoomLevel);
            panX = 0; panY = 0;
            applyTransform();
        });
    }

    // ── Mermaid rendering ──────────────────────────────────
    async function renderMermaid(code: string): Promise<void> {
        if (!isMermaid || !isPreviewMode) return;
        if (isRendering) return;
        if (code === lastRenderedCode && svgContainer.querySelector("svg")) return;

        // Claim the render slot synchronously (before any await) so a second
        // call while Mermaid lazily loads can't slip past the isRendering guard.
        isRendering = true;
        naturalSvgW = 0; naturalSvgH = 0;
        svgContainer.innerHTML = `<div class="mermaid-loading">${t("Rendering...")}</div>`;

        // svgContainer is inline-block, and the loading div is absolutely positioned so it takes no space → clientWidth=0.
        // Set a temporary width before rendering so Mermaid (especially Gantt charts) lays out at the correct width.
        const renderWidth = mermaidPreview.clientWidth || 800;
        svgContainer.style.width = renderWidth + "px";

        // Pass svgContainer as the third argument: mermaid then uses a hidden div (invisible),
        // no longer injecting a visible error element (bomb icon) into body, and auto-removes the hidden div after rendering
        const id = `mmid-${Math.random().toString(36).slice(2, 9)}`;
        try {
            const mermaid = await ensureMermaid();
            const { svg } = await mermaid.render(id, code, svgContainer);
            svgContainer.innerHTML = svg;
            const svgEl = svgContainer.querySelector("svg");
            if (svgEl) {
                svgEl.style.display = "block";
                // Multi-level fallback for reading the natural size (svgContainer.style.width is still renderWidth here,
                // so width="100%" SVGs like Gantt charts compute clientWidth at the real width)
                let nw = 0, nh = 0;
                // 1. viewBox (most precise)
                const vb = svgEl.getAttribute("viewBox");
                if (vb) {
                    const parts = vb.trim().split(/[\s,]+/);
                    if (parts.length >= 4) {
                        nw = parseFloat(parts[2]);
                        nh = parseFloat(parts[3]);
                    }
                }
                // 2. Explicit width/height attributes (excluding percentage values like "100%")
                if (!nw) {
                    const wa = svgEl.getAttribute("width");
                    if (wa && !wa.includes("%")) nw = parseFloat(wa);
                }
                if (!nh) {
                    const ha = svgEl.getAttribute("height");
                    if (ha && !ha.includes("%")) nh = parseFloat(ha);
                }
                // 3. The browser's actual rendered size (svgContainer width is still set, so clientWidth is valid)
                if (!nw) nw = svgEl.clientWidth || renderWidth;
                if (!nh) nh = svgEl.clientHeight || 400;
                naturalSvgW = nw;
                naturalSvgH = nh;
                // Write the natural size back to the SVG attributes so CSS scale is based on a fixed pixel size
                // (if Mermaid outputs width="100%", not writing it back makes CSS scale base on the container width, causing incorrect scaling)
                svgEl.setAttribute("width", String(nw));
                svgEl.setAttribute("height", String(nh));
                // Clear any max-width:100%;height:auto inline styles Mermaid may have added,
                // otherwise they override the width/height attributes written above and the SVG renders at the container width
                svgEl.style.maxWidth = "none";
                svgEl.style.height = "";
                // Clear the temporary render width (the size has been read)
                svgContainer.style.width = "";
                // ── Adaptive container height ────────────────────────
                // Estimate a suitable container height from the "fill width" scale ratio; tall diagrams expand automatically
                // fitWidthScale is capped at ≤1.0, so small diagrams aren't enlarged
                const availableW = mermaidPreview.clientWidth || 800;
                const fitWidthScale = Math.min((availableW - 40) / nw, 1.0);
                const idealH = nh * fitWidthScale + 80; // 40px padding top and bottom
                const maxH = Math.min(window.innerHeight * 0.92, 2000);
                const finalH = Math.max(300, Math.min(Math.ceil(idealH), maxH));
                mermaidPreview.style.height = finalH + "px";
                mermaidPreview.style.minHeight = finalH + "px";
                // ─────────────────────────────────────────────────────
            } else {
                svgContainer.style.width = "";
            }
            lastRenderedCode = code;
            fitToView();
        } catch (err) {
            svgContainer.style.width = ""; // restore on error too
            const msg = err instanceof Error ? err.message : String(err);
            svgContainer.innerHTML = `
                <div class="mermaid-error">
                    <span>${IconAlertCircle}</span>
                    <pre class="mermaid-error-msg">${escapeHtml(msg)}</pre>
                </div>`;
        } finally {
            isRendering = false;
        }
    }

    // Register the Mermaid instance (used to re-render on theme change)
    const mermaidInstance: MermaidInstance = {
        get isMermaid() { return isMermaid; },
        get isPreviewMode() { return isPreviewMode; },
        get lastRenderedCode() { return lastRenderedCode; },
        renderMermaid,
    };
    mermaidInstances.add(mermaidInstance);

    // Enter preview mode (internal reuse)
    function enterPreviewMode(): void {
        isPreviewMode = true;
        toggleBtn.innerHTML = IconCode;
        toggleBtn.classList.add("code-view-toggle-btn--active");
        toggleTooltip.setText(t("Edit Code"));
        // Collapse rather than display:none: the block's gutter marker
        // (heading-fold widget) lives inside `pre`, and display:none on an
        // ancestor is un-overridable — visibility is, so the marker's own
        // visibility:visible keeps the grabber alive in preview mode.
        pre.classList.add("code-pre--preview-hidden");
        previewEl().style.display = "flex";
        wordWrapBtn.style.display = "none";
    }

    // Exit preview mode (internal reuse)
    function exitPreviewMode(): void {
        isPreviewMode = false;
        toggleBtn.innerHTML = IconEye;
        toggleBtn.classList.remove("code-view-toggle-btn--active");
        toggleTooltip.setText(previewTip());
        pre.classList.remove("code-pre--preview-hidden");
        mermaidPreview.style.display = "none";
        latexPreview.style.display = "none";
        calcPreview.style.display = "none";
        wordWrapBtn.style.display = "inline-flex";
    }

    // Render whichever preview the current language maps to.
    function renderPreview(code: string): void {
        if (isCalc) renderCalc(code);
        else if (isLatex) void renderLatex(code);
        else void renderMermaid(code);
    }

    // ── Toggle code/preview ────────────────────────────────
    toggleBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (isPreviewMode) {
            exitPreviewMode();
        } else {
            enterPreviewMode();
            renderPreview(node.textContent);
        }
    });

    // ── Mermaid / LaTeX enter preview mode by default ──────────────────
    if (isPreviewable() && shouldAutoConvertCodeBlock()) {
        enterPreviewMode();
        setTimeout(() => renderPreview(node.textContent), 0);
    }

    // ── Drag to pan (mouse drag) ──────────────────────────
    mermaidPreview.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || (e.target as Element).closest("button")) return;
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX - panX;
        const startY = e.clientY - panY;
        mermaidPreview.classList.add("mermaid-preview--panning");
        const onMove = (ev: MouseEvent) => {
            panX = ev.clientX - startX;
            panY = ev.clientY - startY;
            applyTransform();
        };
        const onUp = () => {
            mermaidPreview.classList.remove("mermaid-preview--panning");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    // ── Trackpad/wheel events ──────────────────────────────
    // The inline preview only responds to ctrlKey=true (Mac pinch-to-zoom); normal scrolling passes through to the page.
    // The fullscreen preview (openDiagramLightbox) still keeps wheel pan + zoom.
    const onPreviewWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return; // don't intercept normal scrolling, let the page scroll
        e.preventDefault();
        e.stopPropagation();
        // Pinch: exponential smooth zoom, no jumps
        const factor = Math.pow(0.98, e.deltaY);
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomLevel * factor));
        // Use the mouse/finger position as the zoom center
        const rect = mermaidPreview.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        const r = newZoom / zoomLevel;
        panX = mx + (panX - mx) * r;
        panY = my + (panY - my) * r;
        zoomLevel = newZoom;
        applyTransform();
    };
    mermaidPreview.addEventListener("wheel", onPreviewWheel, { passive: false });

    // ── Overlay zoom buttons ──────────────────────────────
    overlayZoomOut.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        zoomLevel = Math.max(ZOOM_MIN, zoomLevel - ZOOM_BTN);
        applyTransform();
    });
    overlayZoomIn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        zoomLevel = Math.min(ZOOM_MAX, zoomLevel + ZOOM_BTN);
        applyTransform();
    });
    overlayZoomVal.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        fitToView();
    });

    // ── Fullscreen button ──────────────────────────────────
    fullscreenBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (isMermaid && isPreviewMode) openDiagramLightbox();
        else openCodeLightbox();
    });

    // ── Code fullscreen (editable + syntax highlighting) ─────────────────────────
    function openCodeLightbox(): void {
        if (lbActiveLightbox) return;
        const overlay = document.createElement("div");
        overlay.className = "mermaid-lightbox code-editor-lightbox";
        overlay.classList.toggle("code-lightbox-word-wrap", isWordWrap);
        overlay.classList.toggle("code-lightbox-no-word-wrap", !isWordWrap);

        const lbHeader = document.createElement("div");
        lbHeader.className = "mermaid-lightbox-header";
        lbHeader.contentEditable = "false";

        const lang = (node.attrs["language"] as string) || "";
        const lbTitle = document.createElement("span");
        lbTitle.className = "mermaid-lightbox-title";
        lbTitle.textContent = getLangLabel(lang);

        const lbCopyBtn = makeMermaidBtn(IconCopy, t("Copy Code"));
        const lbCloseBtn = makeMermaidBtn(IconX, t("Close"));

        lbHeader.append(lbTitle, lbCopyBtn, lbCloseBtn);

        // ── Editor body: line-number area + code area (highlighted pre + textarea overlay)
        const lbBody = document.createElement("div");
        lbBody.className = "mermaid-lightbox-body code-lightbox-body";

        // Line-number bar
        const gutter = document.createElement("div");
        gutter.className = "code-lightbox-gutter";
        gutter.setAttribute("aria-hidden", "true");

        // Code area (pre highlight layer + textarea input layer)
        const codeArea = document.createElement("div");
        codeArea.className = "code-lightbox-editor-wrap";

        const pre = document.createElement("pre");
        pre.className = "code-lightbox-pre";
        pre.setAttribute("aria-hidden", "true");
        const codeClone = document.createElement("code");
        const classLang = normalizeCodeLanguage(lang);
        if (classLang) codeClone.className = `language-${classLang}`;
        pre.appendChild(codeClone);

        const textarea = document.createElement("textarea");
        textarea.className = "code-lightbox-textarea";
        textarea.spellcheck = false;
        textarea.autocomplete = "off";
        textarea.setAttribute("autocorrect", "off");
        textarea.setAttribute("autocapitalize", "off");

        const rawCode = codeEl.textContent ?? "";
        textarea.value = rawCode;
        codeClone.innerHTML = highlight(rawCode, lang);

        codeArea.append(pre, textarea);
        lbBody.append(gutter, codeArea);
        overlay.append(lbHeader, lbBody);
        document.body.appendChild(overlay);
        lockBodyScroll();
        lbActiveLightbox = overlay;

        // ── Line-number update
        const updateGutter = (): void => {
            updateLineNumbers(
                gutter,
                textarea.value,
                getVisualLineCounts(textarea, textarea.value, isWordWrap),
            );
        };
        updateGutter();
        const gutterResizeObserver = typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(updateGutter)
            : null;
        gutterResizeObserver?.observe(textarea);

        // Auto-focus
        requestAnimationFrame(() => {
            textarea.focus();
            updateGutter();
        });

        // ── Live highlight + line numbers + scroll sync
        const updateHighlight = (): void => {
            codeClone.innerHTML = highlight(textarea.value, lang);
            updateGutter();
            pre.scrollTop = textarea.scrollTop;
            pre.scrollLeft = textarea.scrollLeft;
            gutter.scrollTop = textarea.scrollTop;
        };
        textarea.addEventListener("input", updateHighlight);
        textarea.addEventListener("scroll", () => {
            pre.scrollTop = textarea.scrollTop;
            pre.scrollLeft = textarea.scrollLeft;
            gutter.scrollTop = textarea.scrollTop;
        });

        // Local undo/redo: VS Code's Electron layer swallows Cmd/Ctrl+Z
        // before the native textarea sees it
        const detachTextareaUndo = attachInputUndo(textarea);

        // Tab inserts 4 spaces (instead of moving focus)
        textarea.addEventListener("keydown", (e) => {
            if (e.key === "Tab") {
                e.preventDefault();
                const s = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.value = textarea.value.slice(0, s) + "    " + textarea.value.slice(end);
                textarea.selectionStart = textarea.selectionEnd = s + 4;
                // Synthetic input event: refreshes the highlight layer AND
                // records the insertion in the local undo history
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
            }
        });

        // ── Copy the current textarea content
        lbCopyBtn.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation();
            navigator.clipboard?.writeText(textarea.value).catch(() => {});
            lbCopyBtn.innerHTML = IconCheck;
            setTimeout(() => { lbCopyBtn.innerHTML = IconCopy; }, 1500);
        });

        // ── Close (with fade-out animation + write back to ProseMirror)
        function closeLb(): void {
            if (!lbDismissCleanup) return; // close already ran (e.g. X during the fade)
            // Synchronous teardown of the Escape layer + document listener:
            // deferring it to animationend swallowed a second Escape during
            // the close fade (and re-ran this close). Only the DOM/animation
            // teardown stays deferred.
            lbDismissCleanup();
            lbDismissCleanup = null;
            const newCode = textarea.value;
            const originalCode = codeEl.textContent ?? "";
            if (newCode !== originalCode) {
                const pos = getPos();
                if (pos !== undefined) {
                    const n = view.state.doc.nodeAt(pos);
                    if (n) {
                        view.dispatch(
                            view.state.tr.replaceWith(
                                pos + 1,
                                pos + n.nodeSize - 1,
                                newCode ? view.state.schema.text(newCode) : [],
                            )
                        );
                    }
                }
            }
            unlockBodyScroll();
            gutterResizeObserver?.disconnect();
            detachTextareaUndo();
            animateCloseLightbox(overlay, () => {
                lbActiveLightbox = null;
            });
        }

        lbDismissCleanup = bindLightboxDismiss(overlay, lbCloseBtn, closeLb);
    }

    // ── Mermaid diagram fullscreen ─────────────────────────
    function openDiagramLightbox(): void {
        if (lbActiveLightbox) return;
        if (!svgContainer.querySelector("svg")) return;

        let lbPanX = 0, lbPanY = 0, lbZoom = 1.0;
        let lbIsCodeMode = false;
        const originalCode = codeEl.textContent ?? "";

        // ── Overlay ───────────────────────────────────────────
        const overlay = document.createElement("div");
        overlay.className = "mermaid-lightbox";
        overlay.classList.toggle("code-lightbox-word-wrap", isWordWrap);
        overlay.classList.toggle("code-lightbox-no-word-wrap", !isWordWrap);

        // ── Header ────────────────────────────────────────────
        const lbHeader = document.createElement("div");
        lbHeader.className = "mermaid-lightbox-header";
        lbHeader.contentEditable = "false";

        const lbTitle = document.createElement("span");
        lbTitle.className = "mermaid-lightbox-title";
        lbTitle.textContent = "Mermaid";

        const lbToggleBtn = document.createElement("button");
        lbToggleBtn.className = "mermaid-zoom-btn";
        lbToggleBtn.tabIndex = -1;
        lbToggleBtn.innerHTML = IconCode;
        const lbToggleTip = applyTooltip(lbToggleBtn, t("Edit Code"), { placement: "above" });
        const lbZoomOutBtn  = makeMermaidBtn(IconZoomOut, t("Zoom Out"));
        const lbZoomResetBtn = document.createElement("button");
        lbZoomResetBtn.className = "mermaid-zoom-btn";
        lbZoomResetBtn.tabIndex = -1;
        lbZoomResetBtn.textContent = "100%";
        applyTooltip(lbZoomResetBtn, t("Reset Zoom"), { placement: "above" });
        const lbZoomInBtn = makeMermaidBtn(IconZoomIn, t("Zoom In"));
        const lbCloseBtn  = makeMermaidBtn(IconX, t("Close"));

        lbHeader.append(lbTitle, lbToggleBtn, lbZoomOutBtn, lbZoomResetBtn, lbZoomInBtn, lbCloseBtn);

        // ── Body ──────────────────────────────────────────────
        const lbBody = document.createElement("div");
        lbBody.className = "mermaid-lightbox-body";

        // Preview pane
        const lbPreviewPane = document.createElement("div");
        lbPreviewPane.className = "lb-mermaid-preview-pane";

        const lbSvgContainer = document.createElement("div");
        lbSvgContainer.className = "mermaid-lightbox-svg";
        lbSvgContainer.innerHTML = svgContainer.innerHTML;
        const lbSvgEl = lbSvgContainer.querySelector("svg");
        if (lbSvgEl) lbSvgEl.style.display = "block";
        lbPreviewPane.appendChild(lbSvgContainer);

        // Code editing pane (reuses the code lightbox structure)
        const lbCodePane = document.createElement("div");
        lbCodePane.className = "lb-mermaid-code-pane";

        const gutter = document.createElement("div");
        gutter.className = "code-lightbox-gutter";
        gutter.setAttribute("aria-hidden", "true");

        const codeArea = document.createElement("div");
        codeArea.className = "code-lightbox-editor-wrap";

        const lbPre = document.createElement("pre");
        lbPre.className = "code-lightbox-pre";
        lbPre.setAttribute("aria-hidden", "true");
        const lbCodeEl = document.createElement("code");
        lbCodeEl.className = "language-mermaid";
        lbPre.appendChild(lbCodeEl);

        const textarea = document.createElement("textarea");
        textarea.className = "code-lightbox-textarea";
        textarea.spellcheck = false;
        textarea.autocomplete = "off";
        textarea.setAttribute("autocorrect", "off");
        textarea.setAttribute("autocapitalize", "off");
        textarea.value = originalCode;
        lbCodeEl.innerHTML = highlight(originalCode, "mermaid");

        codeArea.append(lbPre, textarea);
        lbCodePane.append(gutter, codeArea);

        lbBody.append(lbPreviewPane, lbCodePane);
        overlay.append(lbHeader, lbBody);
        document.body.appendChild(overlay);
        lockBodyScroll();
        lbActiveLightbox = overlay;

        // ── Line numbers ───────────────────────────────────────
        const updateGutter = (): void => {
            updateLineNumbers(
                gutter,
                textarea.value,
                getVisualLineCounts(textarea, textarea.value, isWordWrap),
            );
        };
        updateGutter();
        const gutterResizeObserver = typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(updateGutter)
            : null;
        gutterResizeObserver?.observe(textarea);

        // ── Live highlight + scroll sync ──────────────────────
        const updateHighlight = (): void => {
            lbCodeEl.innerHTML = highlight(textarea.value, "mermaid");
            updateGutter();
            lbPre.scrollTop = textarea.scrollTop;
            lbPre.scrollLeft = textarea.scrollLeft;
            gutter.scrollTop = textarea.scrollTop;
        };
        textarea.addEventListener("input", updateHighlight);
        textarea.addEventListener("scroll", () => {
            lbPre.scrollTop = textarea.scrollTop;
            lbPre.scrollLeft = textarea.scrollLeft;
            gutter.scrollTop = textarea.scrollTop;
        });
        textarea.addEventListener("keydown", (e) => {
            if (e.key === "Tab") {
                e.preventDefault();
                const s = textarea.selectionStart, end = textarea.selectionEnd;
                textarea.value = textarea.value.slice(0, s) + "    " + textarea.value.slice(end);
                textarea.selectionStart = textarea.selectionEnd = s + 4;
                updateHighlight();
            }
        });

        // ── Preview-pane transform ─────────────────────────────
        function applyLbTransform(): void {
            lbSvgContainer.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom})`;
            lbZoomResetBtn.textContent = `${Math.round(lbZoom * 100)}%`;
        }

        function fitLbView(): void {
            const svgEl2 = lbSvgContainer.querySelector("svg");
            if (!svgEl2) return;
            const bW = lbPreviewPane.clientWidth, bH = lbPreviewPane.clientHeight;
            const sW = parseFloat(svgEl2.getAttribute("width") ?? "0");
            const sH = parseFloat(svgEl2.getAttribute("height") ?? "0");
            if (sW && sH && bW && bH) {
                lbPanX = 0; lbPanY = 0;
                lbZoom = Math.max(ZOOM_MIN, Math.min((bW - 80) / sW, (bH - 80) / sH, ZOOM_MAX));
                applyLbTransform();
            }
        }

        requestAnimationFrame(fitLbView);

        // ── Mermaid rendering inside the lightbox ────────────────────────
        async function renderLbMermaid(code: string): Promise<void> {
            lbSvgContainer.innerHTML = `<div class="mermaid-loading">${t("Rendering...")}</div>`;
            const id = `lbmm-${Math.random().toString(36).slice(2, 9)}`;
            const hidden = document.createElement("div");
            hidden.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
            document.body.appendChild(hidden);
            try {
                const mermaid = await ensureMermaid();
                const { svg } = await mermaid.render(id, code, hidden);
                lbSvgContainer.innerHTML = svg;
                const svgEl = lbSvgContainer.querySelector("svg");
                if (svgEl) {
                    const vb = svgEl.getAttribute("viewBox");
                    if (vb) {
                        const parts = vb.trim().split(/[\s,]+/);
                        if (parts.length >= 4) {
                            const w = parseFloat(parts[2]), h = parseFloat(parts[3]);
                            if (w && h) { svgEl.setAttribute("width", String(w)); svgEl.setAttribute("height", String(h)); }
                        }
                    }
                    svgEl.style.display = "block";
                }
                requestAnimationFrame(fitLbView);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                lbSvgContainer.innerHTML = `<div class="mermaid-error"><span>${IconAlertCircle}</span><pre class="mermaid-error-msg">${escapeHtml(msg)}</pre></div>`;
            } finally {
                if (document.body.contains(hidden)) document.body.removeChild(hidden);
            }
        }

        // ── Toggle code / preview ──────────────────────────────
        function switchToCodeMode(): void {
            lbIsCodeMode = true;
            lbPreviewPane.style.display = "none";
            lbCodePane.style.display = "flex";
            [lbZoomOutBtn, lbZoomResetBtn, lbZoomInBtn].forEach(b => (b.style.display = "none"));
            lbToggleBtn.innerHTML = IconEye;
            lbToggleTip.setText(t("Preview Diagram"));
            hideTooltip();
            requestAnimationFrame(() => textarea.focus());
        }

        function switchToPreviewMode(): void {
            lbIsCodeMode = false;
            lbPreviewPane.style.display = "";
            lbCodePane.style.display = "none";
            [lbZoomOutBtn, lbZoomResetBtn, lbZoomInBtn].forEach(b => (b.style.display = ""));
            lbToggleBtn.innerHTML = IconCode;
            lbToggleTip.setText(t("Edit Code"));
            hideTooltip();
            if (textarea.value !== originalCode) renderLbMermaid(textarea.value);
        }

        lbToggleBtn.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (lbIsCodeMode) switchToPreviewMode(); else switchToCodeMode();
        });

        // ── Preview-pane interaction (drag to pan + wheel to zoom) ────────────────
        lbPreviewPane.addEventListener("mousedown", (e) => {
            if (e.button !== 0 || (e.target as Element).closest("button")) return;
            e.preventDefault();
            const sx = e.clientX - lbPanX, sy = e.clientY - lbPanY;
            lbPreviewPane.style.cursor = "grabbing";
            const onMove = (ev: MouseEvent) => { lbPanX = ev.clientX - sx; lbPanY = ev.clientY - sy; applyLbTransform(); };
            const onUp = () => { lbPreviewPane.style.cursor = "grab"; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        lbPreviewPane.addEventListener("wheel", (e) => {
            e.preventDefault();
            if (e.ctrlKey) {
                let nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, lbZoom * Math.pow(0.98, e.deltaY)));
                const rect = lbPreviewPane.getBoundingClientRect();
                const mx = e.clientX - rect.left - rect.width / 2;
                const my = e.clientY - rect.top - rect.height / 2;
                const r = nz / lbZoom;
                lbPanX = mx + (lbPanX - mx) * r;
                lbPanY = my + (lbPanY - my) * r;
                lbZoom = nz;
            } else {
                lbPanX -= e.deltaX;
                lbPanY -= e.deltaY;
            }
            applyLbTransform();
        }, { passive: false });

        lbZoomInBtn.addEventListener("mousedown",  (e) => { e.preventDefault(); e.stopPropagation(); lbZoom = Math.min(ZOOM_MAX, lbZoom + ZOOM_BTN); applyLbTransform(); });
        lbZoomOutBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); lbZoom = Math.max(ZOOM_MIN, lbZoom - ZOOM_BTN); applyLbTransform(); });
        lbZoomResetBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); lbPanX = 0; lbPanY = 0; lbZoom = 1.0; applyLbTransform(); });

        // ── Close (write back to ProseMirror) ──────────────────────────
        function closeLb(): void {
            if (!lbDismissCleanup) return; // close already ran (e.g. X during the fade)
            // Synchronous teardown of the Escape layer + document listener
            // (see the code lightbox's closeLb): only DOM/animation teardown
            // stays deferred to animationend.
            lbDismissCleanup();
            lbDismissCleanup = null;
            const newCode = textarea.value;
            if (newCode !== originalCode) {
                const pos = getPos();
                if (pos !== undefined) {
                    const n = view.state.doc.nodeAt(pos);
                    if (n) {
                        view.dispatch(
                            view.state.tr.replaceWith(
                                pos + 1,
                                pos + n.nodeSize - 1,
                                newCode ? view.state.schema.text(newCode) : [],
                            )
                        );
                    }
                }
            }
            unlockBodyScroll();
            gutterResizeObserver?.disconnect();
            animateCloseLightbox(overlay, () => {
                lbActiveLightbox = null;
            });
        }

        lbDismissCleanup = bindLightboxDismiss(overlay, lbCloseBtn, closeLb);
    }

    return {
        dom: wrapper,
        contentDOM: codeEl,

        update(updatedNode: PMNode): boolean {
            if (updatedNode.type !== node.type) return false;

            const newLang = (updatedNode.attrs["language"] as string) || "";
            const wasPreviewable = isPreviewable();
            isMermaid = newLang === "mermaid";
            isLatex = normalizeCodeLanguage(newLang) === "latex";
            isCalc = normalizeCodeLanguage(newLang) === "calc";
            const nowPreviewable = isPreviewable();

            picker.update(newLang);
            const classLang = normalizeCodeLanguage(newLang);
            codeEl.className = classLang ? `language-${classLang}` : "";
            node = updatedNode;
            scheduleLineNumberRefresh();
            foldEllipsis.setCount(codeLineCount(updatedNode.textContent));

            if (!wasPreviewable && nowPreviewable) {
                toggleBtn.style.display = "inline-flex";
                if (shouldAutoConvertCodeBlock()) {
                    enterPreviewMode();
                    setTimeout(() => renderPreview(updatedNode.textContent), 0);
                }
            }
            if (wasPreviewable && !nowPreviewable) {
                toggleBtn.style.display = "none";
                exitPreviewMode();
                lastRenderedCode = "";
            }
            if (nowPreviewable && isPreviewMode) {
                const newCode = updatedNode.textContent;
                if (isCalc) {
                    // The living recompute: cheap and synchronous, lightly
                    // debounced so a fast burst of typing coalesces.
                    if (calcRenderTimer) clearTimeout(calcRenderTimer);
                    calcRenderTimer = setTimeout(() => renderCalc(newCode), 150);
                } else if (isLatex) {
                    if (latexRenderTimer) clearTimeout(latexRenderTimer);
                    latexRenderTimer = setTimeout(() => renderLatex(newCode), 300);
                } else if (newCode !== lastRenderedCode) {
                    if (renderTimer) clearTimeout(renderTimer);
                    renderTimer = setTimeout(() => renderMermaid(newCode), 600);
                }
            }
            return true;
        },

        ignoreMutation(mutation: ViewMutationRecord): boolean {
            if (mutation.type === "selection") return false;
            if (mutation.type === "attributes") return true; // update() modifies className, so ignore attribute mutations to prevent a reconcile infinite loop (B085)
            return (
                !codeEl.contains(mutation.target as Node) &&
                mutation.target !== codeEl
            );
        },

        destroy(): void {
            mermaidInstances.delete(mermaidInstance);
            picker.destroy();
            if (copyRestoreTimer) clearTimeout(copyRestoreTimer);
            if (renderTimer) clearTimeout(renderTimer);
            if (latexRenderTimer) clearTimeout(latexRenderTimer);
            if (calcRenderTimer) clearTimeout(calcRenderTimer);
            if (lineNumberRaf !== null) cancelAnimationFrame(lineNumberRaf);
            lineNumberResizeObserver?.disconnect();
            mermaidPreview.removeEventListener("wheel", onPreviewWheel);
            // A NodeView can die with its lightbox open (external sync /
            // revert replacing the node): drop the Escape-layer entry and
            // the document key listener too, or a dead layer entry would
            // silently swallow the next Escape.
            lbDismissCleanup?.();
            lbDismissCleanup = null;
            if (lbActiveLightbox && document.body.contains(lbActiveLightbox)) {
                unlockBodyScroll();
                document.body.removeChild(lbActiveLightbox);
                lbActiveLightbox = null;
            }
        },
    };
}
