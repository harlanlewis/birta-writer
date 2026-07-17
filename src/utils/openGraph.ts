/**
 * openGraph.ts
 *
 * Deterministic page-title extraction for paste-unfurl (MAR-178). A pure
 * function of an HTML string: no network, no DOM, no LLM — just a couple of
 * narrow regexes plus HTML-entity decoding, so it unit-tests trivially and can
 * never hang on a pathological page (the caller caps the byte budget before we
 * ever see the text).
 *
 * Why regex and not a real HTML parser: the only thing we need is the title,
 * which lives in a handful of `<meta>` tags and `<title>` near the top of
 * `<head>`. A full DOM parser would be a heavy dependency and a much larger
 * attack surface for a value we then sanitize to plain text anyway. The parse
 * is deliberately forgiving (attribute order, single/double/unquoted values)
 * and returns null rather than throwing on anything it doesn't recognize.
 *
 * Fallback chain: `og:title` → `<title>` → null. A null result tells the
 * webview to keep the bare `[url](url)` it already inserted.
 */

/** Hard cap on the returned title length (characters), after sanitization. */
const MAX_TITLE_LENGTH = 300;

/**
 * The small set of named HTML entities worth decoding for a title. Numeric
 * entities (`&#39;`, `&#x2019;`) are handled separately below; this table only
 * covers the named ones that realistically show up in a page title.
 */
const NAMED_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
    // Common typographic entities so a title like "Foo &mdash; Bar" reads right.
    mdash: "—",
    ndash: "–",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
};

/**
 * Decode the HTML entities a page title can contain. Numeric (decimal and hex)
 * character references are decoded by code point; named references fall back to
 * the small table above, and an unknown entity is left verbatim (better a
 * literal `&frob;` than dropping text).
 */
export function decodeHtmlEntities(input: string): string {
    return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
        if (body[0] === "#") {
            const isHex = body[1] === "x" || body[1] === "X";
            const codePoint = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
            // Reject out-of-range / invalid code points rather than throwing.
            if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
                return whole;
            }
            try {
                return String.fromCodePoint(codePoint);
            } catch {
                return whole;
            }
        }
        return NAMED_ENTITIES[body] ?? whole;
    });
}

/**
 * Normalize a raw title fragment into a single clean line, or null when nothing
 * usable remains. Order matters: decode entities first (so `&#10;` becomes a
 * real newline we can then collapse), strip control characters (newlines, tabs,
 * and other C0/C1 controls → space), collapse runs of whitespace, trim, and
 * finally cap the length.
 */
export function sanitizeTitle(raw: string): string | null {
    let s = decodeHtmlEntities(raw);
    // Control chars (incl. newlines/tabs) → a single space; collapse afterwards.
    s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    if (!s) {
        return null;
    }
    if (s.length > MAX_TITLE_LENGTH) {
        // Trim again: slicing can leave a trailing space mid-collapse.
        s = s.slice(0, MAX_TITLE_LENGTH).trim();
    }
    return s || null;
}

/**
 * Read one attribute's value out of a single `<meta …>` tag string. Accepts
 * double-quoted, single-quoted, and unquoted values; returns null when the
 * attribute is absent. Case-insensitive attribute name.
 */
function getAttr(tag: string, name: string): string | null {
    const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
    const m = re.exec(tag);
    if (!m) {
        return null;
    }
    // Exactly one of the three capture groups is populated by construction.
    return m[2] ?? m[3] ?? m[4] ?? "";
}

/**
 * The `content` of the first `<meta>` whose `property` OR `name` equals
 * `key` (case-insensitive), or null. `og:title` is conventionally carried on
 * `property=`, but some pages use `name=`, so we accept either.
 */
function extractMetaContent(html: string, key: string): string | null {
    const metaRe = /<meta\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = metaRe.exec(html)) !== null) {
        const tag = m[0];
        const prop = getAttr(tag, "property") ?? getAttr(tag, "name");
        if (prop && prop.toLowerCase() === key) {
            const content = getAttr(tag, "content");
            if (content !== null) {
                return content;
            }
        }
    }
    return null;
}

/** The inner text of the first `<title>…</title>`, or null. */
function extractTitleTag(html: string): string | null {
    const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return m ? (m[1] ?? "") : null;
}

/**
 * The page's display title, deterministically parsed from its HTML:
 * `og:title` → `<title>` → null. The returned string is already sanitized
 * (entities decoded, control chars/newlines collapsed, trimmed, length-capped);
 * null means the HTML carried no usable title and the caller should keep the
 * bare link. An `og:title` present but sanitizing to empty falls through to
 * `<title>` rather than returning null prematurely.
 */
export function extractOgTitle(html: string): string | null {
    const og = extractMetaContent(html, "og:title");
    const ogTitle = og !== null ? sanitizeTitle(og) : null;
    if (ogTitle) {
        return ogTitle;
    }
    const bare = extractTitleTag(html);
    return bare !== null ? sanitizeTitle(bare) : null;
}
