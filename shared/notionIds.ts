/**
 * shared/notionIds.ts
 *
 * Notion's markdown export suffixes every page file and every folder with
 * that page's 32-hex id, and percent-encodes the result into its links:
 * `[Room 1](Room%201%207a6f70896bfc4e5e976d588412b74370.md)`. Two consumers
 * have to recognize the shape, so the pattern lives once, here:
 *
 *   - the link resolver, which retries a miss with the ids removed so links
 *     into a vault whose files were renamed by a converter still open;
 *   - the link popup, which shows the cleaned name and keeps the target the
 *     file actually holds one hover away.
 *
 * Nothing here rewrites a document. Cleaning is display and resolution only;
 * the bytes on disk stay exactly as the export wrote them.
 *
 * The separator is a literal space, never `\s`. A space is what the exporter
 * writes, and what `%20` decodes to. `\s` would also admit a tab, a newline,
 * and a non-breaking space, none of which the exporter emits there, so it
 * would only widen the set of ordinary filenames whose tail this removes.
 * The id is lowercase because the exporter writes it lowercase; accepting
 * uppercase would widen the same set for no export we can point at.
 */

/**
 * One path segment's trailing Notion id, with the file extension captured so
 * it can be kept. Anchored at the end: an id is a suffix, never an infix.
 */
const NOTION_ID_SUFFIX = / [0-9a-f]{32}(\.\w+)?$/;

/**
 * `segment` with its trailing Notion id removed, or null when it carries
 * none. The extension is preserved (`Room 1 7a6f….md` becomes `Room 1.md`),
 * because a resolver needs a name it can still stat and the popup needs to
 * keep telling a note apart from an attachment of the same title.
 *
 * A segment that is nothing BUT an id is left alone: stripping it would
 * produce a nameless path, which no vault contains and which would make the
 * resolver's retry match on the extension alone.
 */
export function stripNotionIdFromSegment(segment: string): string | null {
    const m = NOTION_ID_SUFFIX.exec(segment);
    if (!m) return null;
    const stem = segment.slice(0, m.index);
    if (!stem) return null;
    return stem + (m[1] ?? "");
}

/**
 * `linkPath` with the Notion id removed from EVERY segment, or null when no
 * segment carried one. A null lets a caller skip the retry entirely rather
 * than re-trying a form identical to one it has already tried.
 *
 * Segments split on `/` only: this takes a link target, which is posix by
 * the markdown spec, not a host path.
 *
 * All segments or none, deliberately. A tree cleaned unevenly (the folder
 * renamed, the file inside it not) needs the product of every segment's two
 * spellings, which is exponential in the path's depth; converters clean a
 * tree uniformly, so the case that would buy is one nobody produces.
 */
export function stripNotionIds(linkPath: string): string | null {
    const segs = linkPath.split("/");
    let found = false;
    const cleaned = segs.map((seg) => {
        const s = stripNotionIdFromSegment(seg);
        if (s === null) return seg;
        found = true;
        return s;
    });
    return found ? cleaned.join("/") : null;
}

/**
 * The readable form of a link target for display: percent-decoded and with
 * every Notion id removed, keeping any `#fragment` intact. Returns null when
 * the target carries no Notion id, which is the signal to display the href
 * verbatim rather than a decoded rewrite of an ordinary link.
 *
 * Decoding is deliberately part of THIS function and not of the resolver's
 * strip: `Room%201%20…` and `Room 1 …` are the same ugly target to a reader,
 * while to a resolver they are two different filenames worth trying
 * separately.
 */
export function notionDisplayTarget(href: string): string | null {
    const hash = href.indexOf("#");
    const pathPart = hash >= 0 ? href.slice(0, hash) : href;
    const fragment = hash >= 0 ? href.slice(hash) : "";
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathPart);
    } catch {
        decoded = pathPart;
    }
    const cleaned = stripNotionIds(decoded);
    return cleaned === null ? null : cleaned + fragment;
}
