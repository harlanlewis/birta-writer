/**
 * components/codeBlock/calcLedger.ts
 *
 * The ```calc preview pane (MAR-196): each source line painted beside its
 * computed value in a two-column ledger.
 *
 * It is read-only, non-content DOM sitting inside an editable NodeView, which
 * is what makes its selection handling delicate — the pane owns the `contains`
 * predicate the NodeView's `stopEvent`/`ignoreMutation` consult, and the
 * click-to-blur behavior that keeps a stale ProseMirror caret from editing the
 * document invisibly. Those three pieces belong together; splitting them is
 * how a ledger becomes unselectable.
 *
 * The gate itself (`birta.calc.blocks.enabled` plus the current language) lives
 * in the NodeView and reaches this module as `isActive`.
 */
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { ensureCalcUnits, evaluateCalcBlock } from "@/utils/calc";

export type CalcLedger = {
    /** The pane element; the NodeView owns its placement and visibility. */
    el: HTMLElement;
    /** Evaluate and repaint. Cheap and synchronous after the units chunk loads. */
    render: (code: string) => Promise<void>;
    /** What the ledger currently shows; null = never rendered. */
    lastRendered: () => string | null;
    /** Forget the memo, so the next render repaints unconditionally. */
    reset: () => void;
    /** Whether a DOM node lies inside the ledger (selection/event routing). */
    contains: (node: Node) => boolean;
};

export function createCalcLedger(opts: {
    view: EditorView;
    /** True while this block is a calc block AND is showing its preview. */
    isActive: () => boolean;
}): CalcLedger {
    const { view, isActive } = opts;

    const calcPreview = document.createElement("div");
    calcPreview.className = "calc-preview";
    calcPreview.contentEditable = "false";
    const calcRender = document.createElement("div");
    calcRender.className = "calc-render";
    calcPreview.appendChild(calcRender);
    calcPreview.addEventListener("click", () => {
        // stopEvent keeps ProseMirror's mouse handling out of the ledger —
        // which also means PM's caret stays wherever it was, invisibly. A
        // later Enter/keymap stroke would edit the document at that stale
        // caret with no visual feedback. Clicking read-only chrome should
        // leave the editor inert until the user clicks back into content, so
        // drop editor focus; clicking any content refocuses through PM's own
        // mousedown. On `click` (not mousedown) so it runs AFTER the
        // browser's own focus settling, which would otherwise hand focus
        // straight back — and because blurring the host collapses the DOM
        // selection, a ledger selection (a drag that just ended here) is
        // captured first and re-asserted after: inert editor, intact copy.
        if (!view.hasFocus()) { return; }
        const sel = window.getSelection();
        const ledgerRanges =
            sel && !sel.isCollapsed && calcPreview.contains(sel.anchorNode)
                ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i).cloneRange())
                : [];
        view.dom.blur();
        if (sel && ledgerRanges.length > 0) {
            sel.removeAllRanges();
            for (const range of ledgerRanges) { sel.addRange(range); }
        }
    });

    // What the ledger currently shows; NodeView update() also fires for
    // decoration-only churn (block selection, folds), and re-evaluating an
    // unchanged block for those would be wasted work. Null = never rendered.
    let lastCalcRendered: string | null = null;

    /**
     * Paint each source line beside its computed value (a two-column ledger).
     * Synchronous, deterministic, and network-free — no lazy dependency, so it
     * is cheap enough to re-run on every edit (the "living" recompute). The
     * source is never mutated; results live only here, so the block round-trips
     * as ordinary Markdown.
     *
     * The `= ` before a value is REAL text (not a ::before pseudo-element), so
     * a copied selection reads `source` / `= value` line by line — and it is
     * omitted when the source line already ends in `=` or `=>`, which would
     * otherwise read doubled (`3 km in mi =>  = 1.86`).
     */
    async function renderCalc(code: string): Promise<void> {
        if (!isActive()) { return; }
        lastCalcRendered = code;
        // Unit conversions live in a lazy chunk (calcUnits.ts); load it before
        // evaluating so `3 km in mi` has a value on first paint. A failed load
        // degrades to arithmetic-only. If a newer render was scheduled while
        // the chunk loaded, this one is stale — bail.
        try { await ensureCalcUnits(); } catch { /* conversions yield no value */ }
        if (lastCalcRendered !== code || !isActive()) { return; }
        const rows = evaluateCalcBlock(code);
        calcRender.replaceChildren();
        for (const { raw, result, kind, value } of rows) {
            const row = document.createElement("div");
            row.className = "calc-row";
            const src = document.createElement("span");
            src.className = "calc-row-src";
            src.textContent = raw || " "; // keep blank lines visible/tall (NBSP)
            row.appendChild(src);
            if (result !== null) {
                const res = document.createElement("span");
                res.className = "calc-row-result";
                if (!/=>?\s*$/.test(raw)) {
                    const eq = document.createElement("span");
                    eq.className = "calc-row-eq";
                    eq.textContent = "= ";
                    res.appendChild(eq);
                }
                res.appendChild(document.createTextNode(result));
                // Rounded display (12 sig digits, ≤6 decimals): offer the
                // full-precision value on hover so the rounding is
                // inspectable — `x = 0.9999999` showing `1` can be checked.
                if (value !== undefined && String(value) !== result) {
                    res.title = `= ${String(value)}`;
                }
                row.appendChild(res);
            } else if (kind === "error") {
                // A line that READS as a formula but has no honest value (an
                // unknown variable, a dimension mismatch, division by zero).
                // Advisory and quiet — a dimmed dash, no color, no text — but
                // present: in a block whose point is computing, a silent
                // absence needs a signal (docs/DESIGN_PRINCIPLES.md).
                const res = document.createElement("span");
                res.className = "calc-row-result calc-row-result--error";
                res.textContent = "—";
                res.title = t("This line looks like a formula but has no value");
                row.appendChild(res);
            }
            calcRender.appendChild(row);
        }
    }

    return {
        el: calcPreview,
        render: renderCalc,
        lastRendered: () => lastCalcRendered,
        reset() { lastCalcRendered = null; },
        contains: (node: Node) => calcPreview.contains(node),
    };
}
