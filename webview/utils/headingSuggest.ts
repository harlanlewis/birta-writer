/**
 * webview/utils/headingSuggest.ts
 *
 * The ONE heading-suggestion source behind every "link to a heading" surface:
 * the `#` caret autocomplete (plugins/headingLinkComplete.ts), the
 * section-link picker (components/sectionLink), and the link popup's
 * URL-field anchor suggestions (components/pathLink/linkTargetComplete.ts).
 * Each surface shapes its own row display, but the enumeration and the
 * type-to-filter ranking live here so the surfaces can never disagree about
 * which headings are addressable or how a query matches them.
 *
 * Enumeration is the model-sourced collectDocHeadings + slugifyHeadings pair
 * — the SAME pair linkPopup's resolveAnchorHeading resolves `#slug` clicks
 * with, so a produced anchor always resolves, including `-N` suffixes for
 * repeated titles. Pure functions, no DOM.
 */
import type { Node as PmNode } from "../pm";
import { collectDocHeadings } from "./headingUtils";
import { slugifyHeadings } from "./slug";

/** One addressable heading, as every suggestion surface consumes it. */
export interface HeadingSuggestion {
    /** The heading's own text (display / default link text). */
    title: string;
    /** The addressable slug, without the leading `#`. */
    slug: string;
    /** Heading level 1–6 (outline indentation). */
    level: number;
}

/**
 * Every addressable heading in the document, in document order. A heading
 * whose title slugifies to "" (an emoji/atom-only title) is UNADDRESSABLE —
 * its href would be a bare `#` that resolves nowhere — so it is dropped here,
 * once, for every consumer.
 */
export function collectHeadingSuggestions(doc: PmNode): HeadingSuggestion[] {
    const headings = collectDocHeadings(doc);
    const slugs = slugifyHeadings(headings.map((h) => h.text));
    return headings
        .map((h, i) => ({ title: h.text, slug: slugs[i], level: h.level }))
        .filter((h) => h.slug !== "");
}

/**
 * The type-to-filter ranking, the slash menu's tiers: title-prefix matches
 * first, then slug-prefix, then substring (title or slug), each tier in
 * document order. Case-insensitive. An empty query returns everything in
 * document order — the browse state.
 */
export function filterHeadingSuggestions(
    all: readonly HeadingSuggestion[],
    query: string,
): HeadingSuggestion[] {
    const q = query.trim().toLowerCase();
    if (!q) { return [...all]; }
    const titlePrefix: HeadingSuggestion[] = [];
    const slugPrefix: HeadingSuggestion[] = [];
    const substring: HeadingSuggestion[] = [];
    for (const h of all) {
        const title = h.title.toLowerCase();
        const slug = h.slug.toLowerCase();
        if (title.startsWith(q)) {
            titlePrefix.push(h);
        } else if (slug.startsWith(q)) {
            slugPrefix.push(h);
        } else if (title.includes(q) || slug.includes(q)) {
            substring.push(h);
        }
    }
    return [...titlePrefix, ...slugPrefix, ...substring];
}

/**
 * Outline-shaped display rows: level indentation (nbsp so the leading space
 * survives rendering) plus a "(2)", "(3)", … suffix when two headings share a
 * title AND a level. The suffix keeps the display→pick mapping injective —
 * the suggest widget reports a pick by its display TEXT — while the href
 * still comes from the slug's own `-N` disambiguation.
 */
export function outlineDisplayRows(
    list: readonly HeadingSuggestion[],
): Array<{ display: string; pick: HeadingSuggestion }> {
    const used = new Set<string>();
    return list.map((h) => {
        const indent = "  ".repeat(Math.max(0, h.level - 1));
        const base = indent + h.title;
        let display = base;
        if (used.has(base)) {
            let n = 2;
            while (used.has(`${base} (${n})`)) { n++; }
            display = `${base} (${n})`;
        }
        used.add(display);
        return { display, pick: h };
    });
}
