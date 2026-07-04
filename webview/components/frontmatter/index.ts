/**
 * components/frontmatter/index.ts
 *
 * Renders and manages the editable YAML frontmatter panel.
 *
 * Lossless-first design (fixes data loss, Linear MAR-6):
 * - A conservative line classifier (`isFlatFrontmatter`) decides whether the
 *   block is a "flat" mapping of `key: scalar` lines.
 * - Flat blocks get the key/value table UX; serialization preserves every
 *   untouched line byte-for-byte and only rewrites lines whose entry changed.
 * - Anything else (nested maps, lists, block scalars, comments, anchors,
 *   colon-less lines, CRLF files, ...) is edited in a raw monospace textarea
 *   whose content is written back verbatim. No line is ever dropped.
 */

import { IconChevronDown, IconChevronUp, IconPlus, IconX } from "../../ui/icons";
import { t } from "../../i18n";
import { getWebviewState, notifyFrontmatterUpdate, setWebviewState } from "../../messaging";

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
function splitFences(raw: string): { prefix: string; inner: string; suffix: string } | null {
    const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)$/);
    if (!m) { return null; }
    return { prefix: m[1]!, inner: m[2]!, suffix: m[3]! };
}

/**
 * Conservative structural check: returns true only when every non-empty inner
 * line is a plain `key: scalar` pair that the table UI can round-trip without
 * loss. When in doubt, returns false so the raw editor is used instead.
 */
