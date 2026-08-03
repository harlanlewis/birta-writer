/**
 * components/codeBlock/lightbox.ts
 *
 * The two fullscreen surfaces a code block can open, and the host record they
 * share:
 *
 *   openCodeLightbox    — an editable, syntax-highlighted full-window editor
 *   openDiagramLightbox — the same editor beside a pan/zoomable Mermaid canvas
 *
 * They live together because they share more than a file: one `LightboxHost`
 * (only ever one open at a time, and the NodeView's `destroy()` has to be able
 * to tear down whichever it is), the same gutter+`<pre>`+`<textarea>` anatomy,
 * and the same write-back-on-close protocol — dismiss synchronously, diff the
 * textarea against the node's text, replace the node's content, then fade.
 *
 * The two editor panes are deliberately NOT merged into one helper: the code
 * lightbox attaches local undo and auto-focuses on the next frame, and its Tab
 * handler dispatches a synthetic `input` (so the insertion enters that undo
 * history) where the diagram lightbox calls its highlighter directly. Those
 * are behavior differences, not incidental drift.
 */
import type { EditorView } from "@/pm";
import { IconCheck, IconCode, IconCopy, IconEye, IconAlertCircle, IconX, IconZoomIn, IconZoomOut } from "@/ui/icons";
import { applyTooltip, hideTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { normalizeCodeLanguage } from "@/codeLanguages";
import { highlight } from "@/highlighter";
import { lockBodyScroll, unlockBodyScroll, animateCloseLightbox, bindLightboxDismiss } from "@/utils";
import { attachInputUndo } from "@/utils/inputUndo";
import { escapeHtml } from "./escapeHtml";
import { getLangLabel } from "./langPicker";
import { getVisualLineCounts, updateLineNumbers } from "./lineNumbers";
import { makeMermaidBtn, ZOOM_BTN, ZOOM_MAX, ZOOM_MIN } from "./mermaidPane";
import { renderMermaidToSvg } from "./mermaidRuntime";

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

// ── Code fullscreen (editable + syntax highlighting) ─────────────────────────
export function openCodeLightbox(ctx: LightboxContext & {
    /** The block's current language token, read once at open time. */
    getLang: () => string;
}): void {
    const { host, codeEl, isWordWrap } = ctx;
    if (host.active) return;
    const overlay = document.createElement("div");
    overlay.className = "mermaid-lightbox code-editor-lightbox";
    overlay.classList.toggle("code-lightbox-word-wrap", isWordWrap());
    overlay.classList.toggle("code-lightbox-no-word-wrap", !isWordWrap());

    const lbHeader = document.createElement("div");
    lbHeader.className = "mermaid-lightbox-header";
    lbHeader.contentEditable = "false";

    const lang = ctx.getLang();
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
    host.active = overlay;

    // ── Line-number update
    const updateGutter = (): void => {
        updateLineNumbers(
            gutter,
            textarea.value,
            getVisualLineCounts(textarea, textarea.value, isWordWrap()),
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
        if (!host.dismissCleanup) return; // close already ran (e.g. X during the fade)
        // Synchronous teardown of the Escape layer + document listener:
        // deferring it to animationend swallowed a second Escape during
        // the close fade (and re-ran this close). Only the DOM/animation
        // teardown stays deferred.
        host.dismissCleanup();
        host.dismissCleanup = null;
        writeBackCode(ctx, textarea.value, codeEl.textContent ?? "");
        unlockBodyScroll();
        gutterResizeObserver?.disconnect();
        detachTextareaUndo();
        animateCloseLightbox(overlay, () => {
            host.active = null;
        });
    }

    host.dismissCleanup = bindLightboxDismiss(overlay, lbCloseBtn, closeLb);
}

// ── Mermaid diagram fullscreen ─────────────────────────
export function openDiagramLightbox(ctx: LightboxContext & {
    /** Whether the inline pane has a painted diagram to clone. */
    hasSvg: () => boolean;
    /** The inline pane's painted SVG markup. */
    svgHtml: () => string;
}): void {
    const { host, codeEl, isWordWrap } = ctx;
    if (host.active) return;
    if (!ctx.hasSvg()) return;

    let lbPanX = 0, lbPanY = 0, lbZoom = 1.0;
    let lbIsCodeMode = false;
    const originalCode = codeEl.textContent ?? "";

    // ── Overlay ───────────────────────────────────────────
    const overlay = document.createElement("div");
    overlay.className = "mermaid-lightbox";
    overlay.classList.toggle("code-lightbox-word-wrap", isWordWrap());
    overlay.classList.toggle("code-lightbox-no-word-wrap", !isWordWrap());

    // ── Header ────────────────────────────────────────────
    const lbHeader = document.createElement("div");
    lbHeader.className = "mermaid-lightbox-header";
    lbHeader.contentEditable = "false";

    const lbTitle = document.createElement("span");
    lbTitle.className = "mermaid-lightbox-title";
    lbTitle.textContent = "Mermaid";

    const lbToggleBtn = document.createElement("button");
    lbToggleBtn.className = "ui-btn mermaid-zoom-btn";
    lbToggleBtn.tabIndex = -1;
    lbToggleBtn.innerHTML = IconCode;
    const lbToggleTip = applyTooltip(lbToggleBtn, t("Edit Code"), { placement: "above" });
    const lbZoomOutBtn  = makeMermaidBtn(IconZoomOut, t("Zoom Out"));
    const lbZoomResetBtn = document.createElement("button");
    lbZoomResetBtn.className = "ui-btn mermaid-zoom-btn";
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
    lbSvgContainer.innerHTML = ctx.svgHtml();
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
    // Take focus off the editor (MAR-267). This overlay covers the document
    // and — unlike the code lightbox, whose textarea focuses itself — nothing
    // in it is focusable while it shows the diagram, so the caret stayed live
    // BEHIND it and every keystroke edited a document the user couldn't see.
    // The overlay is the focus home for the rest of its life; Escape is
    // unaffected, since `bindLightboxDismiss` listens on the document.
    overlay.tabIndex = -1;
    overlay.focus();
    lockBodyScroll();
    host.active = overlay;

    // ── Line numbers ───────────────────────────────────────
    const updateGutter = (): void => {
        updateLineNumbers(
            gutter,
            textarea.value,
            getVisualLineCounts(textarea, textarea.value, isWordWrap()),
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
            // Cap at natural size, same as the inline fitToView.
            lbZoom = Math.max(ZOOM_MIN, Math.min((bW - 80) / sW, (bH - 80) / sH, 1.0));
            applyLbTransform();
        }
    }

    requestAnimationFrame(fitLbView);

    // ── Mermaid rendering inside the lightbox ────────────────────────
    async function renderLbMermaid(code: string): Promise<void> {
        lbSvgContainer.innerHTML = `<div class="mermaid-loading">${t("Rendering...")}</div>`;
        try {
            const { svg, width, height } =
                await renderMermaidToSvg(code, lbPreviewPane.clientWidth || 800);
            lbSvgContainer.innerHTML = svg;
            const svgEl = lbSvgContainer.querySelector("svg");
            if (svgEl) {
                svgEl.setAttribute("width", String(width));
                svgEl.setAttribute("height", String(height));
                svgEl.style.display = "block";
            }
            requestAnimationFrame(fitLbView);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            lbSvgContainer.innerHTML = `<div class="mermaid-error"><span>${IconAlertCircle}</span><pre class="mermaid-error-msg">${escapeHtml(msg)}</pre></div>`;
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
        if (!host.dismissCleanup) return; // close already ran (e.g. X during the fade)
        // Synchronous teardown of the Escape layer + document listener
        // (see the code lightbox's closeLb): only DOM/animation teardown
        // stays deferred to animationend.
        host.dismissCleanup();
        host.dismissCleanup = null;
        writeBackCode(ctx, textarea.value, originalCode);
        unlockBodyScroll();
        gutterResizeObserver?.disconnect();
        animateCloseLightbox(overlay, () => {
            host.active = null;
        });
    }

    host.dismissCleanup = bindLightboxDismiss(overlay, lbCloseBtn, closeLb);
}
