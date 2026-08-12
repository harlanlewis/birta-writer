/**
 * webview/format/markdown/index.ts — the markdown FormatModule (MAR-41).
 *
 * Assembles the markdown format from the modules that already implement it —
 * presets and stringify config from webview/serialization.ts (the presets
 * carry the serializer's whole-document post-pass, the org-cookie unescape,
 * baked into `pureCommonmark` — see format/types.ts), NodeViews from
 * webview/components/*, and the minimal-diff profile from
 * webview/utils/minimalDiff.ts. Nothing is reimplemented here: this file is
 * the wiring that lets editor.ts consume "the format" as one injected object
 * (see format/types.ts for the seam's charter).
 */
import { createCalloutView, createNotionCalloutView } from "../../components/callout";
import { createCodeBlockView } from "../../components/codeBlock";
import { createDirectiveView } from "../../components/directive";
import {
    createFootnoteDefinitionView,
    createFootnoteReferenceView,
} from "../../components/footnote";
import { createHtmlView } from "../../components/htmlView";
import { createImageView } from "../../components/imageView";
import { createMathInlineView } from "../../components/math";
import { createTableView } from "../../components/table/tableView";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../../serialization";
import { markdownProfile } from "../../utils/minimalDiff";
import type { FormatModule } from "../types";

// The HTML NodeView (rendered preview, comment chips, source-panel editing)
// lives in components/htmlView (MAR-14); re-exported here because editor.ts
// republishes it as part of the format surface.
export { createHtmlView };

/** The markdown format: presets, serializer config, NodeViews, and
 * minimal-diff profile. */
export const markdownFormat: FormatModule = {
    // Order matters: gfmFidelity's overrides must register after
    // pureCommonmark, exactly as `.use(gfm)` always followed the base preset
    // (see the gfmFidelity charter in serialization.ts).
    presets: [pureCommonmark, gfmFidelity],
    configureSerialization,
    nodeViews: [
        ["code_block", createCodeBlockView],
        ["callout", createCalloutView],
        ["notion_callout", createNotionCalloutView],
        ["container_directive", createDirectiveView],
        ["footnote_reference", createFootnoteReferenceView],
        ["footnote_definition", createFootnoteDefinitionView],
        ["math_inline", createMathInlineView],
        ["table", createTableView],
        ["html", (node, view, getPos) => createHtmlView(node, view, getPos)],
        [
            "image",
            (node, view, getPos) => createImageView(node, view, getPos),
        ],
    ],
    formatProfile: markdownProfile,
};
