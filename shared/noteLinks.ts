/**
 * shared/noteLinks.ts
 *
 * What one note says about other notes, read from its SOURCE bytes rather than
 * from a parsed editor document: the local links in its body, the wikilinks,
 * and the `sources[].resource` paths its frontmatter names (the Open Knowledge
 * Format's one relationship field). Plus the few attributes a folder view
 * shows of a note: its title, `type`, `tags` and provenance.
 *
 * This runs on the HOST, over every note in a folder, which is why it is not
 * the editor's parser: a host indexing five hundred files cannot build five
 * hundred ProseMirror documents, and the Mac host cannot build one at all. So
 * it is a scanner, and the thing that keeps it honest is an oracle rather
 * than its author: `webview/__tests__/noteLinksCorpus.test.ts` parses the whole
 * corpus with the live editor and holds this module's links equal to what
 * `webview/links/scan.ts` finds in the resulting document.
 *
 * Classification is the page scanner's: a link is kept only when it points at
 * a file, never at a URL with a scheme or at a `#fragment` in the same note.
 * Nothing here resolves a path; which file a link means is the host's
 * question, answered by the same resolver a click uses.
 */

import { extractFrontmatter } from "./contentTransform";
import { parseQuotedToken, parseTabularFrontmatter } from "./frontmatterTable";
import type { FmEntry } from "./frontmatterTable";
import { readOkfProvenance } from "./okf";
import type { OkfStatus, OkfTrust } from "./okf";
import { parseWikiRaw, wikiDisplayText } from "./wikiRaw";

/** Where in a note a reference to another note was written. */
export type NoteLinkKind = "link" | "wiki" | "source";

export interface NoteLinkRef {
    kind: NoteLinkKind;
    /**
     * The destination as the editor holds it: escapes and character references
     * decoded, a wikilink's `target#heading`. Never resolved, never decoded
     * past what the Markdown itself encodes.
     */
    href: string;
    /** `href` up to its first `#`: the part a resolver takes. */
    path: string;
    /** What the reader sees for the link. */
    text: string;
    /** 1-based line of the file the reference was written on. */
    line: number;
}

export interface NoteMeta {
    /** Frontmatter `title`, else null (the caller falls back to the file name). */
    title: string | null;
    /** OKF `type`, the one field the format requires; null when absent. */
    type: string | null;
    tags: string[];
    status: OkfStatus | null;
    trust: OkfTrust | null;
    staleAfter: string | null;
}

export interface NoteReading {
    links: NoteLinkRef[];
    meta: NoteMeta;
}

/** An href with a scheme, or a bare `#fragment`, is not a link to a note. */
export function isNoteHref(href: string): boolean {
    if (href === "" || href.startsWith("#")) { return false; }
    return !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** The path portion of an href: everything before its first `#`. */
export function hrefPath(href: string): string {
    const hash = href.indexOf("#");
    return hash >= 0 ? href.slice(0, hash) : href;
}

// ── Decoding: what the Markdown itself encodes in a destination ────────────

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

/**
 * The named references decoded here: the ones a path or a label plausibly
 * holds. The editor decodes every HTML named reference, so a destination
 * spelled with any other (`&copy;`) reads here as naming the literal text,
 * and its reference dangles where a click would open it. Closing that needs
 * the whole entity table on both hosts, which the case does not repay.
 */
const NAMED_ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
};

/**
 * A numeric reference as micromark decodes it
 * (`micromark-util-decode-numeric-character-reference`): the code points no
 * document may carry (C0 and C1 controls, surrogates, noncharacters, and
 * anything past U+10FFFF) read as U+FFFD, never as a throw, since one note
 * throwing rejects a host's whole folder index.
 */
function decodeNumeric(code: number): string {
    const bad = code < 9 || code === 11 || (code > 13 && code < 32)
        || (code > 126 && code < 160)
        || (code > 55_295 && code < 57_344)
        || (code > 64_975 && code < 65_008)
        || (code & 65_535) === 65_535 || (code & 65_535) === 65_534
        || code > 1_114_111;
    return bad ? "�" : String.fromCodePoint(code);
}

/** Backslash escapes of ASCII punctuation and the character references a link
 *  destination can carry, decoded as CommonMark decodes them. */
