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

import { IconChevronDown, IconChevronUp, IconPlus, IconTrash2, IconX } from "../../ui/icons";
import { t } from "../../i18n";
import { createButton } from "../../ui/dom";
import { attachInputUndo, undoChordOf } from "../../utils/inputUndo";
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

/** id of the collapsible content element (table or raw editor), for aria-controls. */
const FM_CONTENT_ID = "frontmatter-content";

/**
 * Panel-local undo/redo history of COMMITTED frontmatter states.
 *
 * VS Code's Electron layer swallows Cmd+Z before the webview sees it, and the
 * ProseMirror history knows nothing about this panel, so metadata edits would
 * otherwise be un-undoable. Each stack entry is a full serialized block; the
 * public renderFrontmatterPanel (init / external update / revert) resets the
 * stacks, while undo/redo re-render through renderFmContent, which does not.
 */
let fmUndoStack: string[] = [];
let fmRedoStack: string[] = [];
let lastCommittedFm = "";

/** Routes a committed raw block through the history bookkeeping, then notifies. */
function recordFmCommit(raw: string): void {
    if (raw === lastCommittedFm) { return; }
    fmUndoStack.push(lastCommittedFm);
    fmRedoStack.length = 0;
    lastCommittedFm = raw;
    notifyFrontmatterUpdate(raw);
}

/** After an undo/redo re-render, park focus where repeated chords keep working. */
function focusAfterFmHistory(): void {
    const panel = document.getElementById("frontmatter-panel");
    if (!panel) { return; }
    const target = panel.querySelector(".fm-key, .fm-raw-editor, .fm-add-btn, .fm-toggle-btn") as HTMLElement | null;
    target?.focus();
}

/** Undoes the last committed metadata change (no-op when there is none). */
function performFmUndo(): void {
    const prev = fmUndoStack.pop();
    if (prev === undefined) { return; }
    fmRedoStack.push(lastCommittedFm);
    lastCommittedFm = prev;
    notifyFrontmatterUpdate(prev);
    renderFmContent(prev);
    focusAfterFmHistory();
}

/** Re-applies the last undone metadata change (no-op when there is none). */
function performFmRedo(): void {
    const next = fmRedoStack.pop();
    if (next === undefined) { return; }
    fmUndoStack.push(lastCommittedFm);
    lastCommittedFm = next;
    notifyFrontmatterUpdate(next);
    renderFmContent(next);
    focusAfterFmHistory();
}

/** Runs the committed-state undo/redo for a chord; the chord is already consumed. */
function handleFmHistoryChord(chord: "undo" | "redo"): void {
    if (chord === "undo") { performFmUndo(); } else { performFmRedo(); }
}

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
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleBtn.innerHTML = collapsed
        ? `${IconChevronDown} <span>${t('Show metadata')}</span>`
        : `${IconChevronUp} <span>${t('Hide metadata')}</span>`;
}

/**
 * Syncs the edited table back to the Extension (through the undo history).
 * When the last entry is deleted the panel stays (empty table + bottom row):
 * an empty raw still tells the extension to drop the block, but the panel
 * must survive so the user can undo the delete or add a new field.
 */
function commitFrontmatterChange(): void {
    recordFmCommit(serializeFrontmatter(currentFmEntries, currentFmRaw));
}

/** Accessible name for a row's delete button, naming the field it removes. */
function deleteFieldAriaLabel(key: string): string {
    return `${t('Delete field')}: "${key}"`;
}

/** Focuses a row's key cell. Returns true when a target was found. */
function focusRowKey(row: Element | undefined): boolean {
    const keyTd = row?.querySelector('.fm-key') as HTMLElement | null;
    if (keyTd) { keyTd.focus(); return true; }
    return false;
}

/**
 * Focuses a row's value: the editable value cell, or a chip-list cell's add
 * button (a chip cell isn't a caret target). Returns false when the row has
 * no focusable value, so the caller can fall back to the key cell.
 */
