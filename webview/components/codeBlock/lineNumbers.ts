/**
 * components/codeBlock/lineNumbers.ts
 *
 * The line-number gutter's geometry. Shared by the inline NodeView gutter and
 * by both lightboxes' gutters, which number a `<textarea>` rather than a
 * ProseMirror `contentDOM` — hence the plain `HTMLElement` + text signature.
 *
 * Under word wrap a source line occupies several visual lines, so its number
 * cell has to be as tall as the wrapped run; `getVisualLineCounts` estimates
 * that from a canvas text measurement of the element's own font.
 */

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

export function getVisualLineCounts(target: HTMLElement, text: string, wordWrap: boolean): number[] | undefined {
    if (!wordWrap || target.clientWidth <= 0) {
        return undefined;
    }

    const columns = getWrapColumnCount(target);
    return text.split("\n").map((line) => {
        const expanded = line.replace(/\t/g, "    ");
        return Math.max(1, Math.ceil(expanded.length / columns));
    });
}

export function updateLineNumbers(gutter: HTMLElement, text: string, visualLineCounts?: number[]): void {
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