function decodeMarkdownText(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch === "\\" && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1]!)) {
            out += s[i + 1];
            i++;
            continue;
        }
        if (ch === "&") {
            const m = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/.exec(s.slice(i));
            if (m) {
                let decoded: string | null = null;
                if (m[1] !== undefined) { decoded = decodeNumeric(parseInt(m[1], 16)); }
                else if (m[2] !== undefined) { decoded = decodeNumeric(parseInt(m[2], 10)); }
                else if (m[3] !== undefined && Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, m[3])) { decoded = NAMED_ENTITIES[m[3]]!; }
                if (decoded !== null) {
                    out += decoded;
                    i += m[0].length - 1;
                    continue;
                }
            }
        }
        out += ch;
    }
    return out;
}

/** A reference label as CommonMark matches it: whitespace collapsed, case folded. */
function normalizeLabel(label: string): string {
    return label.replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
}

/** A label's text as the reader sees it: escapes decoded, emphasis and code
 *  markers dropped, whitespace collapsed. */
function labelText(label: string): string {
    return decodeMarkdownText(label).replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
}

// ── Block pass: fences, definitions ─────────────────────────────────────────

/** Blockquote markers opening a line; what follows is read as its own line. */
const QUOTE_PREFIX = /^(?:[ ]{0,3}>[ ]?)*/;
/** A list item's marker and the spaces after it (four at most: a fifth space
 *  starts indented code inside the item). */
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(?:( {1,4})(?=\S)|[ \t]*$)/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
/** A link reference definition. `[^label]:` is a footnote, never a definition. */
const DEFINITION = /^\[(?!\^)((?:[^\]\\\n]|\\.){1,999})\]:[ \t]*(?:<([^<>\n]*)>|(\S+))/;
/** CommonMark's HTML block kind 1: raw text elements, closed by their end tag. */
const HTML_RAW_OPEN = /^<(script|pre|style|textarea)(?:\s|>|$)/i;
/** Kind 6: a block-level tag, open or close, which holds until a blank line. */
const HTML_BLOCK_OPEN = /^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;
/** Kind 7: any other complete tag alone on its line; it cannot interrupt a paragraph. */
const HTML_TAG_LINE = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;

interface BlockPass {
    /** 1 for every character of the body a link cannot live in. */
    mask: Uint8Array;
    defs: Map<string, string>;
}

/** The column a line's text starts at, tabs advancing to the next multiple of four. */
function indentOf(s: string): { cols: number; chars: number } {
    let cols = 0;
    let chars = 0;
    while (chars < s.length && (s[chars] === " " || s[chars] === "\t")) {
        cols = s[chars] === "\t" ? cols + 4 - (cols % 4) : cols + 1;
        chars++;
    }
    return { cols, chars };
}

/**
 * Masks every line a link cannot live in, and collects the link reference
 * definitions. A line classifier rather than a parser: it tracks just enough
 * block context (an open fence, a math block, an HTML block, the current list
 * item's content column, whether a paragraph is open) to answer "can this line
 * hold a link", and the corpus oracle is what says it answers correctly.
 */
