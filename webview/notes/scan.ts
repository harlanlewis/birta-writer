/**
 * webview/notes/scan.ts — the pure Notes scanner (MAR-188).
 *
 * Walks a ProseMirror document and surfaces "editor-note" markers — the things
 * a writer leaves for themselves (or an LLM) to resolve before publish — as a
 * flat, document-ordered list the review sidebar's Notes tab renders and
 * navigates. It writes nothing and decorates nothing: detection only.
 *
 * The source of truth is the DOCUMENT, not raw markdown text — this is a
 * WYSIWYG editor, so an HTML comment is an inline `html` atom node and a
 * checkbox is a `list_item` with a `checked` attr, neither of which a text
 * scan would see. Built-in detectors (all on by default):
 *
 *   - `[TK]` / `[TK: …]`            — the "to come" placeholder (bracket-only)
 *   - `TODO:` / `[TODO]` / `[TODO: …]`
 *   - `FIXME:` / `[FIXME]` / `[FIXME: …]`
 *   - `<!-- … -->`                  — HTML comments (routed by a TK/TODO/FIXME prefix)
 *   - unchecked task checkboxes     — `list_item` with `checked === false`
 *   - custom literal strings        — from `birta.notes.customMarkers`
 *
 * Bare keyword tokens are word-boundaried so `TODO`/a custom `TK` can never
 * light up inside `pseudoTODO` / `networks`.
 */
import type { Node as ProseNode } from "../pm";

export type NoteKind = "placeholder" | "todo" | "fixme" | "comment" | "task" | "custom";

export interface NoteItem {
    /** Document position the row reveals/selects from. */
    from: number;
    /** End position (selection end); equals `from` for zero-width anchors. */
    to: number;
    kind: NoteKind;
    /**
     * The matched token, kept for the custom kind (whose chip shows the marker
     * itself); built-in kinds drive their chip from `kind` instead.
     */
    marker: string;
    /** Display label — the trailing text after `:`, else a context snippet. */
    label: string;
}

/** A marker match within a single block's text, offsets local to that text. */
interface TextMatch {
    start: number;
    end: number;
    kind: NoteKind;
    marker: string;
    label: string;
}

/** Non-text inline nodes and inline code mask to this so offsets map 1:1 to
 *  document positions (a match offset + blockPos + 1 IS the doc position). The
 *  object-replacement char can never appear in real prose. */
const MASK = "￼";

/** Whitespace-collapse and trim a snippet, dropping any masking chars. */
function snippet(text: string): string {
    return text.replace(new RegExp(MASK, "g"), "").replace(/\s+/g, " ").trim();
}

/** Resolve a row's label: an explicit trailing spec wins; else the block gives context. */
function resolveLabel(explicit: string | undefined, blockText: string): string {
    const e = explicit?.trim();
    return e && e.length > 0 ? snippet(e) : snippet(blockText);
}

const BUILTIN_KIND: Record<string, NoteKind> = { TK: "placeholder", TODO: "todo", FIXME: "fixme" };

// Bracketed form: [TK], [TK: label], [TODO], [TODO: label], [FIXME], [FIXME: label].
const BRACKET_RE = /\[(TK|TODO|FIXME)(?::[ \t]*([^\]]*?))?[ \t]*\]/g;
// Unbracketed colon form: TODO: … / FIXME: … (NOT TK — bare "TK:" is too
// false-positive-prone; TK stays bracket-only). Word-boundaried on the left so
// "pseudoTODO:" never matches.
const COLON_RE = /(?<![A-Za-z0-9_])(TODO|FIXME):[ \t]*([^\n]*)/g;

/** True when [a,b) overlaps any [from,to) range already claimed. */
function overlaps(ranges: Array<[number, number]>, a: number, b: number): boolean {
    return ranges.some(([from, to]) => a < to && b > from);
}

/** Escape a literal string for use inside a RegExp. */
function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * All marker matches in one block's (masked) text, document-ordered. Pure and
 * fully unit-testable on plain strings. Built-in markers are found first and
 * their ranges claimed, so a custom marker (or the colon pass) can't re-report
 * text a bracket already covered.
 */
