/**
 * shared/frontmatterTable.ts
 *
 * Pure frontmatter parsing helpers shared by the WebView panel
 * (webview/components/frontmatter) and the Extension side
 * (shared/frontmatterSuggestions.ts). No DOM or messaging imports —
 * everything here is plain string processing so both bundles can use it.
 */

export type FmListItem = {
    value: string;
    /** Exact original line text; present for items parsed from the file. */
    origLine?: string;
    /** Original quote style of the item (null = unquoted). */
    quote?: '"' | "'" | null;
};

export type FmList = {
    /** `key: [a, b]` on one line, a multi-line `[ ... ]`, or block `- item` lines. */
    kind: "flow-inline" | "flow-multi" | "block";
    items: FmListItem[];
    /** flow-multi only: the exact `[` / `]` lines. */
    openLine?: string;
    closeLine?: string;
    /** Indentation for (new) item lines. */
    itemIndent: string;
    /** flow-multi: whether every item line (including the last) ends with a comma. */
    trailingCommaAll?: boolean;
    /** Quote style for newly added items (majority style of existing ones). */
    newItemQuote: '"' | "'" | null;
};

/**
 * One `key: scalar` pair inside a nested value.
 *
 * `value` is the VERBATIM source text after the colon, quotes and all, exactly
 * like a flat entry's `value`. Nothing here re-quotes on the way out, so a leaf
 * the user never touched is emitted as the bytes it came in as, and one they
 * did edit is emitted as what they typed.
 */
export type FmNestedLeaf = {
    key: string;
    value: string;
    /** Exact original line. Absent on a flow leaf: one line carries every leaf of its item. */
    origLine?: string;
};

/** One mapping inside a nested value: indented `k: v` lines, or a single `{ ... }`. */
export type FmNestedItem = {
    style: "block" | "flow";
    leaves: FmNestedLeaf[];
    /** flow items only: the exact line carrying the whole mapping. */
    origLine?: string;
};

/**
 * A nested value the table renders natively rather than dropping the whole
 * block to the raw editor: a sequence of mappings (`sources:` in the Open
 * Knowledge Format), a single nested mapping, or a one-line flow mapping.
 *
 * Depth stops here by construction. A leaf whose value would open a third
 * level is refused by `isNestedLeafValue`, so every shape in this model is
 * exactly two levels deep and its line spans stay contiguous.
 */
export type FmNested = {
    /** seq: `key:` then `- ` items. map: `key:` then indented pairs. flow: `key: { ... }`. */
    kind: "seq" | "map" | "flow";
    /** `map` and `flow` hold exactly one item. */
    items: FmNestedItem[];
    /** Indentation of a sequence's `- ` lines, or of a map's pair lines. */
    itemIndent: string;
};

export type FmEntry = {
    key: string;
    value: string;
    /** Exact original line text (no trailing newline); present for entries parsed from the file.
     *  For list entries this is the `key:` (or full inline `key: [...]`) line. */
    origLine?: string;
    /** Present when the value is a list; `value` is unused then. */
    list?: FmList;
    /** Present when the value is a nested mapping or sequence of mappings; `value` is unused then. */
    nested?: FmNested;
    /**
     * The exact lines this entry occupied in the source, as parsed.
     *
     * The serializer finds an entry by matching its source lines, so the span
     * has to be what the FILE holds, not what the entry now holds: an entry
     * whose span is re-derived from its current items stops matching the
     * moment an item is removed, and the field is then re-emitted at the end
     * of the block instead of where the author put it.
     */
    origSpan?: string[];
};

/** The fence style a frontmatter block is written in: YAML `---` or TOML `+++`. */
export type FmDelimiter = "---" | "+++";

export type FmFences = {
    prefix: string;
    inner: string;
    suffix: string;
    /** Which dialect the block is fenced in. Read this instead of re-sniffing `raw`. */
    delimiter: FmDelimiter;
};