function blockPass(body: string): BlockPass {
    const mask = new Uint8Array(body.length);
    const defs = new Map<string, string>();
    let fence: { char: string; len: number } | null = null;
    let math = false;
    let html: { until: "blank" } | { until: RegExp } | null = null;
    // The content column of the list item the lines belong to, 0 outside a list.
    let listIndent = 0;
    let inParagraph = false;
    let pos = 0;
    while (pos <= body.length) {
        const nl = body.indexOf("\n", pos);
        const end = nl < 0 ? body.length : nl;
        const line = body.slice(pos, end).replace(/\r$/, "");
        const rest = line.slice((QUOTE_PREFIX.exec(line)?.[0] ?? "").length);
        const { cols, chars } = indentOf(rest);
        let text = rest.slice(chars);
        const blank = text === "";
        const maskLine = (): void => { mask.fill(1, pos, end); };
        const next = (): boolean => {
            if (nl < 0) { return false; }
            pos = nl + 1;
            return true;
        };

        if (fence) {
            maskLine();
            const close = FENCE_CLOSE.exec(text);
            if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) { fence = null; }
            if (!next()) { break; }
            continue;
        }
        if (math) {
            maskLine();
            if (text.includes("$$")) { math = false; }
            if (!next()) { break; }
            continue;
        }
        if (html) {
            if (html.until === "blank") {
                if (blank) { html = null; } else { maskLine(); }
            } else {
                maskLine();
                if (html.until.test(line)) { html = null; }
            }
            if (!next()) { break; }
            continue;
        }
        if (blank) {
            inParagraph = false;
            if (!next()) { break; }
            continue;
        }

        const listItem = cols - listIndent <= 3 || listIndent === 0 ? LIST_ITEM.exec(text) : null;
        if (listIndent > 0 && cols < listIndent && !listItem && !inParagraph) { listIndent = 0; }
        const relative = listIndent > 0 && cols >= listIndent ? cols - listIndent : cols;

        if (relative >= 4 && !inParagraph && !listItem) {
            maskLine(); // indented code
            if (!next()) { break; }
            continue;
        }
        if (listItem) {
            const spaces = listItem[2]?.length ?? 1;
            listIndent = cols + listItem[1]!.length + spaces;
            text = text.slice(listItem[0].length);
            inParagraph = false;
        }

        const open = FENCE_OPEN.exec(text);
        if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
            fence = { char: open[1]![0]!, len: open[1]!.length };
            inParagraph = false;
            maskLine();
        } else if (text.startsWith("$$")) {
            if (!text.slice(2).includes("$$")) { math = true; }
            inParagraph = false;
            maskLine();
        } else if (HTML_RAW_OPEN.test(text)) {
            const tag = HTML_RAW_OPEN.exec(text)![1]!;
            const closer = new RegExp(`</${tag}>`, "i");
            if (!closer.test(text)) { html = { until: closer }; }
            inParagraph = false;
            maskLine();
        } else if (HTML_BLOCK_OPEN.test(text) || (!inParagraph && HTML_TAG_LINE.test(text))) {
            html = { until: "blank" };
            inParagraph = false;
            maskLine();
        } else {
            const def = inParagraph ? null : DEFINITION.exec(text);
            if (def) {
                const label = normalizeLabel(def[1]!);
                // The first definition of a label wins, as in CommonMark.
                if (!defs.has(label)) { defs.set(label, decodeMarkdownText(def[2] ?? def[3] ?? "")); }
                maskLine();
            } else {
                inParagraph = !/^#{1,6}(?:\s|$)/.test(text);
            }
        }
        if (!next()) { break; }
    }
    return { mask, defs };
}

// ── Inline pass ─────────────────────────────────────────────────────────────

/** Is `i` the first character of a blank line (the end of a paragraph)? */
function blankLineAt(s: string, i: number): boolean {
    if (s[i] !== "\n") { return false; }
    let j = i + 1;
    while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\r")) { j++; }
    return j >= s.length || s[j] === "\n";
}

/** Length of the backtick run starting at `i`. */
function tickRun(s: string, i: number): number {
    let j = i;
    while (s[j] === "`") { j++; }
    return j - i;
}

/** The index just past the code span opening at `i`, or -1 when the run has
 *  no closing run of the same length in its paragraph. */
function codeSpanEnd(s: string, i: number, mask: Uint8Array): number {
    const n = tickRun(s, i);
    let j = i + n;
    while (j < s.length) {
        if (mask[j] || blankLineAt(s, j)) { return -1; }
        if (s[j] === "`") {
            const m = tickRun(s, j);
            if (m === n) { return j + m; }
            j += m;
            continue;
        }
        j++;
    }
    return -1;
}

/** The `]` closing the label that opens at `open` (a `[`), or -1. Nested
 *  brackets balance, escapes and code spans are skipped, and a label never
 *  crosses a blank line or masked text. */
function labelEnd(s: string, open: number, mask: Uint8Array): number {
    let depth = 0;
    for (let j = open; j < s.length; j++) {
        if (mask[j] || blankLineAt(s, j)) { return -1; }
        const ch = s[j];
        if (ch === "\\") { j++; continue; }
        if (ch === "`") {
            const end = codeSpanEnd(s, j, mask);
            if (end > 0) { j = end - 1; continue; }
            j += tickRun(s, j) - 1;
            continue;
        }
        if (ch === "[") { depth++; }
        else if (ch === "]") {
            depth--;
            if (depth === 0) { return j; }
        }
    }
    return -1;
}

/** An inline link's `(destination "title")` opening at `open` (a `(`):
 *  the raw destination and the index just past the `)`, or null. */