function focusRowValue(row: Element | undefined): boolean {
    if (!row) { return false; }
    const valTd = row.querySelector('.fm-val') as HTMLElement | null;
    if (valTd?.contentEditable === 'true') { valTd.focus(); return true; }
    const addChip = row.querySelector('.fm-chip-add') as HTMLElement | null;
    if (addChip) { addChip.focus(); return true; }
    return false;
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
    // Set the attribute explicitly as well: jsdom does not reflect the
    // contentEditable property, and without the attribute the cell is not
    // focusable there (browsers reflect it either way).
    td.setAttribute('contenteditable', 'true');
    td.textContent = entry[field];
    td.dataset['orig'] = entry[field];
    const placeholder = field === 'key' ? 'key' : 'value';
    td.dataset['placeholder'] = placeholder;
    td.setAttribute('role', 'textbox');
    td.setAttribute('aria-multiline', 'false');
    td.setAttribute('aria-label', field === 'key'
        ? t('Field name')
        : (entry.key || t('Field value')));
    td.setAttribute('aria-placeholder', placeholder);

    /**
     * Commits the cell's current text. Idempotent for unchanged values, so
     * Enter (commit in place) followed by blur (commit again) is safe.
     */
    const commitCell = (): void => {
        const newVal = (td.textContent ?? '').trim();
        if (field === 'key' && newVal.length === 0) {
            // Keys must not be empty; restore the previous value
            td.textContent = td.dataset['orig'] ?? '';
            return;
        }
        if (newVal !== entry[field]) {
            entry[field] = newVal;
            if (field === 'key') {
                // Keep the row's dynamic accessible names in sync with the rename
                const tr = td.closest('tr');
                tr?.querySelector('.fm-delete-btn')?.setAttribute('aria-label', deleteFieldAriaLabel(entry.key));
                const valTd = tr?.querySelector('.fm-val[role="textbox"]');
                valTd?.setAttribute('aria-label', entry.key || t('Field value'));
            }
            commitFrontmatterChange();
        }
        td.dataset['orig'] = entry[field];
    };

    td.addEventListener('keydown', (e) => {
        if (e.isComposing) { return; }
        // Undo/redo chords come first and are always swallowed (VS Code /
        // ProseMirror must never see them). Uncommitted local typing reverts
        // to the last committed cell value before the shared history engages.
        const chord = undoChordOf(e);
        if (chord) {
            e.preventDefault();
            e.stopPropagation();
            if (chord === 'undo' && (td.textContent ?? '') !== (td.dataset['orig'] ?? '')) {
                td.textContent = td.dataset['orig'] ?? '';
                return; // local revert only; stay focused
            }
            handleFmHistoryChord(chord);
            return;
        }
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
            // Enter commits in place (focus stays, so Cmd+Z keeps working)
            e.preventDefault();
            commitCell();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            td.textContent = td.dataset['orig'] ?? '';
            td.blur();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            const idx = currentFmEntries.indexOf(entry);
            if (e.shiftKey) {
                // Backward: value → key (same row); key → the previous row's
                // value. Shift+Tab must NEVER create a row (that was the bug:
                // it fell through to the forward branch and added one).
                if (field === 'value') {
                    (td.previousElementSibling as HTMLElement | null)?.focus();
                } else {
                    const prevRow = tbody.children[idx - 1] as HTMLElement | undefined;
                    focusRowValue(prevRow) || focusRowKey(prevRow);
                    // First row's key has nowhere to go back to: stay put.
                }
            } else {
                // Forward: key → value (same row); value → next row's key, or a
                // new row when this is the last one (a metadata-editor nicety).
                if (field === 'key') {
                    const valTd = td.nextElementSibling as HTMLElement | null;
                    if (valTd?.contentEditable === 'true') { valTd.focus(); }
                } else {
                    const nextRow = tbody.children[idx + 1] as HTMLElement | undefined;
                    if (nextRow) {
                        focusRowKey(nextRow);
                    } else {
                        addNewRow(tbody, panel);
                    }
                }
            }
        }
    });

    td.addEventListener('blur', commitCell);
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
    text.setAttribute('contenteditable', 'true'); // jsdom focusability, see bindFmCell
    text.spellcheck = false;
    text.dataset['orig'] = item.value;
    text.setAttribute('role', 'textbox');
    text.setAttribute('aria-multiline', 'false');
    text.setAttribute('aria-label', item.value || t('Field value'));

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
        // Undo/redo chords first (always swallowed): uncommitted chip typing
        // reverts locally; otherwise the shared committed-state history runs.
        const chord = undoChordOf(e);
        if (chord) {
            e.preventDefault();
            e.stopPropagation();
            if (chord === 'undo' && (text.textContent ?? '') !== (text.dataset['orig'] ?? '')) {
                text.textContent = text.dataset['orig'] ?? '';
                suggest?.setQuery((text.textContent ?? '').trim());
                return; // local revert only; stay focused
            }
            suggest?.close();
            handleFmHistoryChord(chord);
            return;
        }
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

    const removeBtn = createButton({
        className: 'ui-btn fm-chip-remove',
        icon: IconX,
        title: t('Remove item'),
        ariaLabel: `${t('Remove item')}: "${item.value}"`,
        tooltipPlacement: 'above',
        onClick: () => {
            entry.list!.items = entry.list!.items.filter((it) => it !== item);
            commitFrontmatterChange();
            rebuildFmTable(tbody, panel);
        },
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

    const addBtn = createButton({
        className: 'ui-btn fm-chip-add',
        icon: IconPlus,
        title: t('Add item'),
        tooltipPlacement: 'above',
        onClick: () => {
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
        },
    });
    chips.appendChild(addBtn);
    td.appendChild(chips);
}

/** Creates one editable table row (contenteditable td, direct typing). */
function createFmRow(entry: FmEntry, tbody: HTMLElement, panel: HTMLElement): HTMLTableRowElement {
    const tr = document.createElement('tr');

    // delete button (first cell, left of the key)
    const tdDel = document.createElement('td');
    tdDel.className = 'fm-action';
    const delBtn = createButton({
        className: 'ui-btn ui-btn--icon fm-delete-btn',
        icon: IconTrash2,
        title: t('Delete field'),
        ariaLabel: deleteFieldAriaLabel(entry.key),
        tooltipPlacement: 'above',
        onClick: () => {
            const idx = currentFmEntries.indexOf(entry);
            if (idx === -1) { return; }
            currentFmEntries.splice(idx, 1);
            commitFrontmatterChange();
            rebuildFmTable(tbody, panel);
            // Keep keyboard flow (and a follow-up Cmd+Z) from being stranded:
            // focus the row that took this index, else the previous row's key
            // cell, else the "Add field" button when the table emptied.
            const rows = tbody.children;
            const nextRow = rows[Math.min(idx, rows.length - 1)];
            const nextKey = nextRow?.querySelector('.fm-key') as HTMLElement | null;
            if (nextKey) {
                nextKey.focus();
            } else {
                (panel.querySelector('.fm-add-btn') as HTMLElement | null)?.focus();
            }
        },
    });
    tdDel.appendChild(delBtn);

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

    tr.appendChild(tdDel);
    tr.appendChild(tdKey);
    tr.appendChild(tdVal);

    // A freshly added row abandoned while still fully empty is discarded once
    // focus leaves the row (mirrors abandoned chips), so repeated "Add field"
    // clicks never accumulate ghost rows. The blur commit runs synchronously
    // before focusout, so by timeout time entry.key/value reflect any typing.
    if (entry.origLine === undefined && !entry.list) {
        tr.addEventListener('focusout', () => {
            setTimeout(() => {
                if (!tr.isConnected || tr.contains(document.activeElement)) { return; }
                if (entry.key !== '' || entry.value !== '') { return; }
                const idx = currentFmEntries.indexOf(entry);
                if (idx === -1) { return; }
                currentFmEntries.splice(idx, 1);
                // The entry was never serialized, so nothing to commit; remove
                // the row in place (a rebuild would steal focus from siblings).
                tr.remove();
                // An abandoned Add-metadata start (no committed frontmatter,
                // nothing to undo) reverts to the empty-state affordance.
                if (currentFmEntries.length === 0 && lastCommittedFm === '' && fmUndoStack.length === 0) {
                    renderFrontmatterPanel(undefined);
                }
            }, 0);
        });
    }

    return tr;
}

/** Rebuilds the table tbody content. */
function rebuildFmTable(tbody: HTMLElement, panel: HTMLElement): void {
    tbody.innerHTML = '';
    for (const entry of currentFmEntries) {
        tbody.appendChild(createFmRow(entry, tbody, panel));
    }
}

/** Adds a new row. */
function addNewRow(tbody: HTMLElement, panel: HTMLElement): void {
    const newEntry: FmEntry = { key: '', value: '' };
    currentFmEntries.push(newEntry);
    const tr = createFmRow(newEntry, tbody, panel);
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
    textarea.id = FM_CONTENT_ID;
    textarea.value = committed;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', t('Edit metadata as YAML'));
    textarea.rows = Math.max(committed.split('\n').length, 2);
    // Local typing undo (VS Code swallows Cmd+Z before the textarea sees it).
    // Its chord handler swallows the chord first; the panel's committed-state
    // undo remains reachable once focus moves to the toggle/panel.
    attachInputUndo(textarea);

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
        // Same history bookkeeping as the table path, so raw edits are undoable
        recordFmCommit(prefix + committed + suffix);
    });
    return textarea;
}

