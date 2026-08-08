/**
 * components/codeBlock/diagramPane.ts
 *
 * The INLINE diagram preview, shared by every diagram engine: the surface plus
 * everything that moves it — the zoom overlay, the pan pad, drag-to-pan,
 * pinch-to-zoom, fit-to-view, the adaptive container height, and the
 * single-flight render.
 *
 * These belong in one module because they are one state machine: pan/zoom, the
 * SVG's natural size, "has the user moved this by hand", and the (code, theme)
 * render memo all read and write each other. `hasManualTransform` in
 * particular is the reason a container resize refits an untouched diagram but
 * leaves a hand-panned one alone (MAR-205).
 *
 * Engine-specific concerns are injected as a `DiagramRenderer` (MAR-30): how to
 * turn source into measured SVG, which theme key the memo is keyed on, and how
 * to register for theme-change repaints. `mermaidPane.ts` and `plantUmlPane.ts`
 * are the two adapters, and each stays a few dozen lines because everything
 * below is genuinely shared. The NodeView owns whether a pane is visible at all
 * and supplies that as `isActive`.
 *
 * The `classPrefix` exists so each engine's DOM carries honest class names
 * (`.mermaid-preview`, `.puml-preview`) over one shared set of CSS rules, which
 * `codeBlock.css` authors as selector lists rather than duplicated blocks.
 */