export function isFlatFrontmatter(raw: string): boolean {
    // CRLF files are handled verbatim in raw mode to avoid line-ending rewrites.
    if (raw.includes("\r")) { return false; }
    const fences = splitFences(raw);
    if (!fences) { return false; }
    const lines = fences.inner === "" ? [] : fences.inner.split("\n");
    for (const line of lines) {
        if (line.trim() === "") { continue; } // blank lines are preserved by the serializer
        if (/^[ \t]/.test(line)) { return false; } // indentation → nested structure
        const first = line[0]!;
        if (first === "#") { return false; } // comment line
        if (line === "-" || line.startsWith("- ")) { return false; } // list item
        if (first === "?" || first === "%" || first === "!") { return false; } // complex key / directive / tag
        const colonIdx = line.indexOf(":");
        if (colonIdx <= 0) { return false; } // colon-less line or empty key
        const next = line[colonIdx + 1];
        if (next !== undefined && next !== " " && next !== "\t") { return false; } // `a:b` is a scalar, not a mapping
        const key = line.slice(0, colonIdx);
        if (key.trim() === "" || /["'#]/.test(key)) { return false; } // quoted/exotic keys → raw mode
        const value = line.slice(colonIdx + 1).trim();
        if (value === "") { continue; } // empty scalar is safe: nested content would be indented or a list
        const v0 = value[0]!;
        if ("|>&*[{#!%@`".includes(v0)) { return false; } // block scalar / anchor / alias / flow / comment / tag
        if (/\s#/.test(value)) { return false; } // trailing comment
        if (v0 === '"' || v0 === "'") {
            // Quoted value must open and close on the same line.
            if (value.length < 2 || !value.endsWith(v0)) { return false; }
        }
    }
    return true;
}

/** Parses a flat YAML frontmatter block into key-value entries, keeping each original line. */
export function parseFrontmatter(raw: string): FmEntry[] {
    return raw
        .split('\n')
        .filter(line => !line.match(/^---/) && line.includes(':'))
        .map(line => {
            const colonIdx = line.indexOf(':');
            return {
                key: line.slice(0, colonIdx).trim(),
                value: line.slice(colonIdx + 1).trim(),
                origLine: line,
            };
        })
        .filter(({ key }) => key.length > 0);
}

// ─── Tabular frontmatter (scalars + simple lists) ───────────────────────────

/** Is `value` safe to keep as an unquoted plain YAML scalar? */
function isSafePlain(value: string): boolean {
    return /^[A-Za-z0-9_./-][A-Za-z0-9_./ +-]*$/.test(value) && !value.endsWith(" ");
}

/** Quote `value` in the given style (falling back to double quotes when the
 *  style cannot represent it losslessly). */
function quoteItem(value: string, quote: '"' | "'" | null): string {
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
const FLOW_ITEM_RE = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,[\]{}#"'][^,[\]{}#]*?)\s*(,?)\s*$/;

function parseQuotedToken(token: string): { value: string; quote: '"' | "'" | null } {
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

/** The exact original lines an entry occupies in the source block. */
function entrySpan(entry: FmEntry): string[] | null {
    if (entry.origLine === undefined) { return null; }
    if (!entry.list) { return [entry.origLine]; }
    const { list } = entry;
    if (list.kind === "flow-inline") { return [entry.origLine]; }
    const itemLines = list.items.map((it) => it.origLine);
    if (itemLines.some((l) => l === undefined)) { return null; }
    if (list.kind === "flow-multi") {
        if (list.openLine === undefined || list.closeLine === undefined) { return null; }
        return [entry.origLine, list.openLine, ...(itemLines as string[]), list.closeLine];
    }
    return [entry.origLine, ...(itemLines as string[])];
}

/** Rebuilds an entry's lines, emitting original bytes wherever nothing changed. */
function reconstructEntryLines(entry: FmEntry): string[] {
    if (!entry.list) { return [formatEntryLine(entry)]; }
    const { list } = entry;
    const keyLine = entry.origLine !== undefined
        && entry.origLine.slice(0, entry.origLine.indexOf(":")).trim() === entry.key
        && list.kind !== "flow-inline"
        ? entry.origLine
        : `${entry.key}:`;

    if (list.kind === "flow-inline") {
        // Single line: reuse the original when the key and every item survive
        // unchanged, otherwise rebuild `key: [a, b]`.
        const body = list.items.map((it) => quoteItem(it.value, it.quote ?? list.newItemQuote)).join(", ");
        const rebuilt = `${entry.key}: [${body}]`;
        if (entry.origLine !== undefined) {
            const reparsed = parseTabularFrontmatter(`---\n${entry.origLine}\n---\n`);
            const orig = reparsed?.[0];
            if (orig?.list && orig.key === entry.key
                && orig.list.items.length === list.items.length
                && orig.list.items.every((it, k) => it.value === list.items[k]!.value)) {
                return [entry.origLine];
            }
        }
        return [rebuilt];
    }

    if (list.kind === "flow-multi") {
        const openLine = list.openLine ?? `${list.itemIndent.slice(0, Math.max(0, list.itemIndent.length - 2))}[`;
        const closeLine = list.closeLine ?? openLine.replace("[", "]");
        const lines = [keyLine, openLine];
        list.items.forEach((it, k) => {
            const needsComma = list.trailingCommaAll === true || k < list.items.length - 1;
            const rebuilt = list.itemIndent + quoteItem(it.value, it.quote ?? list.newItemQuote) + (needsComma ? "," : "");
            // Keep the original bytes when they already say exactly this
            // (preserves exotic-but-harmless spacing on untouched items).
            lines.push(it.origLine !== undefined && normalizedFlowItem(it.origLine) === normalizedFlowItem(rebuilt)
                ? it.origLine
                : rebuilt);
        });
        lines.push(closeLine);
        return lines;
    }

    // block list
    const lines = [keyLine];
    for (const it of list.items) {
        const rebuilt = `${list.itemIndent}- ${quoteItem(it.value, it.quote ?? list.newItemQuote)}`;
        lines.push(it.origLine !== undefined && it.origLine.trim() === rebuilt.trim() && parseQuotedToken(it.origLine.replace(/^\s*- /, "").trim()).value === it.value
            ? it.origLine
            : rebuilt);
    }
    return lines;
}

/** Comparable form of a flow item line: token + comma presence. */
function normalizedFlowItem(line: string): string {
    const m = line.match(FLOW_ITEM_RE);
    if (!m) { return line; }
    return `${parseQuotedToken(m[2]!).value} ${m[3] === "," ? 1 : 0}`;
}

/** Returns true when the entry's key/value still match what its original line parses to. */
function isEntryUnchanged(entry: FmEntry): boolean {
    if (entry.origLine === undefined) { return false; }
    const colonIdx = entry.origLine.indexOf(':');
    if (colonIdx === -1) { return false; }
    return entry.origLine.slice(0, colonIdx).trim() === entry.key
        && entry.origLine.slice(colonIdx + 1).trim() === entry.value;
}

/** Formats one entry as a YAML line, preserving the original key text and colon spacing when possible. */
function formatEntryLine(entry: FmEntry): string {
    if (entry.origLine !== undefined) {
        const colonIdx = entry.origLine.indexOf(':');
        if (colonIdx !== -1 && entry.origLine.slice(0, colonIdx).trim() === entry.key) {
            // Only the value changed: keep the original `key:` prefix and its spacing style.
            const spacing = entry.origLine.slice(colonIdx + 1).match(/^[ \t]*/)?.[0] || ' ';
            return entry.origLine.slice(0, colonIdx + 1) + spacing + entry.value;
        }
    }
    return `${entry.key}: ${entry.value}`;
}

/**
 * Serializes entries back to a fenced YAML block.
 * When `originalRaw` is provided (the flat block the entries were parsed from),
 * untouched lines — including blank lines and the fence style — are preserved
 * byte-for-byte; only lines whose entry actually changed are rewritten.
 */
export function serializeFrontmatter(entries: FmEntry[], originalRaw?: string): string {
    const surviving = entries.filter(e => e.key.length > 0);
    if (surviving.length === 0) { return ""; }

    const fences = originalRaw !== undefined ? splitFences(originalRaw) : null;
    if (fences) {
        const innerLines = fences.inner === "" ? [] : fences.inner.split("\n");
        const remaining = [...surviving];
        const out: string[] = [];
        let i = 0;
        while (i < innerLines.length) {
            const line = innerLines[i]!;
            if (line.trim() === "") { out.push(line); i++; continue; } // keep blank lines verbatim
            // A surviving entry whose original span starts on this line?
            const idx = remaining.findIndex((e) => {
                const span = entrySpan(e);
                return span !== null
                    && span[0] === line
                    && span.every((s, k) => innerLines[i + k] === s);
            });
            if (idx === -1) { i++; continue; } // line belonged to a deleted entry
            const entry = remaining.splice(idx, 1)[0]!;
            const span = entrySpan(entry)!;
            if (!entry.list && isEntryUnchanged(entry)) {
                out.push(line);
            } else {
                out.push(...reconstructEntryLines(entry));
            }
            i += span.length;
        }
        // Newly added rows (and any entry that lost its original lines) go at the end.
        for (const entry of remaining) { out.push(...reconstructEntryLines(entry)); }
        return fences.prefix + out.join("\n") + fences.suffix;
    }

    return `---\n${surviving.flatMap(reconstructEntryLines).join("\n")}\n---\n`;
}

/** Current panel data (module-level state) */
let currentFmEntries: FmEntry[] = [];
/** The raw frontmatter block the panel was rendered from (basis for lossless serialization). */
let currentFmRaw = "";

/** Reads the persisted collapsed state of the frontmatter panel. */
function isFmCollapsed(): boolean {
    return getWebviewState()?.['fmCollapsed'] === true;
}

/** Persists the collapsed state so it survives tab switches and reloads. */
function setFmCollapsed(collapsed: boolean): void {
    setWebviewState({ ...(getWebviewState() ?? {}), fmCollapsed: collapsed });
}

/** Applies the collapsed state to the panel and updates the toggle button icon/label. */
function applyFmCollapsed(panel: HTMLElement, toggleBtn: HTMLElement, collapsed: boolean): void {
    panel.classList.toggle('collapsed', collapsed);
    toggleBtn.innerHTML = collapsed
        ? `${IconChevronDown} <span>${t('Show metadata')}</span>`
        : `${IconChevronUp} <span>${t('Hide metadata')}</span>`;
}

/** Syncs the edited table back to the Extension. */
function commitFrontmatterChange(): void {
    const raw = serializeFrontmatter(currentFmEntries, currentFmRaw);
    notifyFrontmatterUpdate(raw);
    // If everything was deleted, remove the panel
    if (currentFmEntries.length === 0) {
        const existing = document.getElementById('frontmatter-panel');
        existing?.remove();
        const editorEl = document.getElementById('editor');
        if (editorEl) { editorEl.style.paddingTop = ''; }
    }
}

/** Binds editing behavior to a contenteditable td. */
function bindFmCell(
    td: HTMLElement,
    entry: FmEntry,
    field: 'key' | 'value',
    tbody: HTMLElement,
    panel: HTMLElement,
): void {
    td.contentEditable = 'true';
    td.textContent = entry[field];
    td.dataset['orig'] = entry[field];
    td.dataset['placeholder'] = field === 'key' ? 'key' : 'value';

    // Enter commits (Shift+Enter allows a newline)
    td.addEventListener('keydown', (e) => {
        if (e.isComposing) { return; }
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            td.blur();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            td.textContent = td.dataset['orig'] ?? '';
            td.blur();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            td.blur();
            const idx = currentFmEntries.indexOf(entry);
            if (field === 'key') {
                // Move to the value cell of the same row
                const valTd = td.nextElementSibling as HTMLElement | null;
                if (valTd?.contentEditable === 'true') { valTd.focus(); }
            } else {
                // Move to the next row's key cell, or add a new row
                const nextRow = tbody.children[idx + 1] as HTMLElement | undefined;
                if (nextRow) {
                    const nextKeyTd = nextRow.querySelector('.fm-key') as HTMLElement | null;
                    nextKeyTd?.focus();
                } else {
                    addNewRow(tbody, panel);
                }
            }
        }
    });

    td.addEventListener('blur', () => {
        const newVal = (td.textContent ?? '').trim();
        if (field === 'key' && newVal.length === 0) {
            // Keys must not be empty; restore the previous value
            td.textContent = td.dataset['orig'] ?? '';
            return;
        }
        if (newVal !== entry[field]) {
            entry[field] = newVal;
            commitFrontmatterChange();
        }
        td.dataset['orig'] = entry[field];
    });
}

/** Builds one editable list chip (click to edit, × to remove, empty commit removes). */
function createFmChip(
    item: FmListItem,
    entry: FmEntry,
    tbody: HTMLElement,
    panel: HTMLElement,
): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'fm-chip';

    const text = document.createElement('span');
    text.className = 'fm-chip-text';
    text.textContent = item.value;
    text.contentEditable = 'true';
    text.spellcheck = false;
    text.dataset['orig'] = item.value;

    text.addEventListener('keydown', (e) => {
        if (e.isComposing) { return; }
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            text.blur();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            text.textContent = text.dataset['orig'] ?? '';
            text.blur();
        }
    });
    text.addEventListener('blur', () => {
        const newVal = (text.textContent ?? '').trim();
        if (newVal === item.value) {
            // A freshly added, still-empty chip is discarded on blur.
            if (newVal === '' && item.origLine === undefined) {
                entry.list!.items = entry.list!.items.filter((it) => it !== item);
                rebuildFmTable(tbody, panel);
            }
            return;
        }
        if (newVal === '') {
            entry.list!.items = entry.list!.items.filter((it) => it !== item);
        } else {
            item.value = newVal;
        }
        commitFrontmatterChange();
        rebuildFmTable(tbody, panel);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'fm-chip-remove';
    removeBtn.innerHTML = IconX;
    removeBtn.title = t('Delete');
    removeBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        entry.list!.items = entry.list!.items.filter((it) => it !== item);
        commitFrontmatterChange();
        rebuildFmTable(tbody, panel);
    });

    chip.appendChild(text);
    chip.appendChild(removeBtn);
    return chip;
}

/** Fills a value cell with the chip-list UI for a list-valued entry. */
function bindFmListCell(
    td: HTMLElement,
    entry: FmEntry,
    tbody: HTMLElement,
    panel: HTMLElement,
): void {
    td.classList.add('fm-list');
    const chips = document.createElement('div');
    chips.className = 'fm-chips';
    for (const item of entry.list!.items) {
        chips.appendChild(createFmChip(item, entry, tbody, panel));
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'fm-chip-add';
    addBtn.innerHTML = IconPlus;
    addBtn.title = t('Add item');
    addBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const item: FmListItem = { value: '' };
        entry.list!.items.push(item);
        const chip = createFmChip(item, entry, tbody, panel);
        chips.appendChild(chip);
        (chip.querySelector('.fm-chip-text') as HTMLElement | null)?.focus();
    });
    chips.appendChild(addBtn);
    td.appendChild(chips);
}

/** Creates one editable table row (contenteditable td, direct typing). */
function createFmRow(entry: FmEntry, index: number, tbody: HTMLElement, panel: HTMLElement): HTMLTableRowElement {
    const tr = document.createElement('tr');

    // key cell
    const tdKey = document.createElement('td');
    tdKey.className = 'fm-key';
    bindFmCell(tdKey, entry, 'key', tbody, panel);

    // value cell: chip list for list-valued entries, plain editable text otherwise
    const tdVal = document.createElement('td');
    tdVal.className = 'fm-val';
    if (entry.list) {
        bindFmListCell(tdVal, entry, tbody, panel);
    } else {
        bindFmCell(tdVal, entry, 'value', tbody, panel);
    }

    // delete button
    const tdDel = document.createElement('td');
    tdDel.className = 'fm-action';
    const delBtn = document.createElement('button');
    delBtn.className = 'fm-delete-btn';
    delBtn.innerHTML = IconX;
    delBtn.title = t('Delete');
    delBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        currentFmEntries.splice(index, 1);
        commitFrontmatterChange();
        rebuildFmTable(tbody, panel);
    });
    tdDel.appendChild(delBtn);

    tr.appendChild(tdKey);
    tr.appendChild(tdVal);
    tr.appendChild(tdDel);
    return tr;
}

