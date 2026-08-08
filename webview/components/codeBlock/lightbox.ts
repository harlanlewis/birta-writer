/**
 * components/codeBlock/lightbox.ts
 *
 * The two fullscreen surfaces a code block can open:
 *
 *   openCodeLightbox    — an editable, syntax-highlighted full-window editor
 *   openDiagramLightbox — a pan/zoomable diagram canvas beside that same
 *                         editor, for whichever engine rendered the inline pane
 *
 * Both are built on `ui/fullscreenSurface.ts`, which owns the overlay, the
 * dismiss layer, the ground, and the four-corner control geography that every
 * fullscreen surface in the editor shares. What stays here is what is specific
 * to a code block: the gutter+`<pre>`+`<textarea>` anatomy, the diagram's
 * transform, and the write-back-on-close protocol.
 *
 * They still share a `LightboxHost` (only ever one open at a time, and the
 * NodeView's `destroy()` has to be able to tear down whichever it is) and the
 * same write-back: dismiss synchronously, diff the textarea against the node's
 * text, replace the node's content, then fade.
 *
 * The two editor panes are deliberately NOT merged into one helper: the code
 * lightbox attaches local undo and auto-focuses on the next frame, and its Tab
 * handler dispatches a synthetic `input` (so the insertion enters that undo
 * history) where the diagram lightbox calls its highlighter directly. Those
 * are behavior differences, not incidental drift.
 *
 * Two grounds are in play, and the diagram surface uses both. A diagram is a
 * CANVAS — the backdrop is its own paper, edge to edge — until you flip it to
 * the code pane, at which point it is a SHEET and the chrome stops floating
 * over text. `fullscreenSurface.ts` explains why those are the categories.
 */
import type { EditorView } from "@/pm";
import { IconCheck, IconCode, IconCopy, IconEye, IconAlertCircle, IconZoomIn, IconZoomOut } from "@/ui/icons";
import { applyTooltip, hideTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { normalizeCodeLanguage } from "@/codeLanguages";
import { highlight } from "@/highlighter";
import { createButton } from "@/ui/dom";
import { openFullscreenSurface, type FullscreenSurface } from "@/ui/fullscreenSurface";
import { attachInputUndo } from "@/utils/inputUndo";
import { escapeHtml } from "./escapeHtml";
import { getLangLabel } from "./langPicker";
import { getVisualLineCounts, updateLineNumbers } from "./lineNumbers";
import { createPanPad, ZOOM_BTN, ZOOM_MAX, ZOOM_MIN, type DiagramRenderer } from "./diagramPane";

/**
 * How far past its natural size a diagram may be scaled to fill the fullscreen
 * viewport. The inline pane caps fit at 1.0 — a small diagram inside a text
 * column should not balloon — but fullscreen is the opposite request: the
 * gesture means "show me this bigger", and a 120px diagram centred at 100% in
 * a 1400px viewport answers a question nobody asked. These are vectors, so
 * scaling up costs no fidelity.
 */
const FULLSCREEN_MAX_FIT = 4.0;

/**
 * The NodeView's single lightbox slot. Held by the NodeView (not by this
 * module) because a view can die with its lightbox open — an external sync or
 * revert replacing the node — and `destroy()` has to drop the Escape-layer
 * entry and remove the overlay itself.
 */
export type LightboxHost = {
    /** The open overlay element, or null. */
    active: HTMLElement | null;
    /**
     * `bindLightboxDismiss` cleanup (Escape-layer entry + document key
     * listener) for the open lightbox; null while none is open OR once a
     * close has begun.
     */
    dismissCleanup: (() => void) | null;
};

/** What both lightboxes need from the NodeView that opened them. */
type LightboxContext = {
    host: LightboxHost;
    view: EditorView;
    getPos: () => number | undefined;
    /** The NodeView's `contentDOM` — the authoritative current source text. */
    codeEl: HTMLElement;
    /** Live, because a lightbox outlives the read. */
    isWordWrap: () => boolean;
};

/**
 * The NodeView's handle on a surface's dismiss layer. It must CLEAR the
 * surface's own handle as well as running it: the NodeView tears a lightbox
 * down by calling this and then removing the element, and a surface still
 * holding a live cleanup would let a later close() run a second time over a
 * detached overlay.
 */
function hostCleanupFor(surface: FullscreenSurface): () => void {
    return () => {
        surface.dismissCleanup?.();
        surface.dismissCleanup = null;
    };
}

/** A control for the surface's top-right cluster. */
function fsButton(icon: string, tip: string): HTMLButtonElement {
    return createButton({
        className: "ui-btn fs-btn",
        icon,
        tabIndex: -1,
        title: tip,
        tooltipPlacement: "below",
    });
}

/**
 * Replace the code block's content with the textarea's, if it changed. Shared
 * by both closers — the same `replaceWith` over the node's inner range.
 */
function writeBackCode(ctx: LightboxContext, newCode: string, originalCode: string): void {
    if (newCode === originalCode) return;
    const pos = ctx.getPos();
    if (pos === undefined) return;
    const n = ctx.view.state.doc.nodeAt(pos);
    if (!n) return;
    ctx.view.dispatch(
        ctx.view.state.tr.replaceWith(
            pos + 1,
            pos + n.nodeSize - 1,
            newCode ? ctx.view.state.schema.text(newCode) : [],
        )
    );
}

/**
 * The gutter + highlighted `<pre>` + `<textarea>` stack both surfaces edit in.
 * Returns the element plus the handful of things a caller drives.
 */
function buildCodeEditor(opts: {
    lang: string;
    initialCode: string;
    isWordWrap: () => boolean;
}): {
    el: HTMLElement;
    textarea: HTMLTextAreaElement;
    /** Re-highlight, re-number, and resync the scroll layers. */
    refresh: () => void;
    destroy: () => void;
} {
    const { lang, initialCode, isWordWrap } = opts;

    const el = document.createElement("div");
    el.className = "code-lightbox-body";

    const gutter = document.createElement("div");
    gutter.className = "code-lightbox-gutter";
    gutter.setAttribute("aria-hidden", "true");

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
    textarea.value = initialCode;
    codeClone.innerHTML = highlight(initialCode, lang);

    codeArea.append(pre, textarea);
    el.append(gutter, codeArea);

    const updateGutter = (): void => {
        updateLineNumbers(gutter, textarea.value, getVisualLineCounts(textarea, textarea.value, isWordWrap()));
    };
    const syncScroll = (): void => {
        pre.scrollTop = textarea.scrollTop;
        pre.scrollLeft = textarea.scrollLeft;
        gutter.scrollTop = textarea.scrollTop;
    };
    const refresh = (): void => {
        codeClone.innerHTML = highlight(textarea.value, lang);
        updateGutter();
        syncScroll();
    };
    updateGutter();
    textarea.addEventListener("scroll", syncScroll);

    const gutterResizeObserver = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateGutter)
        : null;
    gutterResizeObserver?.observe(textarea);

    return {
        el,
        textarea,
        refresh,
        destroy() { gutterResizeObserver?.disconnect(); },
    };
}