import { IconAlertCircle, IconChevronDown, IconChevronUp, IconChevronLeft, IconChevronRight, IconResetZoom, IconZoomIn, IconZoomOut } from "@/ui/icons";
import { applyTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { createButton } from "@/ui/dom";
import { escapeHtml } from "./escapeHtml";

export const ZOOM_MIN = 0.05, ZOOM_MAX = 10.0, ZOOM_BTN = 0.25;
const PAN_STEP = 80;

/** One completed render: the markup plus the size to scale it against. */
export type DiagramRenderResult = {
    /** The SVG markup to place in the pane. */
    svg: string;
    /** The diagram's natural width in px (never the container's). */
    width: number;
    /** The diagram's natural height in px. */
    height: number;
    /**
     * The theme key this render actually used. Reported by the renderer rather
     * than re-read by the pane, because the live key may have moved on while
     * the render was in flight — the memo must record what was painted.
     */
    themeKey: string;
};

/** Everything about a diagram pane that varies by engine. */
export type DiagramRenderer = {
    /** DOM class prefix and modifier token, e.g. `mermaid` or `puml`. */
    classPrefix: string;
    /** Render source to measured SVG. `width` is the pane's current width. */
    render(code: string, width: number): Promise<DiagramRenderResult>;
    /** The engine's live theme key; half of the render memo. */
    themeKey(): string;
    /** Register for theme-change repaints. Returns its unregister fn. */
    register(instance: { invalidate: () => void }): () => void;
    /**
     * Whether this engine currently paints on the dark canvas. The lightbox
     * needs it because it lives on `<body>`, outside the pane whose class
     * carries the canvas colour — without it a dark PlantUML diagram (which
     * renders transparent, see plantUmlTheme.ts) landed on a white card.
     */
    isDark(): boolean;
};

export type DiagramPane = {
    /** The pane element; the NodeView owns its placement and visibility. */
    el: HTMLElement;
    /** Render (or repaint) the diagram. Single-flight, latest-wins. */
    render: (code: string) => void;
    /** The code the pane last settled on ("" = nothing yet). Failed renders
     *  memoize too — the error card is the settled outcome for that input. */
    lastCode: () => string;
    /** Forget the render memo (used when the block stops being a diagram). */
    resetMemo: () => void;
    /** Whether a diagram is currently painted (the lightbox's entry guard). */
    hasSvg: () => boolean;
    /** The painted SVG markup, for the fullscreen copy. */
    svgHtml: () => string;
    /**
     * The engine driving this pane. Published so the fullscreen lightbox
     * renders, themes and labels itself with the SAME engine the inline pane
     * used, rather than assuming Mermaid.
     */
    renderer: DiagramRenderer;
    destroy: () => void;
};

/** The zoom/overlay/lightbox-header button recipe (tooltips open above). */
export function makeDiagramBtn(icon: string, tipText: string, extraClass = ""): HTMLButtonElement {
    return createButton({
        className: "ui-btn mermaid-zoom-btn" + (extraClass ? ` ${extraClass}` : ""),
        icon,
        tabIndex: -1,
        title: tipText,
        tooltipPlacement: "above",
    });
}

export function createDiagramPane(opts: {
    /** True while this block is this engine's block AND is showing its preview. */
    isActive: () => boolean;
    /** The engine driving this pane. */
    renderer: DiagramRenderer;
}): DiagramPane {
    const { isActive, renderer } = opts;
    const px = renderer.classPrefix;

    // True once the user pans/zooms by hand; a container resize then leaves
    // their transform alone instead of snapping back to fit (MAR-205).
    let hasManualTransform = false;
    let panX = 0, panY = 0, zoomLevel = 1.0;
    let naturalSvgW = 0, naturalSvgH = 0; // SVG viewBox natural size (fixed)
    let lastRenderedCode = "";
    // The theme key the current SVG was rendered with — the memo is
    // (code, theme), so theme changes invalidate it naturally (MAR-203).
    let lastRenderedTheme = "";
    // True when the memoized (code, theme) render threw. Explicit state, not
    // a DOM probe: the error card's icon is itself an inline <svg>, and a
    // querySelector("svg") check once read a failed render as a painted
    // diagram, retried it on an all-cached microtask chain, and froze the
    // window on any document with one invalid diagram.
    let lastRenderFailed = false;
    let inFlightRender = false;
    // Latest-wins slot: code that arrived while a render was in flight, run
    // when that render settles instead of being dropped (MAR-203).
    let pendingCode: string | null = null;

    const preview = document.createElement("div");
    preview.className = `${px}-preview diagram-preview`;
    preview.contentEditable = "false";

    // SVG container (the transform is applied here)
    const svgContainer = document.createElement("div");
    svgContainer.className = `${px}-svg-container`;
    preview.appendChild(svgContainer);

    // ── Top-right zoom overlay: [-] [percentage] [+] ─────────────
    const zoomOverlay = document.createElement("div");
    zoomOverlay.className = `${px}-zoom-overlay`;
    zoomOverlay.contentEditable = "false";

    const overlayZoomOut = makeDiagramBtn(IconZoomOut, t("Zoom Out"), "mermaid-overlay-btn");
    const overlayZoomVal = document.createElement("button");
    overlayZoomVal.className = "ui-btn mermaid-zoom-btn mermaid-overlay-btn mermaid-overlay-val";
    overlayZoomVal.tabIndex = -1;
    overlayZoomVal.textContent = "100%";
    applyTooltip(overlayZoomVal, t("Reset Zoom"), { placement: "above" });
    const overlayZoomIn = makeDiagramBtn(IconZoomIn, t("Zoom In"), "mermaid-overlay-btn");

    // Element showing the current zoom percentage (center of the overlay)
    const zoomValueDisplay: HTMLButtonElement | null = overlayZoomVal;
    zoomOverlay.append(overlayZoomOut, overlayZoomVal, overlayZoomIn);
    preview.appendChild(zoomOverlay);

    // ── Bottom-right direction controls: ↑←[reset]→↓ ─────────────────────
    const panControls = document.createElement("div");
    panControls.className = `${px}-pan-controls`;
    panControls.contentEditable = "false";

    // Center reset button (fit-to-view)
    const panResetBtn = document.createElement("button");
    panResetBtn.className = "ui-btn mermaid-pan-btn mermaid-pan-reset";
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
    panGrid.className = `${px}-pan-grid`;
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
    preview.appendChild(panControls);

    function makePanBtn(icon: string, dir: string): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.className = "ui-btn mermaid-pan-btn";
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
            hasManualTransform = true;
            applyTransform();
        });
        return btn;
    }

    // Refit the diagram when the preview container's WIDTH changes (panel
    // resize): the adaptive height and fit zoom were computed for the old
    // width (MAR-205). Width-only guard — our own height writes retrigger
    // the observer, and reacting to them would loop. A hand pan/zoom is
    // respected: the transform only snaps back to fit while it IS the fit.
    let lastPreviewWidth = 0;
    const previewResizeObserver = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (!isActive() || !naturalSvgW) return;
            const w = preview.clientWidth;
            if (!w || w === lastPreviewWidth) return;
            lastPreviewWidth = w;
            applyAdaptiveHeight();
            if (!hasManualTransform) fitToView();
        })
        : null;
    previewResizeObserver?.observe(preview);

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
            const containerW = preview.clientWidth;
            const containerH = preview.clientHeight;
            if (!containerW || !containerH) return;

            if (!naturalSvgW || !naturalSvgH) return;

            const padding = 40;
            const scaleX = (containerW - padding) / naturalSvgW;
            const scaleY = (containerH - padding) / naturalSvgH;
            // Cap at natural size — small diagrams center at 100% instead of
            // being blown up to fill (matches the height estimator's cap).
            zoomLevel = Math.min(scaleX, scaleY, 1.0);
            zoomLevel = Math.max(ZOOM_MIN, zoomLevel);
            panX = 0; panY = 0;
            hasManualTransform = false;
            applyTransform();
        });
    }

    /**
     * Size the preview container from the diagram's fit-width height (capped
     * ≤1.0 so small diagrams aren't enlarged); tall diagrams expand up to
     * ~one viewport. Re-run on container resize with the stored natural size.
     */
    function applyAdaptiveHeight(): void {
        if (!naturalSvgW || !naturalSvgH) return;
        const availableW = preview.clientWidth || 800;
        const fitWidthScale = Math.min((availableW - 40) / naturalSvgW, 1.0);
        const idealH = naturalSvgH * fitWidthScale + 80; // 40px padding top and bottom
        const maxH = Math.min(window.innerHeight * 0.92, 2000);
        const finalH = Math.max(300, Math.min(Math.ceil(idealH), maxH));
        preview.style.height = finalH + "px";
        preview.style.minHeight = finalH + "px";
    }

    // ── Rendering ──────────────────────────────────────────
    // Single-flight, latest-wins: a call while a render is in flight parks
    // its code in pendingCode (checked in the finally) instead of being
    // dropped — the pending check runs BEFORE the memo guard so the newest
    // code always wins (MAR-203). Rendering + measurement happen inside the
    // renderer, never in the transformed svgContainer (MAR-202).
    async function renderDiagram(code: string): Promise<void> {
        if (!isActive()) return;
        if (inFlightRender) { pendingCode = code; return; }
        if (
            code === lastRenderedCode &&
            lastRenderedTheme === renderer.themeKey() &&
            (lastRenderFailed || svgContainer.querySelector("svg"))
        ) return;

        // Claim the render slot synchronously (before any await) so a second
        // call while the engine lazily loads can't start a concurrent render.
        inFlightRender = true;
        naturalSvgW = 0; naturalSvgH = 0;
        svgContainer.innerHTML = `<div class="${px}-loading">${t("Rendering...")}</div>`;
        const renderWidth = preview.clientWidth || 800;

        try {
            const { svg, width: nw, height: nh, themeKey } = await renderer.render(code, renderWidth);
            svgContainer.innerHTML = svg;
            const svgEl = svgContainer.querySelector("svg");
            if (svgEl) {
                svgEl.style.display = "block";
                naturalSvgW = nw;
                naturalSvgH = nh;
                // Write the natural size back to the SVG attributes so CSS scale is based on a fixed pixel size
                // (if the engine outputs width="100%", not writing it back makes CSS scale base on the container width, causing incorrect scaling)
                svgEl.setAttribute("width", String(nw));
                svgEl.setAttribute("height", String(nh));
                // Clear any max-width:100%;height:auto inline styles the engine may have added,
                // otherwise they override the width/height attributes written above and the SVG renders at the container width
                svgEl.style.maxWidth = "none";
                svgEl.style.height = "";
                applyAdaptiveHeight();
            }
            lastRenderedCode = code;
            // What THIS render used (not the live key — the theme may have
            // moved on mid-flight; the finally settles that).
            lastRenderedTheme = themeKey;
            lastRenderFailed = false;
            fitToView();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            svgContainer.innerHTML = `
                <div class="${px}-error">
                    <span>${IconAlertCircle}</span>
                    <pre class="${px}-error-msg">${escapeHtml(msg)}</pre>
                </div>`;
            // A failure memoizes like a success, so nothing retries it until
            // the code or effective theme changes (see lastRenderFailed).
            lastRenderedCode = code;
            lastRenderedTheme = renderer.themeKey();
            lastRenderFailed = true;
        } finally {
            inFlightRender = false;
            const next = pendingCode;
            pendingCode = null;
            // Re-run for parked code, or when the theme moved on while this
            // render was in flight — the (code, theme) memo guard settles
            // what actually needs repainting. Failed renders never re-enter
            // from here: same input, same failure.
            if (next !== null) void renderDiagram(next);
            else if (!lastRenderFailed && svgContainer.querySelector("svg") && lastRenderedTheme !== renderer.themeKey()) {
                void renderDiagram(code);
            }
        }
    }

    // Register the instance (used to re-render on theme change)
    const unregister = renderer.register({
        invalidate() {
            if (!isActive() || !lastRenderedCode) return;
            void renderDiagram(lastRenderedCode);
        },
    });

    // ── Drag to pan (mouse drag) ──────────────────────────
    preview.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || (e.target as Element).closest("button")) return;
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX - panX;
        const startY = e.clientY - panY;
        preview.classList.add(`${px}-preview--panning`);
        const onMove = (ev: MouseEvent) => {
            panX = ev.clientX - startX;
            panY = ev.clientY - startY;
            hasManualTransform = true;
            applyTransform();
        };
        const onUp = () => {
            preview.classList.remove(`${px}-preview--panning`);
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
        const rect = preview.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        const r = newZoom / zoomLevel;
        panX = mx + (panX - mx) * r;
        panY = my + (panY - my) * r;
        zoomLevel = newZoom;
        hasManualTransform = true;
        applyTransform();
    };
    preview.addEventListener("wheel", onPreviewWheel, { passive: false });

    // ── Overlay zoom buttons ──────────────────────────────
    overlayZoomOut.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        zoomLevel = Math.max(ZOOM_MIN, zoomLevel - ZOOM_BTN);
        hasManualTransform = true;
        applyTransform();
    });
    overlayZoomIn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        zoomLevel = Math.min(ZOOM_MAX, zoomLevel + ZOOM_BTN);
        hasManualTransform = true;
        applyTransform();
    });
    overlayZoomVal.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        fitToView();
    });

    return {
        el: preview,
        render: (code: string) => void renderDiagram(code),
        lastCode: () => lastRenderedCode,
        resetMemo() { lastRenderedCode = ""; lastRenderFailed = false; },
        // Not a bare DOM probe: the error card's icon is an <svg> too.
        hasSvg: () => !lastRenderFailed && svgContainer.querySelector("svg") !== null,
        svgHtml: () => svgContainer.innerHTML,
        renderer,
        destroy() {
            unregister();
            previewResizeObserver?.disconnect();
            preview.removeEventListener("wheel", onPreviewWheel);
        },
    };
}