/**
 * Splits a fenced frontmatter block into opening fence, inner text and closing
 * fence. The closing fence must repeat the OPENING delimiter (the backreference
 * enforces it), matching `extractFrontmatter`: a block opened `+++` and closed
 * `---` is not a block, so no caller can be handed a mismatched pair to rewrite.
 */
export function splitFences(raw: string): FmFences | null {
    const m = raw.match(/^((---|\+\+\+)\r?\n)([\s\S]*?)(\r?\n\2\r?\n?)$/);
    if (!m) { return null; }
    return { prefix: m[1]!, inner: m[3]!, suffix: m[4]!, delimiter: m[2] as FmDelimiter };
}

/** Is `value` safe to keep as an unquoted plain YAML scalar? */
function isSafePlain(value: string): boolean {
    // The first character must not be a YAML indicator: `-` would turn a block
    // list item into a nested sequence (`- - x`) and is invalid at the start of
    // a plain scalar in flow context; `?` and `:` are mapping indicators (they
    // are excluded here by omission from the leading character class, exactly
    // like `-`). Such values are force-quoted by quoteItem instead.
    return /^[A-Za-z0-9_./][A-Za-z0-9_./ +-]*$/.test(value) && !value.endsWith(" ");
}

/** Quote `value` in the given style (falling back to double quotes when the
 *  style cannot represent it losslessly). */
export function quoteItem(value: string, quote: '"' | "'" | null): string {
    if (quote === "'" && !value.includes("'")) { return `'${value}'`; }
    if (quote === null && isSafePlain(value)) { return value; }
    return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Does this scalar pass the same safety rules the flat classifier applies? */
function isSafeScalarValue(value: string): boolean {
    if (value === "") { return true; }
    const v0 = value[0]!;
    if ("|>&*[{#!%@`".includes(v0)) { return false; }
    if (/\s#/.test(value)) { return false; }
    if (v0 === '"' || v0 === "'") {
        return value.length >= 2 && value.endsWith(v0);
    }
    return true;
}

// One flow-sequence item on its own line: indent, a quoted or plain token,
// an optional trailing comma — nothing else.
export const FLOW_ITEM_RE = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,[\]{}#"'][^,[\]{}#]*?)\s*(,?)\s*$/;

export function parseQuotedToken(token: string): { value: string; quote: '"' | "'" | null } {
    if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
        return { value: token.slice(1, -1).replace(/\\(.)/g, "$1"), quote: '"' };
    }
    if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) {
        return { value: token.slice(1, -1), quote: "'" };
    }
    return { value: token.trim(), quote: null };
}

/** Majority quote style among items (for newly added ones). */
function majorityQuote(items: FmListItem[]): '"' | "'" | null {
    const counts = new Map<string, number>();
    for (const it of items) { counts.set(String(it.quote), (counts.get(String(it.quote)) ?? 0) + 1); }
    let best: '"' | "'" | null = '"';
    let bestCount = -1;
    for (const [q, c] of counts) {
        if (c > bestCount) { best = q === "null" ? null : (q as '"' | "'"); bestCount = c; }
    }
    return items.length === 0 ? '"' : best;
}

/** Split a single-line flow sequence body on top-level commas, respecting quotes. */
function splitInlineFlow(body: string): string[] | null {
    const parts: string[] = [];
    let cur = "";
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i]!;
        if (quote) {
            cur += ch;
            if (quote === '"' && ch === "\\") { cur += body[++i] ?? ""; continue; }
            if (ch === quote) { quote = null; }
        } else if (ch === '"' || ch === "'") {
            quote = ch; cur += ch;
        } else if ("[]{}#".includes(ch)) {
            return null; // nested flow / comment → not tabular
        } else if (ch === ",") {
            parts.push(cur); cur = "";
        } else {
            cur += ch;
        }
    }
    if (quote) { return null; } // unterminated quote
    parts.push(cur);
    return parts;
}

