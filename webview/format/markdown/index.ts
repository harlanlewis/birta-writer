/**
 * webview/format/markdown/index.ts — the markdown FormatModule (MAR-41).
 *
 * Assembles the markdown format from the modules that already implement it —
 * presets and stringify config from webview/serialization.ts, NodeViews from
 * webview/components/*, the minimal-diff profile and org-cookie post-pass
 * from webview/utils/minimalDiff.ts, and the UI item registries from their
 * component homes. Nothing is reimplemented here: this file is the wiring
 * that lets editor.ts consume "the format" as one injected object (see
 * format/types.ts for the seam's charter).
 */
import DOMPurify from "dompurify";
import { createCalloutView, createNotionCalloutView } from "../../components/callout";
import { createCodeBlockView } from "../../components/codeBlock";
import { createDirectiveView } from "../../components/directive";
import {
    createFootnoteDefinitionView,
    createFootnoteReferenceView,
} from "../../components/footnote";
import { createImageView } from "../../components/imageView";
import { createMathInlineView } from "../../components/math";
import { createTableView } from "../../components/table/tableView";
import { SLASH_MENU_ITEMS } from "../../components/slashMenu/registry";
import { TOOLBAR_ITEM_IDS } from "../../components/toolbar/registry";
import { FLOATING_TOOLBAR_ITEM_IDS } from "../../components/selectionToolbar/registry";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../../serialization";
import { markdownProfile, unescapeOrgCookies } from "../../utils/minimalDiff";
import type { FormatModule } from "../types";

// ── HTML inline NodeView ───────────────────────────────────────────────────
// Milkdown's html node (atom, inline) displays the raw tag as textContent by
// default. This NodeView renders real HTML after DOMPurify sanitization for a
// read-only preview. HTML comments would be sanitized away entirely — making
// them invisible and impossible to reason about in the editor — so they are
// rendered as a dimmed chip showing the raw comment text instead.
export function createHtmlView(node: { attrs: Record<string, string> }) {
    const dom = document.createElement("span");
    dom.dataset["type"] = "html";
    const raw = node.attrs["value"] ?? "";
    if (/^<!--[\s\S]*?-->$/.test(raw.trim())) {
        dom.className = "html-inline html-comment";
        dom.textContent = raw.trim();
        dom.title = "HTML comment — preserved in the file, hidden in rendered output";
    } else {
        dom.className = "html-inline";
        dom.innerHTML = DOMPurify.sanitize(raw, {
            USE_PROFILES: { html: true },
            ADD_ATTR: ["align", "width", "height"],
        });
    }
    return {
        dom,
        ignoreMutation: () => true,
        stopEvent: () => false,
    };
}

/** The markdown format: presets, serializer config, NodeViews, UI
 * registries, minimal-diff profile, and serializer post-pass. */
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
        ["html", (node: { attrs: Record<string, string> }) => createHtmlView(node)],
        [
            "image",
            (node, view, getPos) => createImageView(node, view, getPos),
        ],
    ],
    slashItems: SLASH_MENU_ITEMS,
    toolbarItems: TOOLBAR_ITEM_IDS,
    selectionToolbarItems: FLOATING_TOOLBAR_ITEM_IDS,
    formatProfile: markdownProfile,
    // Also baked into pureCommonmark's serializer plugin (serialization.ts),
    // so every construction site applies it by construction; declared here as
    // the format's canonical statement of its post-pass.
    postSerialize: unescapeOrgCookies,
};