function inlineDestination(s: string, open: number): { dest: string; end: number } | null {
    let j = open + 1;
    const skipSpace = (): void => {
        let newlines = 0;
        while (j < s.length && /[ \t\r\n]/.test(s[j]!)) {
            if (s[j] === "\n" && ++newlines > 1) { return; }
            j++;
        }
    };
    skipSpace();
    let dest = "";
    if (s[j] === "<") {
        const close = s.indexOf(">", j + 1);
        if (close < 0) { return null; }
        dest = s.slice(j + 1, close);
        if (/[\n<]/.test(dest)) { return null; }
        j = close + 1;
    } else {
        const start = j;
        let depth = 0;
        while (j < s.length) {
            const ch = s[j]!;
            if (ch === "\\" && j + 1 < s.length) { j += 2; continue; }
            if (/[\s\x00-\x1f]/.test(ch)) { break; }
            if (ch === "(") { depth++; }
            else if (ch === ")") {
                if (depth === 0) { break; }
                depth--;
            }
            j++;
        }
        if (depth !== 0) { return null; }
        dest = s.slice(start, j);
    }
    const afterDest = j;
    skipSpace();
    if (j > afterDest && (s[j] === "\"" || s[j] === "'" || s[j] === "(")) {
        const closer = s[j] === "(" ? ")" : s[j]!;
        j++;
        while (j < s.length && s[j] !== closer) {
            if (s[j] === "\\") { j++; }
            j++;
        }
        if (j >= s.length) { return null; }
        j++;
        skipSpace();
    }
    if (s[j] !== ")") { return null; }
    return { dest, end: j + 1 };
}

/** A wikilink opening at `i` (the first of `[[`): its raw inner bytes and the
 *  index past the closing `]]`, under the same grammar as the page's micromark
 *  construct (plugins/wikiLinks.ts), or null. */
function wikiAt(s: string, i: number): { raw: string; end: number } | null {
    if (s[i] !== "[" || s[i + 1] !== "[") { return null; }
    let j = i + 2;
    while (j < s.length && s[j] !== "[" && s[j] !== "]" && s[j] !== "\n" && s[j] !== "\r") { j++; }
    if (j === i + 2 || s[j] !== "]" || s[j + 1] !== "]") { return null; }
    // `[[x]](url)` is a CommonMark link whose label holds brackets.
    if (s[j + 2] === "(") { return null; }
    return { raw: s.slice(i + 2, j), end: j + 2 };
}

interface BodyLink { at: number; href: string; text: string; wiki: boolean }

const IMAGE_ONLY_LABEL = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

function inlinePass(body: string, { mask, defs }: BlockPass): BodyLink[] {
    const out: BodyLink[] = [];
    let i = 0;
    while (i < body.length) {
        if (mask[i]) { i++; continue; }
        const ch = body[i]!;
        if (ch === "\\") { i += 2; continue; }
        if (ch === "`") {
            const end = codeSpanEnd(body, i, mask);
            i = end > 0 ? end : i + tickRun(body, i);
            continue;
        }
        if (ch === "<" && body.startsWith("<!--", i)) {
            const close = body.indexOf("-->", i + 4);
            i = close < 0 ? body.length : close + 3;
            continue;
        }
        if (ch !== "[" && !(ch === "!" && body[i + 1] === "[")) { i++; continue; }

        const image = ch === "!";
        const open = image ? i + 1 : i;
        if (!image) {
            const wiki = wikiAt(body, open);
            if (wiki) {
                out.push({ at: open, href: wikiHref(wiki.raw), text: wikiDisplayText(wiki.raw), wiki: true });
                i = wiki.end;
                continue;
            }
        }
        const close = labelEnd(body, open, mask);
        if (close < 0) { i = open + 1; continue; }
        const label = body.slice(open + 1, close);

        let href: string | null = null;
        let end = close + 1;
        if (body[close + 1] === "(") {
            const dest = inlineDestination(body, close + 1);
            if (dest) {
                href = decodeMarkdownText(dest.dest);
                end = dest.end;
            }
        }
        if (href === null && body[close + 1] === "[") {
            const refClose = labelEnd(body, close + 1, mask);
            if (refClose > 0) {
                const ref = body.slice(close + 2, refClose);
                const def = defs.get(normalizeLabel(ref === "" ? label : ref));
                if (def !== undefined) {
                    href = def;
                    end = refClose + 1;
                }
            }
        }
        if (href === null && !label.startsWith("^")) {
            const def = defs.get(normalizeLabel(label));
            if (def !== undefined) { href = def; }
        }
        if (href === null) { i = open + 1; continue; }
        // A link whose whole label is an image carries its mark on no text, so
        // the page's Links scan never reports it; the index answers the same,
        // so the Backlinks and Links tabs cannot disagree about a note.
        if (!image && !IMAGE_ONLY_LABEL.test(label)) {
            out.push({ at: open, href, text: labelText(label), wiki: false });
        }
        i = end;
    }
    return out;
}

