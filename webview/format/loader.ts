/**
 * webview/format/loader.ts — per-document FormatModule resolution (MAR-42).
 *
 * Markdown is the eager format (it IS the launch bundle's editor); every
 * other format loads lazily via a cached dynamic `import()`, the
 * katexLoader/mermaidLoader pattern, keyed on the document actually being
 * that format. A markdown document must never pay a byte or a tick for mdx —
 * this seam is where that constraint lives, so no other module may static-
 * import `./mdx`.
 */
import type { DocumentFormat } from "../../shared/messages";
import { markdownFormat } from "./markdown";
import type { FormatModule } from "./types";

let mdxPromise: Promise<FormatModule> | null = null;

/** Resolve the FormatModule for a document's wire format. */
export function resolveFormat(format: DocumentFormat): Promise<FormatModule> {
    if (format === "mdx") {
        if (!mdxPromise) {
            mdxPromise = import("./mdx").then((m) => m.mdxFormat);
        }
        return mdxPromise;
    }
    return Promise.resolve(markdownFormat);
}