/**
 * Renders the frontmatter panel before #editor. This is the external entry
 * point (init / external update / revert), so it also resets the panel-local
 * undo/redo history. A document without frontmatter gets the empty state: the
 * panel row survives with a single "Add metadata" button (the Show/Hide
 * toggle and Add-field controls exist only when there is content to show).
 */
export function renderFrontmatterPanel(frontmatter: string | undefined): void {
    fmUndoStack = [];
    fmRedoStack = [];
    lastCommittedFm = frontmatter ?? '';

    // No frontmatter → clear state and offer the Add-metadata affordance
    if (!frontmatter) {
        closeActiveFmSuggestMenu();
        currentFmEntries = [];
        currentFmRaw = '';
        renderEmptyMetadataState();
        return;
    }

    renderFmContent(frontmatter);
}

/**
 * The no-frontmatter state: just the "Add metadata" button, occupying the
 * panel's standard slot below the toolbar (see .fm-empty in style.css).
 * Clicking it opens an empty table with a fresh focused row; abandoning that
 * row untyped reverts here.
 */
function renderEmptyMetadataState(): void {
    const existing = document.getElementById('frontmatter-panel');
    const editorEl = document.getElementById('editor');
    // Gate (birta.frontmatterAddButton): off removes the affordance entirely —
    // no panel, no editor inset — restoring the plain frontmatter-less layout.
    // The Edit Frontmatter command still reaches startAddMetadata directly.
    if (window.__i18n?.frontmatterAddButton === false) {
        existing?.remove();
        if (editorEl) { editorEl.style.paddingTop = ''; }
        return;
    }
    const panel = existing ?? document.createElement('div');
    panel.id = 'frontmatter-panel';
    panel.className = 'frontmatter-panel fm-empty';
    panel.tabIndex = -1;
    panel.innerHTML = '';

    const addRow = document.createElement('div');
    addRow.className = 'fm-add-row';
    const addBtn = createButton({
        className: 'ui-btn ui-btn--chip fm-add-metadata-btn',
        onClick: () => startAddMetadata(),
    });
    addBtn.innerHTML = `${IconPlus} <span>${t('Add metadata')}</span>`;
    addRow.appendChild(addBtn);
    panel.appendChild(addRow);

    if (!existing) {
        editorEl?.parentNode?.insertBefore(panel, editorEl);
    }
    // The panel supplies the toolbar clearance, same as the populated state.
    if (editorEl) { editorEl.style.paddingTop = '16px'; }
}

