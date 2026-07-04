/**
 * shared/frontmatterTable.ts
 *
 * Pure frontmatter parsing helpers shared by the WebView panel
 * (webview/components/frontmatter) and the Extension side
 * (src/utils/frontmatterSuggestions). No DOM or messaging imports —
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

export type FmEntry = {
    key: string;
    value: string;
    /** Exact original line text (no trailing newline); present for entries parsed from the file.
     *  For list entries this is the `key:` (or full inline `key: [...]`) line. */
    origLine?: string;
    /** Present when the value is a list; `value` is unused then. */
    list?: FmList;
};

/** Splits a fenced frontmatter block into opening fence, inner text and closing fence. */
export function splitFences(raw: string): { prefix: string; inner: string; suffix: string } | null {
    const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)$/);
    if (!m) { return null; }
    return { prefix: m[1]!, inner: m[2]!, suffix: m[3]! };
}

/** Is `value` safe to keep as an unquoted plain YAML scalar? */
function isSafePlain(value: string): boolean {
    return /^[A-Za-z0-9_./-][A-Za-z0-9_./ +-]*$/.test(value) && !value.endsWith(" ");
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
 * Parses frontmatter into table entries when every construct is either a
 * `key: scalar` line or a simple list (inline flow `key: [a, b]`, a
 * multi-line flow sequence with one item per line, or block `- item` lines).
 * Returns null for anything richer — nested maps, comments, block scalars,
 * anchors, CRLF — which routes the panel to the raw editor instead.
 */
export function parseTabularFrontmatter(raw: string): FmEntry[] | null {
    if (raw.includes("\r")) { return null; }
    const fences = splitFences(raw);
    if (!fences) { return null; }
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
                items.push({ value: v, quote });
            }
            entries.push({
                key: key.trim(), value: "", origLine: line,
                list: { kind: "flow-inline", items, itemIndent: "", newItemQuote: majorityQuote(items) },
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
                    items.push({ value: v, origLine: l, quote });
                }
                if (closeLine === null || items.length === 0) { return null; }
                const itemIndent = items[0]!.origLine!.match(/^\s*/)![0];
                const trailingCommaAll = items.every((it) => /,\s*$/.test(it.origLine!));
                const commasExceptLast = items.slice(0, -1).every((it) => /,\s*$/.test(it.origLine!))
                    && !/,\s*$/.test(items[items.length - 1]!.origLine!);
                if (!trailingCommaAll && !commasExceptLast) { return null; } // inconsistent commas
                entries.push({
                    key: key.trim(), value: "", origLine: line,
                    list: {
                        kind: "flow-multi", items,
                        openLine: nextLine!, closeLine,
                        itemIndent, trailingCommaAll,
                        newItemQuote: majorityQuote(items),
                    },
                });
                i = j + 1;
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
                    items.push({ value: v, origLine: l, quote });
                }
                entries.push({
                    key: key.trim(), value: "", origLine: line,
                    list: { kind: "block", items, itemIndent: indent, newItemQuote: majorityQuote(items) },
                });
                i = j;
                continue;
            }

            // Plain empty scalar
            entries.push({ key: key.trim(), value: "", origLine: line });
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
