/**
 * components/codeBlock/latexPane.ts
 *
 * The ```latex / ```math preview: one block formula rendered by KaTeX.
 *
 * The smallest of the three preview panes, and deliberately shaped like the
 * other two (`el` + a gated `render`) so the NodeView treats all three the
 * same way and a fourth previewable language has an obvious template. KaTeX
 * itself arrives through the lazy loader in `utils/katexLoader.ts`, so a
 * document with no formula never pays for it.
 */
import { IconAlertCircle } from "@/ui/icons";
import { t } from "@/i18n";
import { renderKatexInto } from "@/utils/katexLoader";
import { escapeHtml } from "./escapeHtml";

export type LatexPane = {
    /** The pane element; the NodeView owns its placement and visibility. */
    el: HTMLElement;
    /** Typeset the formula. Unconditional — there is no render memo. */
    render: (code: string) => Promise<void>;
};

export function createLatexPane(opts: {
    /** True while this block is a latex block AND is showing its preview. */
    isActive: () => boolean;
}): LatexPane {
    const { isActive } = opts;

    const latexPreview = document.createElement("div");
    latexPreview.className = "latex-preview";
    latexPreview.contentEditable = "false";
    const latexRender = document.createElement("div");
    latexRender.className = "latex-render";
    latexPreview.appendChild(latexRender);

    async function renderLatex(code: string): Promise<void> {
        if (!isActive()) return;
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

    return { el: latexPreview, render: renderLatex };
}