/**
 * Is `value` one a nested leaf can hold and re-emit verbatim?
 *
 * Empty is refused because an empty value is how YAML OPENS another level, so
 * accepting it would let an edit turn a leaf into a nested block the model
 * cannot describe. `{` is refused for the same reason one level down, a line
 * break because a leaf owns one line, and a leading `- ` because that spells a
 * sequence rather than a scalar. A single-line flow sequence (`receipt:
 * [job_id, executed_sql, result]`) is allowed and kept as text: it round-trips
 * as its own bytes.
 *
 * The parser cannot produce any of those, having split on newlines and matched
 * the shapes already. They are here for the EDIT path, which is the only place
 * a leaf is handed text nobody parsed.
 */
export function isNestedLeafValue(value: string): boolean {
    if (value === "") { return false; }
    if (/[\r\n]/.test(value)) { return false; }
    if (value === "-" || value.startsWith("- ")) { return false; }
    const v0 = value[0]!;
    if ("|>&*{#!%@`".includes(v0)) { return false; }
    if (/\s#/.test(value)) { return false; }
    if (v0 === '"' || v0 === "'") {
        return value.length >= 2 && value.endsWith(v0);
    }
    if (v0 === "[") {
        return value.endsWith("]") && splitInlineFlow(value.slice(1, -1)) !== null;
    }
    return true;
}

/** Splits one `key: value` pair out of a nested line's text (indentation and any `- ` already stripped). */
function parseNestedPair(text: string): FmNestedLeaf | null {
    const colonIdx = text.indexOf(":");
    if (colonIdx <= 0) { return null; }
    const next = text[colonIdx + 1];
    if (next !== undefined && next !== " " && next !== "\t") { return null; }
    const key = text.slice(0, colonIdx);
    if (key.trim() === "" || /["'#]/.test(key)) { return null; }
    const value = text.slice(colonIdx + 1).trim();
    if (!isNestedLeafValue(value)) { return null; }
    return { key: key.trim(), value };
}

/** Parses a one-line `{ a: b, c: d }` mapping into its leaves. */
function parseFlowMap(text: string): FmNestedLeaf[] | null {
    const t = text.trim();
    if (!t.startsWith("{") || !t.endsWith("}") || t.length < 2) { return null; }
    const body = t.slice(1, -1);
    if (body.trim() === "") { return null; } // nothing to render as a row
    const parts = splitInlineFlow(body);
    if (parts === null) { return null; }
    const leaves: FmNestedLeaf[] = [];
    for (const part of parts) {
        const pair = parseNestedPair(part.trim());
        if (!pair) { return null; }
        leaves.push(pair);
    }
    return leaves;
}

/** Spells a flow mapping from its leaves. */
export function flowMapText(leaves: FmNestedLeaf[]): string {
    return `{ ${leaves.map((l) => `${l.key}: ${l.value}`).join(", ")} }`;
}

/**
 * Would `next` survive being written into this leaf?
 *
 * A block leaf owns its whole line, so the scalar rules are the whole answer.
 * A flow leaf shares one line with its siblings, where a comma or a brace ends
 * the value early, so the candidate mapping is re-spelled and re-parsed: the
 * value is accepted only when the round trip hands every leaf back unchanged.
 */
export function acceptsNestedValue(item: FmNestedItem, leafIdx: number, next: string): boolean {
    if (!isNestedLeafValue(next)) { return false; }
    if (item.style === "block") { return true; }
    const candidate = item.leaves.map((l, k) => (k === leafIdx ? { ...l, value: next } : l));
    const parsed = parseFlowMap(flowMapText(candidate));
    return parsed !== null
        && parsed.length === candidate.length
        && parsed.every((p, k) => p.key === candidate[k]!.key && p.value === candidate[k]!.value);
}

/**
 * Does an unquoted list-item token spell a mapping (`- id: x`) rather than a
 * string?
 *
 * The question is the colon alone, never whether the mapping is one this model
 * can describe: `- b:` is a null-valued mapping the nested parser refuses, and
 * treating it as the string "b:" is the same loss as for `- id: x`. A quoted
 * token is a string whatever it contains.
 */
function isMappingToken(token: string, quote: '"' | "'" | null): boolean {
    if (quote !== null) { return false; }
    const colonIdx = token.indexOf(":");
    if (colonIdx <= 0) { return false; }
    const next = token[colonIdx + 1];
    return next === undefined || next === " " || next === "\t";
}

/**
 * Parses the block under a `key:` line into a nested value, starting at
 * `start`. Returns null for anything outside the two-level model, which routes
 * the whole frontmatter block to the raw editor as before.
 *
 * A sequence may sit at the key's own column (`sources:` then `- id: a`) or be
 * indented past it, the two spellings the block-list parser already accepts;
 * a mapping has only the indented spelling, because an unindented `k: v` line
 * under a key is a SIBLING field and reading it as a leaf would swallow the
 * rest of the block.
 *
 * A blank line ENDS the block rather than failing it, so the trailing blank
 * between two fields survives; a blank in the middle leaves the rest of the
 * indented lines to the caller, which refuses stray indentation.
 */
function parseNestedBlock(lines: string[], start: number): { nested: FmNested; next: number } | null {
    const first = lines[start];
    if (first === undefined || first.trim() === "") { return null; }
    const indent = first.match(/^[ \t]*/)![0];

    // Sequence of mappings: `- k: v` items, each optionally continued by lines
    // aligned past the marker.
    const dashPrefix = `${indent}- `;
    if (first.startsWith(dashPrefix)) {
        const leafPrefix = `${indent}  `;
        const items: FmNestedItem[] = [];
        let j = start;
        while (j < lines.length) {
            const line = lines[j]!;
            if (line.trim() === "") { break; }
            if (!line.startsWith(dashPrefix)) {
                // Indented past this sequence but not one of its items: the
                // shape is outside the model. An unindented line is the next
                // field, so the sequence simply ends there.
                if (/^[ \t]/.test(line)) { return null; }
                break; // dedent: the sequence is over
            }
            const head = line.slice(dashPrefix.length);
            if (head.startsWith("{")) {
                const leaves = parseFlowMap(head);
                if (!leaves) { return null; }
                items.push({ style: "flow", leaves, origLine: line });
                j++;
                continue;
            }
            const head0 = parseNestedPair(head);
            if (!head0) { return null; }
            const leaves: FmNestedLeaf[] = [{ ...head0, origLine: line }];
            j++;
            while (j < lines.length) {
                const cont = lines[j]!;
                if (cont.trim() === "" || !cont.startsWith(leafPrefix)) { break; }
                const rest = cont.slice(leafPrefix.length);
                if (/^[ \t]/.test(rest)) { return null; } // a third level
                const pair = parseNestedPair(rest);
                if (!pair) { return null; }
                leaves.push({ ...pair, origLine: cont });
                j++;
            }
            items.push({ style: "block", leaves });
        }
        if (items.length === 0) { return null; }
        return { nested: { kind: "seq", items, itemIndent: indent }, next: j };
    }

    // Nested mapping: indented `k: v` lines, all at one indentation. Without
    // indentation there is nothing to tell a leaf from the next field.
    if (indent === "") { return null; }
    const leaves: FmNestedLeaf[] = [];
    let j = start;
    while (j < lines.length) {
        const line = lines[j]!;
        if (line.trim() === "" || !line.startsWith(indent)) { break; }
        const rest = line.slice(indent.length);
        if (/^[ \t]/.test(rest)) { return null; } // ragged or deeper indentation
        const pair = parseNestedPair(rest);
        if (!pair) { return null; }
        leaves.push({ ...pair, origLine: line });
        j++;
    }
    if (leaves.length === 0) { return null; }
    return { nested: { kind: "map", items: [{ style: "block", leaves }], itemIndent: indent }, next: j };
}

/**
 * Parses frontmatter into table entries when every construct is a
 * `key: scalar` line, a simple list (inline flow `key: [a, b]`, a multi-line
 * flow sequence with one item per line, or block `- item` lines), or a nested
 * value two levels deep: a sequence of mappings, a nested mapping, or a
 * one-line flow mapping. Returns null for anything richer — a third level,
 * comments, block scalars, anchors, CRLF — which routes the panel to the raw
 * editor instead.
 *
 * TOML blocks always take that same route. Every rule below is a YAML rule:
 * the `key:` split, and the quoting `quoteItem` and `isSafePlain` apply on the
 * way back out. A TOML block that happened to satisfy them would be re-emitted
 * as YAML into a file whose fences say TOML, so the dialect is refused here
 * rather than relied on to fail line by line.
 */
export function parseTabularFrontmatter(raw: string): FmEntry[] | null {
    if (raw.includes("\r")) { return null; }
    const fences = splitFences(raw);
    if (!fences) { return null; }
    if (fences.delimiter !== "---") { return null; }
    const lines = fences.inner === "" ? [] : fences.inner.split("\n");
    const entries: FmEntry[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;
        if (line.trim() === "") { i++; continue; }
        if (/^[ \t]/.test(line)) { return null; } // stray indentation
        const first = line[0]!;
        if (first === "#" || first === "?" || first === "%" || first === "!") { return null; }
        if (line === "-" || line.startsWith("- ")) { return null; } // list item without a key
        const colonIdx = line.indexOf(":");
        if (colonIdx <= 0) { return null; }
        const next = line[colonIdx + 1];
        if (next !== undefined && next !== " " && next !== "\t") { return null; }
        const key = line.slice(0, colonIdx);
        if (key.trim() === "" || /["'#]/.test(key)) { return null; }
        const value = line.slice(colonIdx + 1).trim();

        // Inline flow sequence: `key: [a, "b"]`
        if (value.startsWith("[")) {
            if (!value.endsWith("]")) { return null; }
            const body = value.slice(1, -1);
            const rawParts = body.trim() === "" ? [] : splitInlineFlow(body);
            if (rawParts === null) { return null; }
            const items: FmListItem[] = [];
            for (const part of rawParts) {
                const token = part.trim();
                if (token === "") { return null; } // empty/duplicate commas
                const { value: v, quote } = parseQuotedToken(token);
                if (quote === null && !isSafeScalarValue(v)) { return null; }
                // `[a: b]` is a single-pair mapping, not the string "a: b". The
                // chip list would re-emit it quoted and change its type, so the
                // block goes to the raw editor rather than be re-spelled.
                if (isMappingToken(v, quote)) { return null; }
                items.push({ value: v, quote });
            }
            entries.push({
                key: key.trim(), value: "", origLine: line,
                list: { kind: "flow-inline", items, itemIndent: "", newItemQuote: majorityQuote(items) },
                origSpan: [line],
            });
            i++;
            continue;
        }

        if (value === "") {
            const nextLine = lines[i + 1];

            // Multi-line flow sequence: `key:` / `[` / one item per line / `]`
            const openMatch = nextLine?.match(/^(\s*)\[\s*$/);
            if (openMatch) {
                const items: FmListItem[] = [];
                let j = i + 2;
                let closeLine: string | null = null;
                for (; j < lines.length; j++) {
                    const l = lines[j]!;
                    if (/^\s*\]\s*$/.test(l)) { closeLine = l; break; }
                    const m = l.match(FLOW_ITEM_RE);
                    if (!m) { return null; }
                    const { value: v, quote } = parseQuotedToken(m[2]!);
                    if (quote === null && !isSafeScalarValue(v)) { return null; }
                    if (isMappingToken(v, quote)) { return null; } // a mapping, not a string
                    items.push({ value: v, origLine: l, quote });
                }
                if (closeLine === null) { return null; }
                // Empty flow-multi (`key:` / `[` / `]`) is what the panel
                // serializes after the last item is deleted; keep it tabular
                // (items: []) so the list stays editable instead of dropping
                // the whole panel to raw mode. New items get the conventional
                // two-space indent past the `[` and a trailing comma.
                let itemIndent = openMatch[1]! + "  ";
                let trailingCommaAll = true;
                if (items.length > 0) {
                    itemIndent = items[0]!.origLine!.match(/^\s*/)![0];
                    trailingCommaAll = items.every((it) => /,\s*$/.test(it.origLine!));
                    const commasExceptLast = items.slice(0, -1).every((it) => /,\s*$/.test(it.origLine!))
                        && !/,\s*$/.test(items[items.length - 1]!.origLine!);
                    if (!trailingCommaAll && !commasExceptLast) { return null; } // inconsistent commas
                }
                entries.push({
                    key: key.trim(), value: "", origLine: line,
                    list: {
                        kind: "flow-multi", items,
                        openLine: nextLine!, closeLine,
                        itemIndent, trailingCommaAll,
                        newItemQuote: majorityQuote(items),
                    },
                    origSpan: lines.slice(i, j + 1),
                });
                i = j + 1;
                continue;
            }

            // Nested value: a sequence of mappings, or a nested mapping. Tried
            // BEFORE the block sequence below, because `- id: x` is a mapping
            // and the chip list would keep it as the string "id: x".
            const nested = parseNestedBlock(lines, i + 1);
            if (nested) {
                entries.push({
                    key: key.trim(), value: "", origLine: line,
                    nested: nested.nested, origSpan: lines.slice(i, nested.next),
                });
                i = nested.next;
                continue;
            }

            // Block sequence: `key:` / `- item` lines (consistent indentation)
            const blockMatch = nextLine?.match(/^(\s*)- (.*)$/);
            if (blockMatch) {
                const indent = blockMatch[1]!;
                const items: FmListItem[] = [];
                let j = i + 1;
                for (; j < lines.length; j++) {
                    const l = lines[j]!;
                    const m = l.match(/^(\s*)- (.*)$/);
                    if (!m) { break; }
                    if (m[1] !== indent) { return null; } // ragged indentation
                    const token = m[2]!.trim();
                    if (token === "" || token.startsWith("- ")) { return null; }
                    const { value: v, quote } = parseQuotedToken(token);
                    if (quote === null && !isSafeScalarValue(v)) { return null; }
                    if (quote === null && /\s#/.test(v)) { return null; }
                    // A list that mixes strings with mappings reaches here (an
                    // all-mapping one was taken by parseNestedBlock above). The
                    // chip list would re-emit the mapping quoted, turning it
                    // into a string, so the block takes the raw route instead.
                    if (isMappingToken(v, quote)) { return null; }
                    items.push({ value: v, origLine: l, quote });
                }
                entries.push({
                    key: key.trim(), value: "", origLine: line,
                    list: { kind: "block", items, itemIndent: indent, newItemQuote: majorityQuote(items) },
                    origSpan: lines.slice(i, j),
                });
                i = j;
                continue;
            }

            // Plain empty scalar
            entries.push({ key: key.trim(), value: "", origLine: line });
            i++;
            continue;
        }

        // One-line flow mapping: `key: { a: b, c: d }`
        if (value.startsWith("{")) {
            const leaves = parseFlowMap(value);
            if (!leaves) { return null; }
            entries.push({
                key: key.trim(), value: "", origLine: line,
                nested: { kind: "flow", items: [{ style: "flow", leaves, origLine: line }], itemIndent: "" },
                origSpan: [line],
            });
            i++;
            continue;
        }

        // Plain scalar (same safety rules as the flat classifier)
        if (!isSafeScalarValue(value)) { return null; }
        entries.push({ key: key.trim(), value, origLine: line });
        i++;
    }
    return entries;
}
