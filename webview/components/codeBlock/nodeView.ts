/**
 * components/codeBlock/nodeView.ts
 *
 * The code block's NodeView — the composition root that owns the wrapper DOM,
 * the chrome (language pill, fold ellipsis, control column), the editable
 * `<pre>`/`<code>` and its line gutter, and the code⇄preview state machine
 * that decides which pane is visible.
 *
 * The panes themselves are modules: `mermaidPane` (diagram + pan/zoom),
 * `calcLedger` (the ```calc worksheet), and the LaTeX preview, which is small
 * enough to stay here. Each pane owns its own render memo and exposes only
 * `el` / `render` / a way to forget the memo; this file owns *when* they run —
 * the per-kind debounce in `update()` — and never reaches inside them.
 *
 * Three languages are "previewable" (mermaid, latex, calc) and share one
 * toggle. The tricky transitions all live in `update()`: gaining or losing
 * previewability, and a previewable→previewable language flip whose visible
 * pane belongs to the OLD type (MAR-204).
 */
import type { Node as PMNode } from "@/pm";
import type {
    Decoration,
    DecorationSource,
    EditorView,
} from "@/pm";

type ViewMutationRecord = MutationRecord | { type: "selection"; target: Node };
import {
    IconCopy, IconCheck,
    IconCode, IconEye,
    IconMaximize2, IconWrapText,
    IconExpandHorizontal, IconShrinkHorizontal,
} from "@/ui/icons";
import {
    applyBlockWidthClass,
    codeWidthAnchor,
    getBlockWidth,
    getBlockWrap,
    renameBlockWidthAnchor,
    renameBlockWrapAnchor,
    setBlockWidth,
    setBlockWrap,
} from "@/blockWidth";
import { applyTooltip, hideTooltip } from "@/ui/tooltip";
import { t } from "@/i18n";
import { normalizeCodeLanguage } from "@/codeLanguages";
import { ensureGrammars } from "@/highlighter";
import { unlockBodyScroll } from "@/utils";
import { createFoldEllipsis } from "@/ui/foldEllipsis";
import { foldPluginKey, type FoldMeta } from "@/plugins/foldState";
import { createBlockControlsColumn } from "@/ui/blockControls";
import { createCalcLedger } from "./calcLedger";
import { createLangPicker } from "./langPicker";
import { createLatexPane } from "./latexPane";
import { getVisualLineCounts, updateLineNumbers } from "./lineNumbers";
import { openCodeLightbox, openDiagramLightbox, type LightboxHost } from "./lightbox";
import { createMermaidPane } from "./mermaidPane";

const shouldAutoConvertCodeBlock = (): boolean =>
    window.__i18n?.codeBlockAutoConvert ?? true;

/**
 * Fenced ```calc ledger gate (birta.calc.blocks.enabled). Independent of the
 * INLINE gate (birta.calc.enabled) on purpose: a worksheet the user typed into
 * a calc fence keeps computing even with calc silenced in prose. Off, a calc
 * fence is an ordinary code block — no evaluation runs at all.
 */
const calcBlocksEnabled = (): boolean =>
    window.__i18n?.calcBlocksEnabled ?? true;

