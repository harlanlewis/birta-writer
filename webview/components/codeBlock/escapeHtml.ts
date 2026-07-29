/**
 * components/codeBlock/escapeHtml.ts
 *
 * The one HTML-escaper the code-block layer uses before writing
 * document-derived text into `innerHTML` — the language token from a fence's
 * info string, and the error text a failed Mermaid/KaTeX render hands back.
 * Both are document-controlled, so a crafted fence such as
 * ```<img/src=x/onerror=...> would execute without this.
 *
 * Deliberately NOT shared with `highlighter.ts`'s private escaper: that one
 * omits `"` because it only ever escapes text-node content, which would be
 * unsafe here (langLabelHtml interpolates into an attribute-bearing span).
 */
export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