/** A wikilink's href as the page scanner forms it: `target#heading`. */
function wikiHref(raw: string): string {
    const parts = parseWikiRaw(raw);
    return parts.target + (parts.heading ? `#${parts.heading}` : "");
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

function unquote(value: string): string {
    return parseQuotedToken(value.trim()).value;
}

function readMeta(entries: FmEntry[] | null): NoteMeta {
    const meta: NoteMeta = { title: null, type: null, tags: [], status: null, trust: null, staleAfter: null };
    if (!entries) { return meta; }
    const scalar = (key: string): string | null => {
        const entry = entries.find((e) => e.key === key);
        if (!entry || entry.list || entry.nested) { return null; }
        const value = unquote(entry.value);
        return value === "" ? null : value;
    };
    meta.title = scalar("title");
    meta.type = scalar("type");
    const tags = entries.find((e) => e.key === "tags");
    if (tags?.list) { meta.tags = tags.list.items.map((item) => item.value).filter((v) => v !== ""); }
    else if (tags && !tags.nested) {
        const one = unquote(tags.value);
        if (one !== "") { meta.tags = [one]; }
    }
    const provenance = readOkfProvenance(entries);
    if (provenance) {
        meta.status = provenance.status;
        meta.trust = provenance.trust;
        meta.staleAfter = provenance.staleAfter;
    }
    return meta;
}

/** The `sources[].resource` paths a frontmatter block names, with the file
 *  line each was written on. */
function readSources(entries: FmEntry[] | null, frontmatter: string): NoteLinkRef[] {
    const sources = entries?.find((e) => e.key === "sources");
    if (!sources?.nested) { return []; }
    const lines = frontmatter.split("\n");
    const out: NoteLinkRef[] = [];
    for (const item of sources.nested.items) {
        const leaf = item.leaves.find((l) => l.key === "resource");
        if (!leaf) { continue; }
        const href = unquote(leaf.value);
        if (!isNoteHref(href)) { continue; }
        const title = item.leaves.find((l) => l.key === "title");
        const source = leaf.origLine ?? item.origLine;
        const lineIdx = source !== undefined ? lines.indexOf(source) : -1;
        out.push({
            kind: "source",
            href,
            path: hrefPath(href),
            text: title ? unquote(title.value) : href,
            line: lineIdx >= 0 ? lineIdx + 1 : 1,
        });
    }
    return out;
}

// ── Entry points ────────────────────────────────────────────────────────────

/** Every body link the page scanner would report, local or not, in source
 *  order. Exported for the corpus oracle; the index wants `readNote`. */
export function scanBodyLinks(body: string): Array<{ href: string; text: string; wiki: boolean; at: number }> {
    return inlinePass(body, blockPass(body));
}

/** One note's references to other notes, and its attributes. */
export function readNote(content: string): NoteReading {
    const { frontmatter, body } = extractFrontmatter(content);
    const entries = frontmatter === "" ? null : parseTabularFrontmatter(frontmatter);
    const bodyLine0 = frontmatter === "" ? 0 : frontmatter.split("\n").length - 1;

    // Line starts of the body, for the 1-based line a link sits on.
    const starts = [0];
    for (let i = 0; i < body.length; i++) { if (body[i] === "\n") { starts.push(i + 1); } }
    const lineOf = (at: number): number => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid]! <= at) { lo = mid; } else { hi = mid - 1; }
        }
        return bodyLine0 + lo + 1;
    };

    const links: NoteLinkRef[] = readSources(entries, frontmatter);
    for (const link of scanBodyLinks(body)) {
        if (!isNoteHref(link.href)) { continue; }
        links.push({
            kind: link.wiki ? "wiki" : "link",
            href: link.href,
            path: hrefPath(link.href),
            text: link.text,
            line: lineOf(link.at),
        });
    }
    return { links, meta: readMeta(entries) };
}
