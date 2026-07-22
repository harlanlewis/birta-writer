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
import { singleTextblockInlineEdit } from "../utils/textblockEdit";

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

/** Parse one inline HTML atom (`<!-- … -->`) into a note item, or null. */
function htmlCommentItem(node: ProseNode, pos: number): NoteItem | null {
    const raw = (node.attrs?.["value"] ?? "").trim();
    const m = /^<!--([\s\S]*?)-->$/.exec(raw);
    if (!m) { return null; }
    const { kind, marker, label } = classifyComment(m[1].trim());
    return { from: pos, to: pos + node.nodeSize, kind, marker, label };
}

/**
 * Every note marker inside ONE textblock's inline content — bracket/colon/custom
 * text markers plus inline HTML-comment atoms — each `from`/`to` mapped to a
 * document position (`base` = the block's start position + 1). Pure and
 * self-contained so the incremental scan can re-run a single block without
 * re-walking the document. A code block never contributes (a marker there is
 * code, not a note).
 */
export function scanTextblock(block: ProseNode, base: number, customMarkers: readonly string[] = []): NoteItem[] {
    if (block.type.name === "code_block") { return []; }
    const out: NoteItem[] = [];
    // Text markers. Inline HTML atoms are masked to MASK in maskedBlockText, so
    // a marker can never be read out of a comment's raw text.
    for (const t of findTextMarkers(maskedBlockText(block), customMarkers)) {
        out.push({ from: base + t.start, to: base + t.end, kind: t.kind, marker: t.marker, label: t.label });
    }
    // Inline HTML-comment atoms, at their own child offsets.
    block.forEach((child, offset) => {
        if (child.type.name !== "html") { return; }
        const item = htmlCommentItem(child, base + offset);
        if (item) { out.push(item); }
    });
    return out.sort((a, b) => a.from - b.from);
}

/**
 * Scan the whole document for editor-note markers, document-ordered. Pure: it
 * reads the doc and returns rows, mutating nothing. `customMarkers` come from
 * `birta.notes.customMarkers`. For the per-keystroke hot path, prefer
 * `incrementalScanNotes` and fall back to this.
 */
export function scanNotes(doc: ProseNode, customMarkers: readonly string[] = []): NoteItem[] {
    const items: NoteItem[] = [];

    doc.descendants((node, pos) => {
        // A block-level HTML node (inline comment atoms live inside textblocks
        // and are handled by scanTextblock, which stops descent into them).
        if (node.type.name === "html") {
            const item = htmlCommentItem(node, pos);
            if (item) { items.push(item); }
            return false;
        }
        // Unchecked task checkboxes. Descend so a marker inside the item's blocks
        // (a `[TK]` in a to-do line) is still caught by the textblock branch.
        if (node.type.name === "list_item" && node.attrs?.["checked"] === false) {
            items.push({ from: pos + 1, to: pos + 1, kind: "task", marker: "task", label: taskLabel(node) });
            return true;
        }
        // A textblock's whole note contribution comes from scanTextblock; a
        // textblock holds no child BLOCKS and its inline HTML atoms are already
        // handled, so never descend.
        if (node.isTextblock) {
            for (const it of scanTextblock(node, pos + 1, customMarkers)) { items.push(it); }
            return false;
        }
        return true;
    });

    return items.sort((a, b) => a.from - b.from);
}

/**
 * The per-keystroke fast path: given the previous (doc, items) and the next doc,
 * reuse the cached items when the change is confined to one textblock — re-scan
 * just that block and shift the trailing anchors by the edit's delta — instead
 * of re-walking the whole document. Returns null when the change could have
 * touched note-bearing STRUCTURE (a block split/merge, a new block, or the first
 * line of a task item, whose label mirrors that text); the caller then falls
 * back to `scanNotes`. Pure.
 */
export function incrementalScanNotes(
    prevDoc: ProseNode,
    prevItems: readonly NoteItem[],
    nextDoc: ProseNode,
    customMarkers: readonly string[] = [],
): NoteItem[] | null {
    const edit = singleTextblockInlineEdit(prevDoc, nextDoc);
    if (!edit) { return null; }
    if (edit.kind === "identical") { return prevItems as NoteItem[]; }

    // An unchecked task item's row label is its FIRST block's text, so an inline
    // edit there changes a note the block-local rescan can't see. Bail to a full
    // scan for that narrow case (typing on a checkbox's first line).
    const container = nextDoc.resolve(edit.nextBlockPos).parent;
    if (container.type.name === "list_item"
        && container.attrs?.["checked"] === false
        && container.firstChild === edit.nextBlock) {
        return null;
    }

    const blockStart = edit.prevBlockPos;
    const blockEnd = edit.prevBlockPos + edit.prevBlock.nodeSize;
    const before = prevItems.filter((i) => i.to <= blockStart);
    const after = prevItems
        .filter((i) => i.from >= blockEnd)
        .map((i) => ({ ...i, from: i.from + edit.delta, to: i.to + edit.delta }));
    const within = scanTextblock(edit.nextBlock, edit.nextBlockPos + 1, customMarkers);
    return [...before, ...within, ...after].sort((a, b) => a.from - b.from);
}