/**
 * Re-renders the empty state after the birta.frontmatterAddButton gate flips
 * (live settings broadcast). A document WITH frontmatter is untouched — the
 * gate governs only the frontmatter-less affordance.
 */
export function refreshFrontmatterEmptyState(): void {
    const panel = document.getElementById("frontmatter-panel");
    const hasContent = panel !== null && !panel.classList.contains("fm-empty");
    if (hasContent) { return; }
    renderFrontmatterPanel(undefined);
}

/**
 * Opens the metadata editor from the empty state: an empty table plus one
 * fresh, focused row. Nothing is committed — and the document is untouched —
 * until the user actually enters a field; committing one sends the fenced
 * block to the extension, which inserts it at the top of the document.
 */
function startAddMetadata(): void {
    // A persisted collapsed state must not hide the row being added.
    setFmCollapsed(false);
    renderFmContent('');
    const panel = document.getElementById('frontmatter-panel');
    if (!panel) { return; }
    // Apply the expansion directly too, not just via the persisted-state read.
    const toggleBtn = panel.querySelector('.fm-toggle-btn') as HTMLButtonElement | null;
    if (toggleBtn) { applyFmCollapsed(panel, toggleBtn, false); }
    const tbody = panel.querySelector('.frontmatter-table tbody') as HTMLElement | null;
    if (tbody) { addNewRow(tbody, panel); }
}