/** Rebuilds the table tbody content. */
function rebuildFmTable(tbody: HTMLElement, panel: HTMLElement): void {
    tbody.innerHTML = '';
    currentFmEntries.forEach((entry, i) => {
        tbody.appendChild(createFmRow(entry, i, tbody, panel));
    });
}

/** Adds a new row. */
function addNewRow(tbody: HTMLElement, panel: HTMLElement): void {
    const newEntry: FmEntry = { key: '', value: '' };
    currentFmEntries.push(newEntry);
    const tr = createFmRow(newEntry, currentFmEntries.length - 1, tbody, panel);
    tbody.appendChild(tr);
    // Focus the key cell automatically
    const keyTd = tr.querySelector('.fm-key') as HTMLElement | null;
    keyTd?.focus();
}

/**
 * Creates the raw YAML editor used for non-flat blocks. The textarea shows the
 * exact inner YAML text; committing writes it back verbatim between the
 * original fences (no reformatting, no trimming).
 */
function createRawEditor(raw: string): HTMLTextAreaElement {
    const fences = splitFences(raw);
    const prefix = fences?.prefix ?? '';
    const suffix = fences?.suffix ?? '';
    // Last committed text; Escape reverts to it, blur commits when it differs.
    let committed = fences ? fences.inner : raw;
    // Browsers normalize textarea newlines to LF (the "API value"), so a CRLF inner
    // block would look edited on blur even when untouched, and a real edit would mix
    // LF lines with CRLF fences. Compare LF-normalized text and restore the original
    // EOL style when committing. The EOL style is derived from the FULL raw block
    // (fences included): a CRLF file whose inner text is a single line has no \r\n
    // in the inner, and committing LF lines between CRLF fences would mix EOLs.
    const usesCrlf = raw.includes('\r\n');
    const toLf = (text: string) => text.replace(/\r\n?/g, '\n');
    const restoreEol = (text: string) => (usesCrlf ? toLf(text).replace(/\n/g, '\r\n') : text);

    const textarea = document.createElement('textarea');
    textarea.className = 'fm-raw-editor';
    textarea.value = committed;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', t('Edit metadata as YAML'));
    textarea.rows = Math.max(committed.split('\n').length, 2);

    const setInvalid = (message: string | null): void => {
        if (message !== null) {
            textarea.setAttribute('aria-invalid', 'true');
            textarea.title = message;
        } else {
            textarea.removeAttribute('aria-invalid');
            textarea.removeAttribute('title');
        }
    };

    textarea.addEventListener('keydown', (e) => {
        if (e.isComposing) { return; }
        e.stopPropagation(); // keep editor-level shortcuts out of the textarea
        if (e.key === 'Escape') {
            e.preventDefault();
            textarea.value = committed;
            setInvalid(null);
            textarea.blur();
        }
    });
    textarea.addEventListener('blur', () => {
        // LF-normalized comparison: an untouched CRLF block must not phantom-commit.
        if (toLf(textarea.value) === toLf(committed)) {
            setInvalid(null);
            return;
        }
        // The extension re-extracts frontmatter with a first-`---` regex
        // (src/utils/contentTransform.ts), so an inner line of `---` (or the YAML
        // document-end marker `...`) would truncate the block and corrupt the document
        // on the next edit cycle. Reject any line merely STARTING with either marker
        // (`--- draft`, `----`, ...): older extraction regexes and third-party
        // frontmatter parsers treat those as closing fences too, so prefix matching
        // is the safe defense in depth. Refuse the commit and flag the textarea.
        if (toLf(textarea.value).split('\n').some((line) => /^(---|\.\.\.)/.test(line))) {
            setInvalid(t('Metadata cannot contain a line starting with "---" or "..."'));
            return;
        }
        setInvalid(null);
        committed = restoreEol(textarea.value);
        textarea.rows = Math.max(toLf(committed).split('\n').length, 2);
        notifyFrontmatterUpdate(prefix + committed + suffix);
    });
    return textarea;
}

