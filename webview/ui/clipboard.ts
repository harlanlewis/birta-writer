/**
 * webview/ui/clipboard.ts
 *
 * The one plain-text clipboard write, shared by every chrome surface with a
 * "copy" verb (link popup, embed palette). The async Clipboard API is the
 * primary path; the hidden-textarea execCommand fallback covers contexts where
 * the webview denies it.
 */

/** Copy `text` to the clipboard; fall back to a hidden textarea + execCommand. */
export function copyTextToClipboard(text: string): void {
    navigator.clipboard?.writeText(text).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand("copy"); } catch { /* ignore */ }
        document.body.removeChild(ta);
    });
}