const shouldWordWrapCodeBlock = (): boolean =>
    window.__i18n?.codeBlockWordWrap ?? false;

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
    stopEvent: (event: Event) => boolean;
    ignoreMutation: (m: ViewMutationRecord) => boolean;
    destroy: () => void;
} {
    // Ensure the syntax grammars are loaded for this (and every later) code
    // block. On the initial render of a document that already has code, editor.ts
    // has awaited this so it resolves immediately; for a code block added to a
    // previously code-free document this kicks off the lazy grammar chunk, and
    // prism re-highlights the block on the next edit inside it.
    void ensureGrammars();

    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";

    // The floating chrome row (language pill + fold ellipsis), in-canvas at
    // the wrapper's top-left — the mermaid-overlay pattern. It replaced the
    // full-width header bar (maintainer, 2026-07-28): the canvas reserves a
    // top band via the code/gutter/preview padding, so line 1 never slides
    // under the pill, and the action buttons live in the shared control
    // column OUTSIDE the top-right (createBlockControlsColumn below).
    const floatRow = document.createElement("div");
    floatRow.className = "code-float-row";
    floatRow.contentEditable = "false";

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
    let isCalc = normalizeCodeLanguage(currentLang) === "calc" && calcBlocksEnabled();
    // A block that shows a rendered preview instead of raw code — mermaid,
    // LaTeX, or calc. All reuse the same code/preview toggle and container.
    const isPreviewable = (): boolean => isMermaid || isLatex || isCalc;
    let isPreviewMode = false;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    // The NodeView's single lightbox slot; `destroy()` tears down whatever is
    // in it, because a view can die with its lightbox open.
    const lightbox: LightboxHost = { active: null, dismissCleanup: null };
    // The block's content anchor (blockWidth.ts) — shared by the width AND
    // word-wrap preferences, declared before either seeds from the store.
    let widthAnchor = codeWidthAnchor(node.textContent);
    // A remembered per-block override beats the global setting; absent means
    // follow birta.codeBlockWordWrap (and keep following it if it changes).
    let isWordWrap = getBlockWrap(widthAnchor) ?? shouldWordWrapCodeBlock();

    // ── Control-column buttons (the shared .bc-btn recipe; tooltips open
    // LEFT, over the block, like every control column) ────────────────
    // Code/preview toggle button (shown only for previewable languages)
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "bc-btn code-view-toggle-btn";
    toggleBtn.tabIndex = -1;
    toggleBtn.innerHTML = IconEye;
    toggleBtn.style.display = isPreviewable() ? "inline-flex" : "none";
    const previewTip = (): string =>
        isCalc ? t("Preview Calculations") : isLatex ? t("Preview Formula") : t("Preview Diagram");
    const toggleTooltip = applyTooltip(toggleBtn, previewTip(), { placement: "left" });

    // Word-wrap toggle for the current code block — a remembered per-block
    // override (state bag, never written to Markdown; blockWidth.ts).
    const wordWrapBtn = document.createElement("button");
    wordWrapBtn.className = "bc-btn code-wrap-toggle-btn";
    wordWrapBtn.tabIndex = -1;
    wordWrapBtn.innerHTML = IconWrapText;
    const wordWrapTooltip = applyTooltip(wordWrapBtn, t("Toggle Word Wrap"), { placement: "left" });

    // Per-block width toggle (blockWidth.ts): column width (default) ⇄ full
    // width — in a Fixed-width page the block breaks out of the column. A
    // presentation preference like word wrap, never written to the markdown;
    // both persist in the webview state bag on `widthAnchor` (declared with
    // the wrap seed above; re-anchored on edits in update()). Top-level
    // blocks only: a nested block's containing box isn't the content column,
    // so the toggle would be a dead control there.
    const widthBtn = document.createElement("button");
    widthBtn.className = "bc-btn code-width-toggle-btn";
    widthBtn.tabIndex = -1;
    const widthTooltip = applyTooltip(widthBtn, "", { placement: "left" });
    const syncWidthBtn = (): void => {
        const full = getBlockWidth(widthAnchor) === "full";
        applyBlockWidthClass(wrapper, full ? "full" : null);
        widthBtn.innerHTML = full ? IconShrinkHorizontal : IconExpandHorizontal;
        const label = full ? t("Fixed width") : t("Full width");
        widthBtn.setAttribute("aria-label", label);
        widthTooltip.setText(label);
        widthBtn.classList.toggle("bc-btn--on", full);
    };
    {
        const pos = getPos();
        const topLevel = pos !== undefined && view.state.doc.resolve(pos).depth === 0;
        widthBtn.style.display = topLevel ? "" : "none";
    }
    syncWidthBtn();
    widthBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBlockWidth(widthAnchor, getBlockWidth(widthAnchor) === "full" ? null : "full");
        syncWidthBtn();
        hideTooltip();
    });

    // Fullscreen button (always present)
    const fullscreenBtn = document.createElement("button");
    fullscreenBtn.className = "bc-btn code-block-fullscreen-btn";
    fullscreenBtn.tabIndex = -1;
    fullscreenBtn.innerHTML = IconMaximize2;
    applyTooltip(fullscreenBtn, t("View Fullscreen"), { placement: "left" });

    // Copy button
    const copyBtn = document.createElement("button");
    copyBtn.className = "bc-btn copy-btn";
    copyBtn.tabIndex = -1;
    copyBtn.innerHTML = IconCopy;
    const copyTooltip = applyTooltip(copyBtn, t("Copy Code"), { placement: "left" });
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
        wordWrapBtn.classList.toggle("bc-btn--on", isWordWrap);
        wordWrapTooltip.setText(isWordWrap ? t("Disable Word Wrap") : t("Enable Word Wrap"));
    }

    wordWrapBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        isWordWrap = !isWordWrap;
        // Remember the choice per block — cleared when it matches the global
        // setting again, so an un-overridden block keeps following it.
        setBlockWrap(widthAnchor, isWordWrap === shouldWordWrapCodeBlock() ? null : isWordWrap);
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

    // float row: [picker][…] — in-canvas, top-left
    floatRow.appendChild(picker.el);
    floatRow.appendChild(foldEllipsis.dom);

    // control column (outside top-right): [copy][toggle][wrap][width][fullscreen]
    const controlsCol = createBlockControlsColumn(wrapper);
    controlsCol.appendChild(copyBtn);
    controlsCol.appendChild(toggleBtn);
    controlsCol.appendChild(wordWrapBtn);
    controlsCol.appendChild(widthBtn);
    controlsCol.appendChild(fullscreenBtn);

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

    // ── The three preview panes ────────────────────────────
    // One per previewable language, all the same shape (`el` + a gated
    // `render`); `previewEl()` below picks the one the current language maps
    // to, and only that one is ever displayed.
    const mermaidPane = createMermaidPane({
        isActive: () => isMermaid && isPreviewMode,
    });
    const mermaidPreview = mermaidPane.el;

    const latexPane = createLatexPane({
        isActive: () => isLatex && isPreviewMode,
    });
    const latexPreview = latexPane.el;
    let latexRenderTimer: ReturnType<typeof setTimeout> | null = null;

    const calcLedger = createCalcLedger({
        view,
        isActive: () => isCalc && isPreviewMode,
    });
    const calcPreview = calcLedger.el;
    let calcRenderTimer: ReturnType<typeof setTimeout> | null = null;

    // The single element that is visible while in preview mode.
    const previewEl = (): HTMLElement =>
        isCalc ? calcPreview : isLatex ? latexPreview : mermaidPreview;

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

    wrapper.appendChild(floatRow);
    wrapper.appendChild(pre);
    wrapper.appendChild(mermaidPreview);
    wrapper.appendChild(latexPreview);
    wrapper.appendChild(calcPreview);
    wrapper.appendChild(resizeHandle);
    wrapper.appendChild(controlsCol);
    scheduleLineNumberRefresh();

    const lineNumberResizeObserver = typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => scheduleLineNumberRefresh())
        : null;
    lineNumberResizeObserver?.observe(codeEl);

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
        // Hide every pane before showing the current type's: a language flip
        // between previewable types (latex→mermaid) re-enters preview mode
        // with a DIFFERENT pane, and the old one must not linger (MAR-204).
        mermaidPreview.style.display = "none";
        latexPreview.style.display = "none";
        calcPreview.style.display = "none";
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
        if (isCalc) void calcLedger.render(code);
        else if (isLatex) void latexPane.render(code);
        else mermaidPane.render(code);
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
    // Auto-preview only a NON-EMPTY previewable block. A freshly inserted
    // (empty) ```calc / ```mermaid / ```math block must start in code mode, or
    // preview hides the editable source and the user can't type into what they
    // just inserted.
    if (isPreviewable() && shouldAutoConvertCodeBlock() && node.textContent.trim()) {
        enterPreviewMode();
        setTimeout(() => renderPreview(node.textContent), 0);
    }

    // ── Fullscreen button ──────────────────────────────────
    const lightboxCtx = {
        host: lightbox,
        view,
        getPos,
        codeEl,
        isWordWrap: () => isWordWrap,
    };
    fullscreenBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (isMermaid && isPreviewMode) {
            openDiagramLightbox({
                ...lightboxCtx,
                hasSvg: mermaidPane.hasSvg,
                svgHtml: mermaidPane.svgHtml,
            });
        } else {
            openCodeLightbox({
                ...lightboxCtx,
                getLang: () => (node.attrs["language"] as string) || "",
            });
        }
    });

    return {
        dom: wrapper,
        contentDOM: codeEl,

        update(updatedNode: PMNode): boolean {
            if (updatedNode.type !== node.type) return false;

            const newLang = (updatedNode.attrs["language"] as string) || "";
            const wasPreviewable = isPreviewable();
            const prevKind = isCalc ? "calc" : isLatex ? "latex" : isMermaid ? "mermaid" : "";
            isMermaid = newLang === "mermaid";
            isLatex = normalizeCodeLanguage(newLang) === "latex";
            isCalc = normalizeCodeLanguage(newLang) === "calc" && calcBlocksEnabled();
            const nowPreviewable = isPreviewable();
            const newKind = isCalc ? "calc" : isLatex ? "latex" : isMermaid ? "mermaid" : "";

            picker.update(newLang);
            const classLang = normalizeCodeLanguage(newLang);
            codeEl.className = classLang ? `language-${classLang}` : "";
            node = updatedNode;
            scheduleLineNumberRefresh();
            foldEllipsis.setCount(codeLineCount(updatedNode.textContent));

            // Carry the stored width and wrap preferences across a
            // first-line edit (codeWidthAnchor scans only to the first
            // newline — cheap).
            const newWidthAnchor = codeWidthAnchor(updatedNode.textContent);
            if (newWidthAnchor !== widthAnchor) {
                renameBlockWidthAnchor(widthAnchor, newWidthAnchor);
                renameBlockWrapAnchor(widthAnchor, newWidthAnchor);
                widthAnchor = newWidthAnchor;
                syncWidthBtn();
            }

            if (!wasPreviewable && nowPreviewable) {
                toggleBtn.style.display = "inline-flex";
                // Same empty-block guard as on mount: switching an empty block's
                // language to a previewable one keeps it editable rather than
                // flipping to an empty preview the user can't type into.
                if (shouldAutoConvertCodeBlock() && updatedNode.textContent.trim()) {
                    enterPreviewMode();
                    setTimeout(() => renderPreview(updatedNode.textContent), 0);
                }
            }
            if (wasPreviewable && !nowPreviewable) {
                toggleBtn.style.display = "none";
                exitPreviewMode();
                mermaidPane.resetMemo();
                calcLedger.reset();
            }
            if (wasPreviewable && nowPreviewable && newKind !== prevKind) {
                // Previewable→previewable language flip (latex→mermaid, …):
                // neither branch above fires, but the visible pane belongs to
                // the OLD type (MAR-204). The render memos need no reset —
                // renderPreview recomputes calc/latex unconditionally and the
                // mermaid memo self-validates on (code, theme).
                if (isPreviewMode) {
                    if (updatedNode.textContent.trim()) {
                        // Re-enter: hides the stale pane, shows the new type's.
                        enterPreviewMode();
                        setTimeout(() => renderPreview(updatedNode.textContent), 0);
                    } else {
                        // Same empty-block guard as the enter branch: an empty
                        // preview would hide the only editable surface.
                        exitPreviewMode();
                    }
                } else {
                    // In code mode only the toggle's tooltip is stale — it
                    // still names the old type's preview.
                    toggleTooltip.setText(previewTip());
                }
            }
            if (nowPreviewable && isPreviewMode) {
                const newCode = updatedNode.textContent;
                if (isCalc) {
                    // The living recompute: cheap and synchronous, lightly
                    // debounced so a fast burst of typing coalesces. Skipped
                    // when the text didn't change — update() also fires for
                    // decoration-only churn (selection, folds).
                    if (newCode !== calcLedger.lastRendered()) {
                        if (calcRenderTimer) clearTimeout(calcRenderTimer);
                        calcRenderTimer = setTimeout(() => void calcLedger.render(newCode), 150);
                    }
                } else if (isLatex) {
                    if (latexRenderTimer) clearTimeout(latexRenderTimer);
                    latexRenderTimer = setTimeout(() => latexPane.render(newCode), 300);
                } else if (newCode !== mermaidPane.lastCode()) {
                    if (renderTimer) clearTimeout(renderTimer);
                    renderTimer = setTimeout(() => mermaidPane.render(newCode), 600);
                }
            }
            return true;
        },

        stopEvent(event: Event): boolean {
            // Mouse events inside the calc ledger are the browser's business:
            // native text selection (click-drag, double-click word select)
            // must not compete with ProseMirror's own mouse handling, whose
            // double-click handler word-selects in the DOCUMENT and wipes the
            // ledger selection. The ledger holds no buttons (the header and
            // resize handle live outside calcPreview), and it is
            // contentEditable=false, so no editing event can originate here.
            return event.target instanceof Node && calcLedger.contains(event.target);
        },

        ignoreMutation(mutation: ViewMutationRecord): boolean {
            // A DOM selection inside the calc ledger must be IGNORED: the
            // ledger is non-content DOM, so if ProseMirror reacts it re-asserts
            // its own (editor) selection on every mousemove, wiping the user's
            // drag mid-gesture — the ledger becomes unselectable and its
            // values uncopyable. Everywhere else, selection mutations stay
            // ProseMirror's business.
            if (mutation.type === "selection") return calcLedger.contains(mutation.target);
            if (mutation.type === "attributes") return true; // update() modifies className, so ignore attribute mutations to prevent a reconcile infinite loop (B085)
            return (
                !codeEl.contains(mutation.target as Node) &&
                mutation.target !== codeEl
            );
        },

        destroy(): void {
            mermaidPane.destroy();
            picker.destroy();
            if (copyRestoreTimer) clearTimeout(copyRestoreTimer);
            if (renderTimer) clearTimeout(renderTimer);
            if (latexRenderTimer) clearTimeout(latexRenderTimer);
            if (calcRenderTimer) clearTimeout(calcRenderTimer);
            if (lineNumberRaf !== null) cancelAnimationFrame(lineNumberRaf);
            lineNumberResizeObserver?.disconnect();
            // A NodeView can die with its lightbox open (external sync /
            // revert replacing the node): drop the Escape-layer entry and
            // the document key listener too, or a dead layer entry would
            // silently swallow the next Escape.
            lightbox.dismissCleanup?.();
            lightbox.dismissCleanup = null;
            if (lightbox.active && document.body.contains(lightbox.active)) {
                unlockBodyScroll();
                document.body.removeChild(lightbox.active);
                lightbox.active = null;
            }
        },
    };
}
