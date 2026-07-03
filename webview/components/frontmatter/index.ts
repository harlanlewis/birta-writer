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

export type FmEntry = {
    key: string;
    value: string;
    /** Exact original line text (no trailing newline); present for entries parsed from the file. */
    origLine?: string;
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
        for (const line of innerLines) {
            if (line.trim() === "") { out.push(line); continue; } // keep blank lines verbatim
            const idx = remaining.findIndex(e => e.origLine === line);
            if (idx === -1) { continue; } // the entry for this line was deleted
            const entry = remaining.splice(idx, 1)[0]!;
            out.push(isEntryUnchanged(entry) ? line : formatEntryLine(entry));
        }
        // Newly added rows (and any entry that lost its original line) go at the end.
        for (const entry of remaining) { out.push(formatEntryLine(entry)); }
        return fences.prefix + out.join("\n") + fences.suffix;
    }

    return `---\n${surviving.map(formatEntryLine).join("\n")}\n---\n`;
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

/** Creates one editable table row (contenteditable td, direct typing). */
function createFmRow(entry: FmEntry, index: number, tbody: HTMLElement, panel: HTMLElement): HTMLTableRowElement {
    const tr = document.createElement('tr');

    // key cell
    const tdKey = document.createElement('td');
    tdKey.className = 'fm-key';
    bindFmCell(tdKey, entry, 'key', tbody, panel);

    // value cell
    const tdVal = document.createElement('td');
    tdVal.className = 'fm-val';
    bindFmCell(tdVal, entry, 'value', tbody, panel);

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

    const textarea = document.createElement('textarea');
    textarea.className = 'fm-raw-editor';
    textarea.value = committed;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', t('Edit metadata as YAML'));
    textarea.rows = Math.max(committed.split('\n').length, 2);

    textarea.addEventListener('keydown', (e) => {
        if (e.isComposing) { return; }
        e.stopPropagation(); // keep editor-level shortcuts out of the textarea
        if (e.key === 'Escape') {
            e.preventDefault();
            textarea.value = committed;
            textarea.blur();
        }
    });
    textarea.addEventListener('blur', () => {
        if (textarea.value !== committed) {
            committed = textarea.value;
            textarea.rows = Math.max(committed.split('\n').length, 2);
            notifyFrontmatterUpdate(prefix + committed + suffix);
        }
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
    const flat = isFlatFrontmatter(frontmatter);

    const panel = existing ?? document.createElement('div');
    panel.id = 'frontmatter-panel';
    panel.className = 'frontmatter-panel';
    panel.innerHTML = '';

    if (flat) {
        const entries = parseFrontmatter(frontmatter);
        // Keep the panel even when entries are empty (lets the user add rows later)
        currentFmEntries = entries;

        const table = document.createElement('table');
        table.className = 'frontmatter-table';
        const tbody = document.createElement('tbody');
        entries.forEach((entry, i) => {
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