// ── Code fullscreen (editable + syntax highlighting) ─────────────────────────
export function openCodeLightbox(ctx: LightboxContext & {
    /** The block's current language token, read once at open time. */
    getLang: () => string;
}): void {
    const { host, codeEl, isWordWrap } = ctx;
    if (host.active) return;
    const lang = ctx.getLang();
    const originalCode = codeEl.textContent ?? "";

    const editor = buildCodeEditor({ lang, initialCode: originalCode, isWordWrap });
    let detachTextareaUndo = (): void => {};

    const surface = openFullscreenSurface({
        ground: "sheet",
        title: getLangLabel(lang),
        // `code-editor-lightbox` styles nothing; it NAMES this surface, which
        // the ground cannot — a diagram flipped to its code pane is a sheet
        // too. It is how a caller (and codeBlockLightbox.test.ts) tells the two
        // apart.
        className: `code-editor-lightbox ${isWordWrap() ? "code-lightbox-word-wrap" : "code-lightbox-no-word-wrap"}`,
        onClose() {
            writeBackCode(ctx, editor.textarea.value, originalCode);
            editor.destroy();
            detachTextareaUndo();
            host.active = null;
        },
    });
    surface.content.appendChild(editor.el);
    host.active = surface.overlay;
    host.dismissCleanup = hostCleanupFor(surface);

    const copyBtn = fsButton(IconCopy, t("Copy Code"));
    copyBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        navigator.clipboard?.writeText(editor.textarea.value).catch(() => {});
        copyBtn.innerHTML = IconCheck;
        setTimeout(() => { copyBtn.innerHTML = IconCopy; }, 1500);
    });
    surface.addActions(copyBtn);

    // Local undo/redo: VS Code's Electron layer swallows Cmd/Ctrl+Z before the
    // native textarea sees it.
    detachTextareaUndo = attachInputUndo(editor.textarea);
    editor.textarea.addEventListener("input", editor.refresh);
    editor.textarea.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
            e.preventDefault();
            const s = editor.textarea.selectionStart;
            const end = editor.textarea.selectionEnd;
            editor.textarea.value =
                editor.textarea.value.slice(0, s) + "    " + editor.textarea.value.slice(end);
            editor.textarea.selectionStart = editor.textarea.selectionEnd = s + 4;
            // Synthetic input event: refreshes the highlight layer AND records
            // the insertion in the local undo history.
            editor.textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });

    requestAnimationFrame(() => {
        editor.textarea.focus();
        editor.refresh();
    });
}