export function findTextMarkers(text: string, customMarkers: readonly string[] = []): TextMatch[] {
    const matches: TextMatch[] = [];
    const claimed: Array<[number, number]> = [];

    for (const m of text.matchAll(BRACKET_RE)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        const kw = m[1].toUpperCase();
        matches.push({ start, end, kind: BUILTIN_KIND[kw]!, marker: kw, label: resolveLabel(m[2], text) });
        claimed.push([start, end]);
    }

    for (const m of text.matchAll(COLON_RE)) {
        const start = m.index ?? 0;
        const end = start + m[1].length + 1; // keyword + ":"
        if (overlaps(claimed, start, end)) { continue; }
        const kw = m[1].toUpperCase();
        matches.push({ start, end, kind: BUILTIN_KIND[kw]!, marker: kw, label: resolveLabel(m[2], text) });
        claimed.push([start, end]);
    }

    for (const raw of customMarkers) {
        const marker = raw.trim();
        if (!marker) { continue; }
        // A plain alphanumeric token matches only as a whole word; anything with
        // punctuation (e.g. "@ai", "[REVIEW]") matches as a literal substring.
        const body = escapeRe(marker);
        const re = /^\w+$/.test(marker)
            ? new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, "g")
            : new RegExp(body, "g");
        for (const m of text.matchAll(re)) {
            const start = m.index ?? 0;
            const end = start + m[0].length;
            if (overlaps(claimed, start, end)) { continue; }
            matches.push({ start, end, kind: "custom", marker, label: snippet(text) });
            claimed.push([start, end]);
        }
    }

    return matches.sort((a, b) => a.start - b.start);
}

/** Route an HTML comment's inner text by a leading TK/TODO/FIXME prefix. */
function classifyComment(inner: string): { kind: NoteKind; marker: string; label: string } {
    const m = /^(TK|TODO|FIXME)\b:?[ \t]*([\s\S]*)$/i.exec(inner);
    if (m) {
        const kw = m[1].toUpperCase();
        return { kind: BUILTIN_KIND[kw]!, marker: kw, label: snippet(m[2]) || snippet(inner) };
    }
    return { kind: "comment", marker: "note", label: snippet(inner) };
}

/** The label for an unchecked task row: the item's first block text. */
function taskLabel(item: ProseNode): string {
    const first = item.firstChild;
    return snippet(first?.textContent ?? item.textContent ?? "");
}

/**
 * Flatten one block into text where every offset maps 1:1 to a document
 * position: text nodes contribute their characters (inline code masked, so a
 * marker inside a code span never fires), every other inline node contributes
 * `nodeSize` masking chars. Mirrors the proofread masking contract but stays
 * self-contained so the scanner has no dependency on the proofread graph.
 */
function maskedBlockText(block: ProseNode): string {
    let text = "";
    block.forEach((child) => {
        if (child.isText) {
            const isCode = child.marks.some((mark) => mark.type.name === "inlineCode");
            text += isCode ? MASK.repeat(child.text?.length ?? 0) : (child.text ?? "");
        } else {
            text += MASK.repeat(child.nodeSize);
        }
    });
    return text;
}

/**
 * Scan the whole document for editor-note markers, document-ordered. Pure: it
 * reads the doc and returns rows, mutating nothing. `customMarkers` come from
 * `birta.notes.customMarkers`.
 */
export function scanNotes(doc: ProseNode, customMarkers: readonly string[] = []): NoteItem[] {
    const items: NoteItem[] = [];

    doc.descendants((node, pos) => {
        // HTML comment inline atoms (preserved by the markdown format as `html`
        // nodes; the `html-comment` chip renders them). Never descend — atoms
        // have no child content to walk.
        if (node.type.name === "html") {
            const raw = (node.attrs?.["value"] ?? "").trim();
            const m = /^<!--([\s\S]*?)-->$/.exec(raw);
            if (m) {
                const { kind, marker, label } = classifyComment(m[1].trim());
                items.push({ from: pos, to: pos + node.nodeSize, kind, marker, label });
            }
            return false;
        }

        // Unchecked task checkboxes. Descend so a marker inside the item's text
        // (a `[TK]` in a to-do) is still caught by the textblock branch below.
        if (node.type.name === "list_item" && node.attrs?.["checked"] === false) {
            items.push({ from: pos + 1, to: pos + 1, kind: "task", marker: "task", label: taskLabel(node) });
            return true;
        }

        if (node.isTextblock) {
            if (node.type.name === "code_block") { return false; }
            const text = maskedBlockText(node);
            const base = pos + 1;
            for (const t of findTextMarkers(text, customMarkers)) {
                items.push({ from: base + t.start, to: base + t.end, kind: t.kind, marker: t.marker, label: t.label });
            }
            // Descend into inline content so nested `html` comment atoms are
            // visited (they hit the html branch above); a textblock holds no
            // child BLOCKS, but it does hold the inline nodes we care about.
            return true;
        }

        return true;
    });

    return items.sort((a, b) => a.from - b.from);
}
