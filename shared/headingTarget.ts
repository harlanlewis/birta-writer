/**
 * Which line of a Markdown document a place-name means: a heading, by its
 * text or its anchor slug, or a line number.
 *
 * One answer for every host that opens a file somewhere other than its top.
 * VS Code asks it when a cross-file link carries a `#fragment`, and Birta
 * Writer for Mac's `bwr <file> --at <target>` asks a Swift port of it
 * (`mac/Sources/BirtaWriterCore/HeadingTarget.swift`), held to this file
 * through the golden file `shared/__tests__/fixtures/headingTargetGolden.json`.
 * A second resolver would be a second answer to "which heading is `#foo-1`",
 * and the page's own in-page anchors are the answer both have to agree with.
 *
 * Source text in, line out, and no parser: headings are found by
 * `scanHeadings` and slugged the way the page slugs its anchors
 * (`shared/slug.ts`, with the same duplicate suffixing), after the inline
 * constructs whose source differs from their rendering are reduced to what
 * renders. Lines are 1-based document lines, frontmatter included, which is
 * what every host's `scrollToLine` counts.
 */
import { scanHeadings } from "./headingScan";
import { slugify } from "./slug";

/** What a place-name asks for, before any document is read. */
export type AtTarget =
    | { kind: "line"; line: number }
    | { kind: "heading"; fragment: string };

/**
 * Read a place-name. `42` and `L42` (either case) are a line; anything else
 * names a heading, by text or slug. A heading's own source line names it
 * too (`## Install`, pasted from the file), so a run of one to six `#`
 * followed by a space or a tab is dropped with the space; otherwise one
 * leading `#` is dropped, so `#42` is how a heading whose text is a number
 * is reached. Null for a name that names nothing: empty, a bare `#`, or
 * line 0.
 */
export function parseAtTarget(word: string): AtTarget | null {
    const trimmed = word.trim();
    const line = /^[Ll]?(\d+)$/.exec(trimmed);
    if (line) {
        const n = Number(line[1]);
        return n >= 1 && Number.isSafeInteger(n) ? { kind: "line", line: n } : null;
    }
    const atx = /^#{1,6}[ \t]+/.exec(trimmed);
    const fragment = atx ? trimmed.slice(atx[0].length).trim()
        : trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    return fragment.trim() === "" ? null : { kind: "heading", fragment };
}

/**
 * A heading's raw source text reduced to what the page renders, so its slug
 * is the one the page's anchor carries: a link or an image keeps only its
 * text, and code drops its backticks.
 */
export function renderedHeadingText(raw: string): string {
    return raw
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/`([^`]*)`/g, "$1");
}

/**
 * The 1-based line of the heading `fragment` names, or undefined.
 *
 * The fragment may be a ready slug (`some-heading`, possibly
 * percent-encoded, `foo-1` for the second `Foo`) or the heading's text in any
 * case; both are compared with the document's headings as slugs, so a text
 * names the first heading that renders to it. A heading whose slug is empty
 * (all punctuation or emoji) has no anchor and cannot be named.
 */
export function findHeadingLine(text: string, fragment: string): number | undefined {
    let decoded = fragment;
    try {
        decoded = decodeURIComponent(fragment);
    } catch { /* keep raw */ }
    const wanted = new Set([decoded.toLowerCase(), slugify(decoded)]);
    const counts = new Map<string, number>();
    for (const h of scanHeadings(text)) {
        const base = slugify(renderedHeadingText(h.text));
        if (!base) continue;
        const count = counts.get(base) ?? 0;
        counts.set(base, count + 1);
        const slug = count === 0 ? base : `${base}-${count}`;
        if (wanted.has(slug)) return h.line;
    }
    return undefined;
}

/**
 * The line `target` lands on in `text`, or undefined when the document has
 * no such heading or is shorter than the line asked for.
 */
export function resolveAtTarget(text: string, target: AtTarget): number | undefined {
    if (target.kind === "heading") return findHeadingLine(text, target.fragment);
    return target.line <= documentLineCount(text) ? target.line : undefined;
}

/**
 * How many lines a reveal can land on: a final newline ends the last line
 * rather than starting an empty one, and an empty document still has line 1.
 */
export function documentLineCount(text: string): number {
    if (text === "") return 1;
    const parts = text.split("\n");
    return text.endsWith("\n") ? parts.length - 1 : parts.length;
}
