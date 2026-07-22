/**
 * webview/links/scan.ts — the pure Links scanner.
 *
 * Walks a ProseMirror document and surfaces every link as a flat,
 * document-ordered list the review sidebar's Links tab renders and navigates. It
 * writes nothing: detection only. Three link shapes exist in the doc:
 *
 *   - a `link` mark on text — inline links and autolinks (attrs.href);
 *   - a `link_ref` mark — reference links `[text][ref]`, resolved to their URL
 *     via the matching `[ref]: url` definition;
 *   - a `wiki_link` atom node — `[[target|alias]]` (parsed from its raw bytes).
 *
 * Contiguous text carrying the same link runs (a `[**bold** tail](url)` is one
 * link, two text nodes) are merged into a single item. Links are grouped in the
 * sidebar by DESTINATION kind — where the link points — not by which syntax
 * wrote it, so a reference link sits with the web/local links it resolves to.
 */
import type { Node as ProseNode } from "../pm";
import { parseWikiRaw, wikiDisplayText, wikiLinkId } from "../plugins/wikiLinks";

export type LinkKind = "web" | "email" | "local" | "anchor" | "wikilink";

export interface LinkItem {
    from: number;
    to: number;
    kind: LinkKind;
    /** The link's display text (what the reader sees). */
    text: string;
    /** The link's target — the tooltip, and how "web/local/anchor" is decided. */
    href: string;
}

/** Classify a resolved href by where it points. */
function kindOf(href: string): LinkKind {
    if (/^mailto:/i.test(href)) { return "email"; }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) { return "web"; }
    if (href.startsWith("#")) { return "anchor"; }
    return "local";
}

interface Run { from: number; to: number; href: string; text: string; kind: LinkKind }

export function scanLinks(doc: ProseNode): LinkItem[] {
    // Reference definitions: identifier → url, so a `[text][ref]` can show and
    // classify by its real destination.
    const defs = new Map<string, string>();
    doc.descendants((node) => {
        if (node.type.name === "link_definition") {
            defs.set(node.attrs["identifier"] ?? "", node.attrs["url"] ?? "");
        }
        return true;
    });

    const items: LinkItem[] = [];
    let run: Run | null = null;
    const flush = (): void => { if (run) { items.push({ from: run.from, to: run.to, kind: run.kind, text: run.text, href: run.href }); run = null; } };

    doc.descendants((node, pos) => {
        if (node.type.name === wikiLinkId) {
            flush();
            const raw = (node.attrs["raw"] ?? "") as string;
            const parts = parseWikiRaw(raw);
            const href = parts.target + (parts.heading ? `#${parts.heading}` : "");
            items.push({ from: pos, to: pos + node.nodeSize, kind: "wikilink", text: wikiDisplayText(raw), href });
            return false;
        }
        if (node.isText) {
            const from = pos;
            const to = pos + node.nodeSize;
            const linkMark = node.marks.find((m) => m.type.name === "link");
            const refMark = node.marks.find((m) => m.type.name === "link_ref");
            if (linkMark || refMark) {
                const href = linkMark
                    ? (linkMark.attrs["href"] ?? "")
                    : (defs.get(refMark!.attrs["identifier"] ?? "") ?? (refMark!.attrs["identifier"] ?? ""));
                if (run && run.href === href && run.to === from) {
                    run.to = to;
                    run.text += node.text ?? "";
                } else {
                    flush();
                    run = { from, to, href, text: node.text ?? "", kind: kindOf(href) };
                }
            } else {
                flush(); // a non-link run ends the link
            }
            return false;
        }
        // Any other node (a new block, an inline atom) breaks a link run.
        flush();
        return true;
    });
    flush();

    return items.sort((a, b) => a.from - b.from);
}