// ── Diagram fullscreen (engine-agnostic: Mermaid or PlantUML) ─────────────────
export function openDiagramLightbox(ctx: LightboxContext & {
    /** Whether the inline pane has a painted diagram to clone. */
    hasSvg: () => boolean;
    /** The inline pane's painted SVG markup. */
    svgHtml: () => string;
    /** The block's language token, for the header label and the code pane. */
    getLang: () => string;
    /**
     * The engine the INLINE pane rendered with. Everything engine-specific in
     * here reads it — the re-render after an edit, the error card's classes,
     * and the canvas colour. Hardcoding Mermaid meant a fullscreened PlantUML
     * diagram was titled "Mermaid", highlighted as Mermaid, drawn on Mermaid's
     * canvas, and fed to Mermaid's parser the moment the user edited it.
     */
    renderer: DiagramRenderer;
}): void {
    const { host, codeEl, isWordWrap, renderer } = ctx;
    if (host.active) return;
    if (!ctx.hasSvg()) return;
    const lang = ctx.getLang();
    const px = renderer.classPrefix;
    const originalCode = codeEl.textContent ?? "";

    let panX = 0, panY = 0, zoom = 1.0;
    let isCodeMode = false;

    const editor = buildCodeEditor({ lang, initialCode: originalCode, isWordWrap });
    let detachSurface = (): void => {};

    const surface: FullscreenSurface = openFullscreenSurface({
        ground: "canvas",
        title: getLangLabel(lang),
        className: `diagram-lightbox ${isWordWrap() ? "code-lightbox-word-wrap" : "code-lightbox-no-word-wrap"}`,
        onClose() {
            writeBackCode(ctx, editor.textarea.value, originalCode);
            editor.destroy();
            detachSurface();
            host.active = null;
        },
    });
    host.active = surface.overlay;
    host.dismissCleanup = hostCleanupFor(surface);

    // The canvas ground IS the diagram's paper, so it has to track the engine's
    // own light/dark decision the same way the inline pane's does.
    surface.overlay.classList.toggle("diagram-canvas-dark", renderer.isDark());
    surface.setCanvasColor("var(--mermaid-canvas)");

    // ── Panes ──
    const previewPane = document.createElement("div");
    previewPane.className = "lb-diagram-preview-pane";

    const svgHolder = document.createElement("div");
    svgHolder.className = "lb-diagram-svg";
    svgHolder.innerHTML = ctx.svgHtml();
    const initialSvg = svgHolder.querySelector("svg");
    if (initialSvg) initialSvg.style.display = "block";
    previewPane.appendChild(svgHolder);

    editor.el.classList.add("lb-diagram-code-pane");
    surface.content.append(previewPane, editor.el);

    // ── Transform ──
    function applyTransform(): void {
        svgHolder.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    }

    function fitToView(): void {
        const svgEl = svgHolder.querySelector("svg");
        if (!svgEl) return;
        const boxW = previewPane.clientWidth, boxH = previewPane.clientHeight;
        const natW = parseFloat(svgEl.getAttribute("width") ?? "0");
        const natH = parseFloat(svgEl.getAttribute("height") ?? "0");
        if (!natW || !natH || !boxW || !boxH) return;
        panX = 0; panY = 0;
        zoom = Math.max(
            ZOOM_MIN,
            Math.min((boxW - 80) / natW, (boxH - 80) / natH, FULLSCREEN_MAX_FIT),
        );
        applyTransform();
    }

    // ── Top-right cluster: zoom, then the mode toggle, then Close ──
    const zoomOutBtn = fsButton(IconZoomOut, t("Zoom Out"));
    const zoomValue = createButton({
        className: "ui-btn fs-btn fs-btn--value",
        tabIndex: -1,
        title: t("Reset Zoom"),
        tooltipPlacement: "below",
    });
    zoomValue.textContent = "100%";
    const zoomInBtn = fsButton(IconZoomIn, t("Zoom In"));
    const modeBtn = fsButton(IconCode, t("Edit Code"));
    const modeTip = applyTooltip(modeBtn, t("Edit Code"), { placement: "below" });

    surface.addActions(zoomOutBtn, zoomValue, zoomInBtn);
    surface.addActionSeparator();
    surface.addActions(modeBtn);

    // ── Bottom-right: the same pan pad the inline pane carries ──
    const panPad = createPanPad({
        classPrefix: px,
        onPan: (dx, dy) => { panX += dx; panY += dy; applyTransform(); },
        onReset: fitToView,
    });
    surface.nav.appendChild(panPad);

    requestAnimationFrame(fitToView);

    // ── Rendering inside the lightbox (whichever engine opened it) ───────────
    async function renderDiagram(code: string): Promise<void> {
        svgHolder.innerHTML = `<div class="${px}-loading">${t("Rendering...")}</div>`;
        try {
            const { svg, width, height } = await renderer.render(code, previewPane.clientWidth || 800);
            surface.overlay.classList.toggle("diagram-canvas-dark", renderer.isDark());
            svgHolder.innerHTML = svg;
            const svgEl = svgHolder.querySelector("svg");
            if (svgEl) {
                svgEl.setAttribute("width", String(width));
                svgEl.setAttribute("height", String(height));
                svgEl.style.display = "block";
            }
            requestAnimationFrame(fitToView);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            svgHolder.innerHTML =
                `<div class="${px}-error"><span>${IconAlertCircle}</span><pre class="${px}-error-msg">${escapeHtml(msg)}</pre></div>`;
        }
    }

    // ── Toggle code / preview ──
    function toCodeMode(): void {
        isCodeMode = true;
        // A sheet, not a canvas: the chrome band is reserved so the source
        // never runs under the action cluster.
        surface.setGround("sheet");
        surface.overlay.classList.add("diagram-lightbox--code");
        [zoomOutBtn, zoomValue, zoomInBtn].forEach((b) => (b.style.display = "none"));
        surface.nav.style.display = "none";
        modeBtn.innerHTML = IconEye;
        modeTip.setText(t("Preview Diagram"));
        hideTooltip();
        requestAnimationFrame(() => editor.textarea.focus());
    }

    function toPreviewMode(): void {
        isCodeMode = false;
        surface.setGround("canvas");
        surface.overlay.classList.remove("diagram-lightbox--code");
        [zoomOutBtn, zoomValue, zoomInBtn].forEach((b) => (b.style.display = ""));
        surface.nav.style.display = "";
        modeBtn.innerHTML = IconCode;
        modeTip.setText(t("Edit Code"));
        hideTooltip();
        if (editor.textarea.value !== originalCode) void renderDiagram(editor.textarea.value);
    }

    modeBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (isCodeMode) toPreviewMode(); else toCodeMode();
    });
    editor.textarea.addEventListener("input", editor.refresh);
    editor.textarea.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
            e.preventDefault();
            const s = editor.textarea.selectionStart, end = editor.textarea.selectionEnd;
            editor.textarea.value =
                editor.textarea.value.slice(0, s) + "    " + editor.textarea.value.slice(end);
            editor.textarea.selectionStart = editor.textarea.selectionEnd = s + 4;
            editor.refresh();
        }
    });

    // ── Preview-pane interaction (drag to pan + wheel to zoom) ──
    const onPaneMouseDown = (e: MouseEvent): void => {
        if (e.button !== 0 || (e.target as Element).closest("button")) return;
        e.preventDefault();
        const startX = e.clientX - panX, startY = e.clientY - panY;
        previewPane.classList.add("lb-diagram-preview-pane--panning");
        const onMove = (ev: MouseEvent): void => {
            panX = ev.clientX - startX; panY = ev.clientY - startY; applyTransform();
        };
        const onUp = (): void => {
            previewPane.classList.remove("lb-diagram-preview-pane--panning");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    };
    const onPaneWheel = (e: WheelEvent): void => {
        e.preventDefault();
        if (e.ctrlKey) {
            const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * Math.pow(0.98, e.deltaY)));
            const rect = previewPane.getBoundingClientRect();
            const mx = e.clientX - rect.left - rect.width / 2;
            const my = e.clientY - rect.top - rect.height / 2;
            const ratio = next / zoom;
            panX = mx + (panX - mx) * ratio;
            panY = my + (panY - my) * ratio;
            zoom = next;
        } else {
            panX -= e.deltaX;
            panY -= e.deltaY;
        }
        applyTransform();
    };
    previewPane.addEventListener("mousedown", onPaneMouseDown);
    previewPane.addEventListener("wheel", onPaneWheel, { passive: false });
    detachSurface = () => {
        previewPane.removeEventListener("mousedown", onPaneMouseDown);
        previewPane.removeEventListener("wheel", onPaneWheel);
    };

    zoomInBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        zoom = Math.min(ZOOM_MAX, zoom + ZOOM_BTN); applyTransform();
    });
    zoomOutBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        zoom = Math.max(ZOOM_MIN, zoom - ZOOM_BTN); applyTransform();
    });
    zoomValue.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        fitToView();
    });
}