/**
 * (Re)builds the panel content from a raw block WITHOUT touching the undo
 * history — undo/redo re-render through this. An empty raw renders an empty
 * table (the panel survives a delete-all so the user can undo or re-add).
 */
function renderFmContent(frontmatter: string): void {
    // A re-render replaces every row: any open suggest menu would be left
    // anchored to a detached element and its pick would target stale entries.
    closeActiveFmSuggestMenu();
    const existing = document.getElementById('frontmatter-panel');
    const editorEl = document.getElementById('editor');

    currentFmRaw = frontmatter;
    // Tabular = flat scalars plus simple lists; anything richer edits as raw YAML.
    const tabular = frontmatter === '' ? [] : parseTabularFrontmatter(frontmatter);

    const panel = existing ?? document.createElement('div');
    panel.id = 'frontmatter-panel';
    panel.className = 'frontmatter-panel';
    // Focusable so a click on empty panel chrome lands focus on the panel
    // itself (not <body>), keeping the undo/redo chord below reachable. Cells
    // and buttons are more specific click targets, so this only catches blank
    // space; -1 keeps it out of the Tab order.
    panel.tabIndex = -1;
    panel.innerHTML = '';

    // Undo/redo chords anywhere on the panel (e.g. focus on its buttons) run
    // the committed-state history. Cells, chips, and the raw textarea consume
    // the chord themselves before it can bubble here. Bind once per element:
    // re-renders reuse the panel node, and a duplicate listener would double-pop.
    if (!panel.dataset['fmChordBound']) {
        panel.dataset['fmChordBound'] = 'true';
        panel.addEventListener('keydown', (e) => {
            const chord = undoChordOf(e);
            if (!chord) { return; }
            e.preventDefault();
            e.stopPropagation();
            handleFmHistoryChord(chord);
        });
    }

    if (tabular !== null) {
        // Keep the panel even when entries are empty (lets the user add rows later)
        currentFmEntries = tabular;

        const table = document.createElement('table');
        table.className = 'frontmatter-table';
        table.id = FM_CONTENT_ID;
        const tbody = document.createElement('tbody');
        for (const entry of tabular) {
            tbody.appendChild(createFmRow(entry, tbody, panel));
        }
        table.appendChild(tbody);
        panel.appendChild(table);

        // Bottom row: collapse toggle + "Add field" button, left-aligned together
        const addRow = document.createElement('div');
        addRow.className = 'fm-add-row';
        addRow.appendChild(createToggleButton(panel));

        const addBtn = createButton({
            className: 'ui-btn ui-btn--chip fm-add-btn',
            onClick: () => addNewRow(tbody, panel),
        });
        addBtn.innerHTML = `${IconPlus} <span>${t('Add field')}</span>`;
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
 * editable field. On a document without frontmatter it starts adding some —
 * the same flow as the empty state's own "Add metadata" button.
 */
export function focusFrontmatterPanel(): void {
    const panel = document.getElementById("frontmatter-panel");
    // No panel at all (frontmatter-less doc with the Add-metadata button
    // hidden): the command still starts the add flow from nothing.
    if (!panel) {
        startAddMetadata();
        return;
    }
    if (panel.classList.contains("fm-empty")) {
        startAddMetadata();
        panel.scrollIntoView({ block: "nearest" });
        return;
    }
    if (panel.classList.contains("collapsed")) {
        const toggle = panel.querySelector(".fm-toggle-btn") as HTMLElement | null;
        // element.click() fires with detail 0, which createButton's keyboard
        // branch handles (no synthetic mouse events needed).
        toggle?.click();
    }
    panel.scrollIntoView({ block: "nearest" });
    const first = panel.querySelector(".fm-key, .fm-raw-editor") as HTMLElement | null;
    first?.focus();
}

/** Creates the collapse/expand toggle button and applies the persisted state. */
function createToggleButton(panel: HTMLElement): HTMLButtonElement {
    const toggleBtn = createButton({
        className: 'ui-btn ui-btn--chip fm-toggle-btn',
        onClick: () => {
            const collapsed = !panel.classList.contains('collapsed');
            setFmCollapsed(collapsed);
            applyFmCollapsed(panel, toggleBtn, collapsed);
        },
    });
    toggleBtn.setAttribute('aria-controls', FM_CONTENT_ID);
    applyFmCollapsed(panel, toggleBtn, isFmCollapsed());
    return toggleBtn;
}