/** Renders the frontmatter panel before #editor; removes it when there is no frontmatter. */
export function renderFrontmatterPanel(frontmatter: string | undefined): void {
    const existing = document.getElementById('frontmatter-panel');
    const editorEl = document.getElementById('editor');

    // No frontmatter → clear state and remove the panel
    if (!frontmatter) {
        currentFmEntries = [];
        currentFmRaw = '';
        existing?.remove();
        if (editorEl) { editorEl.style.paddingTop = ''; }
        return;
    }

    currentFmRaw = frontmatter;
    // Tabular = flat scalars plus simple lists; anything richer edits as raw YAML.
    const tabular = parseTabularFrontmatter(frontmatter);

    const panel = existing ?? document.createElement('div');
    panel.id = 'frontmatter-panel';
    panel.className = 'frontmatter-panel';
    panel.innerHTML = '';

    if (tabular !== null) {
        // Keep the panel even when entries are empty (lets the user add rows later)
        currentFmEntries = tabular;

        const table = document.createElement('table');
        table.className = 'frontmatter-table';
        const tbody = document.createElement('tbody');
        tabular.forEach((entry, i) => {
            tbody.appendChild(createFmRow(entry, i, tbody, panel));
        });
        table.appendChild(tbody);
        panel.appendChild(table);

        // Bottom row: collapse toggle + "Add field" button, left-aligned together
        const addRow = document.createElement('div');
        addRow.className = 'fm-add-row';
        addRow.appendChild(createToggleButton(panel));

        const addBtn = document.createElement('button');
        addBtn.className = 'fm-add-btn';
        addBtn.innerHTML = `${IconPlus} <span>${t('Add field')}</span>`;
        addBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            addNewRow(tbody, panel);
        });
        addRow.appendChild(addBtn);
        panel.appendChild(addRow);
    } else {
        // Raw mode: complex YAML is edited as-is; the table and Add-field UI are hidden.
        currentFmEntries = [];
        panel.appendChild(createRawEditor(frontmatter));
        const addRow = document.createElement('div');
        addRow.className = 'fm-add-row';
        addRow.appendChild(createToggleButton(panel));
        panel.appendChild(addRow);
    }

    if (!existing) {
        editorEl?.parentNode?.insertBefore(panel, editorEl);
    }
    if (editorEl) { editorEl.style.paddingTop = '16px'; }
}

/** Creates the collapse/expand toggle button and applies the persisted state. */
function createToggleButton(panel: HTMLElement): HTMLButtonElement {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'fm-toggle-btn';
    toggleBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const collapsed = !panel.classList.contains('collapsed');
        setFmCollapsed(collapsed);
        applyFmCollapsed(panel, toggleBtn, collapsed);
    });
    applyFmCollapsed(panel, toggleBtn, isFmCollapsed());
    return toggleBtn;
}
