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
import {
    FLOW_ITEM_RE,
    parseQuotedToken,
    parseTabularFrontmatter,
    quoteItem,
    splitFences,
} from "../../../shared/frontmatterTable";
import type { FmEntry, FmListItem } from "../../../shared/frontmatterTable";
import { closeActiveFmSuggestMenu, openFmChipSuggestMenu, openFmSuggestMenu } from "./suggestMenu";
import type { FmSuggestController } from "./suggestMenu";

// The pure parsing core lives in shared/frontmatterTable.ts (also used by the
// Extension side); re-export it so existing consumers keep their import paths.
export { parseTabularFrontmatter } from "../../../shared/frontmatterTable";
export type { FmEntry, FmList, FmListItem } from "../../../shared/frontmatterTable";

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
    return `${parseQuotedToken(m[2]!).value} ${m[3] === "," ? 1 : 0}`;
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

/**
 * The panel's collapsed state: a per-tab toggle (persisted so it survives tab
 * switches and reloads) wins; a fresh open falls back to the
 * frontmatterExpanded setting (default expanded).
 */
function isFmCollapsed(): boolean {
    const persisted = getWebviewState()?.['fmCollapsed'];
    if (typeof persisted === "boolean") {
        return persisted;
    }
    return window.__i18n?.frontmatterExpanded === false;
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

    // Suggestion dropdown while the chip text is being edited: opened on
    // focus, live-filtered by the chip's current text, closed on blur/Escape.
    let suggest: FmSuggestController | null = null;

    /**
     * Single commit path shared by blur, Enter, and menu picks. Empty text
     * removes the item; changed text updates it; either way the table is
     * rebuilt, which detaches this chip (and thereby ends the edit).
     */
    function commitChip(): void {
        suggest?.close();
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
    }

    text.addEventListener('focus', () => {
        if (suggest?.isOpen()) { return; }
        suggest = openFmChipSuggestMenu({
            anchor: chip,
            key: entry.key,
            // Exclude the OTHER chips' values only: the edited chip's own
            // original must stay suggestible, otherwise narrowing
            // "/write/skill-factory" down to "/write/skill-fac" hides the
            // very completion the user is reaching for.
            existing: entry.list!.items.filter((it) => it !== item).map((it) => it.value),
            query: (text.textContent ?? '').trim(),
            onPick: (value) => {
                text.textContent = value;
                // The rebuild inside commitChip detaches the chip; blur() is a
                // no-op fallback for the unchanged-value edge (ends the edit).
                commitChip();
                text.blur();
            },
        });
    });
    text.addEventListener('input', () => {
        suggest?.setQuery((text.textContent ?? '').trim());
    });

    text.addEventListener('keydown', (e) => {
        if (e.isComposing) { return; }
        e.stopPropagation();
        const menuOpen = suggest !== null && suggest.isOpen();
        if (e.key === 'Enter') {
            e.preventDefault();
            const active = menuOpen ? suggest!.activeValue() : null;
            if (active !== null) {
                // pick() closes the menu and routes through onPick → commitChip.
                suggest!.pick(active);
            } else {
                // Commit first: after a rebuild the chip is detached and blur()
                // is a no-op, so this cannot double-commit in any branch.
                commitChip();
                text.blur();
            }
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            // Hijack the caret only while the menu is open and has options.
            if (menuOpen && suggest!.hasOptions()) {
                e.preventDefault();
                suggest!.moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (menuOpen) {
                // Close the dropdown only; keep editing the chip text.
                suggest!.close();
            } else {
                text.textContent = text.dataset['orig'] ?? '';
                text.blur();
            }
        } else if (e.key === 'Tab') {
            // Let focus move as usual; just drop the menu first.
            suggest?.close();
        }
    });
    // Menu-option mousedowns call preventDefault, so a blur here always means
    // the focus really left the chip.
    text.addEventListener('blur', () => commitChip());

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
        openFmSuggestMenu({
            anchor: addBtn,
            key: entry.key,
            existing: entry.list!.items.map((it) => it.value),
            onSelect: (value) => {
                // The panel may have been re-rendered (e.g. an external revert)
                // while the menu was open; a pick against an entry that is no
                // longer part of the current panel must not commit anything.
                if (!currentFmEntries.includes(entry)) { return; }
                entry.list!.items.push({ value });
                commitFrontmatterChange();
                rebuildFmTable(tbody, panel);
            },
        });
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
    // A re-render replaces every row: any open suggest menu would be left
    // anchored to a detached element and its pick would target stale entries.
    closeActiveFmSuggestMenu();
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

/**
 * Focuses the frontmatter panel (command-palette / context-menu "Edit
 * Frontmatter"): expands it when collapsed and moves focus to the first
 * editable field. No-op when the document has no frontmatter panel.
 */
export function focusFrontmatterPanel(): void {
    const panel = document.getElementById("frontmatter-panel");
    if (!panel) { return; }
    if (panel.classList.contains("collapsed")) {
        const toggle = panel.querySelector(".fm-toggle-btn") as HTMLElement | null;
        // The toggle flips the collapsed state on mousedown (see createToggleButton).
        toggle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
    panel.scrollIntoView({ block: "nearest" });
    const first = panel.querySelector(".fm-key, .fm-raw-editor") as HTMLElement | null;
    first?.focus();
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
