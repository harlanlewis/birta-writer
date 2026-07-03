/**
 * components/frontmatter/index.ts
 * 
 * 职责：渲染和管理 YAML Frontmatter 可编辑面板
 * 
 * 本模块提供以下功能：
 * - 解析 YAML frontmatter 字符串为 key-value 数组
 * - 将 key-value 数组序列化回 YAML 格式
 * - 渲染可编辑的表格 UI（contenteditable td）
 * - 支持 Tab 键导航、Enter 提交、Escape 取消
 * - 实时同步编辑结果到 Extension
 */

import { IconChevronDown, IconChevronUp, IconPlus, IconX } from "../../ui/icons";
import { t } from "../../i18n";
import { getWebviewState, notifyFrontmatterUpdate, setWebviewState } from "../../messaging";

export type FmEntry = { key: string; value: string };

/** 解析 YAML frontmatter 字符串为 key-value 数组 */
export function parseFrontmatter(raw: string): FmEntry[] {
    return raw
        .split('\n')
        .filter(line => !line.match(/^---/) && line.includes(':'))
        .map(line => {
            const colonIdx = line.indexOf(':');
            return {
                key: line.slice(0, colonIdx).trim(),
                value: line.slice(colonIdx + 1).trim(),
            };
        })
        .filter(({ key }) => key.length > 0);
}

/** 将 key-value 数组序列化为 YAML frontmatter 字符串 */
export function serializeFrontmatter(entries: FmEntry[]): string {
    if (entries.length === 0) { return ""; }
    const lines = entries
        .filter(e => e.key.length > 0)
        .map(e => `${e.key}: ${e.value}`);
    if (lines.length === 0) { return ""; }
    return `---\n${lines.join("\n")}\n---\n`;
}

/** Current panel data (module-level state) */
let currentFmEntries: FmEntry[] = [];

/** Reads the persisted collapsed state of the frontmatter panel. */
function isFmCollapsed(): boolean {
    return getWebviewState()?.['fmCollapsed'] === true;
}

/** Persists the collapsed state so it survives tab switches and reloads. */
function setFmCollapsed(collapsed: boolean): void {
    setWebviewState({ ...(getWebviewState() ?? {}), fmCollapsed: collapsed });
}

/** Applies the collapsed state to the panel and updates the toggle button icon/tooltip. */
function applyFmCollapsed(panel: HTMLElement, toggleBtn: HTMLElement, collapsed: boolean): void {
    panel.classList.toggle('collapsed', collapsed);
    toggleBtn.innerHTML = collapsed ? IconChevronDown : IconChevronUp;
    toggleBtn.title = collapsed ? t('Expand frontmatter') : t('Collapse frontmatter');
}

/** 将编辑结果同步到 Extension */
function commitFrontmatterChange(): void {
    const raw = serializeFrontmatter(currentFmEntries);
    notifyFrontmatterUpdate(raw);
    // 若全部删除，移除面板
    if (currentFmEntries.length === 0) {
        const existing = document.getElementById('frontmatter-panel');
        existing?.remove();
        const editorEl = document.getElementById('editor');
        if (editorEl) { editorEl.style.paddingTop = ''; }
    }
}

/** 为 contenteditable td 绑定编辑行为 */
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

    // Enter 提交（Shift+Enter 允许换行）
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
                // 切换到同行 value
                const valTd = td.nextElementSibling as HTMLElement | null;
                if (valTd?.contentEditable === 'true') { valTd.focus(); }
            } else {
                // 切换到下一行 key 或新增行
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
            // key 不能为空，恢复原值
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

/** 创建单行可编辑表格行（contenteditable td，直接输入） */
function createFmRow(entry: FmEntry, index: number, tbody: HTMLElement, panel: HTMLElement): HTMLTableRowElement {
    const tr = document.createElement('tr');

    // key 单元格
    const tdKey = document.createElement('td');
    tdKey.className = 'fm-key';
    bindFmCell(tdKey, entry, 'key', tbody, panel);

    // value 单元格
    const tdVal = document.createElement('td');
    tdVal.className = 'fm-val';
    bindFmCell(tdVal, entry, 'value', tbody, panel);

    // 删除按钮
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

/** 重建表格 tbody 内容 */
function rebuildFmTable(tbody: HTMLElement, panel: HTMLElement): void {
    tbody.innerHTML = '';
    currentFmEntries.forEach((entry, i) => {
        tbody.appendChild(createFmRow(entry, i, tbody, panel));
    });
}

/** 新增一行 */
function addNewRow(tbody: HTMLElement, panel: HTMLElement): void {
    const newEntry: FmEntry = { key: '', value: '' };
    currentFmEntries.push(newEntry);
    const tr = createFmRow(newEntry, currentFmEntries.length - 1, tbody, panel);
    tbody.appendChild(tr);
    // 自动聚焦 key 单元格
    const keyTd = tr.querySelector('.fm-key') as HTMLElement | null;
    keyTd?.focus();
}

/** 在 #editor 前渲染 frontmatter 表格面板；无 frontmatter 时移除面板 */
export function renderFrontmatterPanel(frontmatter: string | undefined): void {
    const existing = document.getElementById('frontmatter-panel');
    const editorEl = document.getElementById('editor');

    // 无 frontmatter → 清空状态、移除面板
    if (!frontmatter) {
        currentFmEntries = [];
        existing?.remove();
        if (editorEl) { editorEl.style.paddingTop = ''; }
        return;
    }

    const entries = parseFrontmatter(frontmatter);
    // 即使 entries 为空也保留面板（允许用户后续添加行）
    currentFmEntries = entries;

    const panel = existing ?? document.createElement('div');
    panel.id = 'frontmatter-panel';
    panel.className = 'frontmatter-panel';

    // 构建表格
    const table = document.createElement('table');
    table.className = 'frontmatter-table';
    const tbody = document.createElement('tbody');
    entries.forEach((entry, i) => {
        tbody.appendChild(createFmRow(entry, i, tbody, panel));
    });
    table.appendChild(tbody);
    panel.innerHTML = '';
    panel.appendChild(table);

    // Bottom row: "Add field" button + collapse toggle
    const addRow = document.createElement('div');
    addRow.className = 'fm-add-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'fm-add-btn';
    addBtn.innerHTML = `${IconPlus} <span>${t('Add field')}</span>`;
    addBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        addNewRow(tbody, panel);
    });
    addRow.appendChild(addBtn);

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'fm-toggle-btn';
    toggleBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const collapsed = !panel.classList.contains('collapsed');
        setFmCollapsed(collapsed);
        applyFmCollapsed(panel, toggleBtn, collapsed);
    });
    addRow.appendChild(toggleBtn);
    panel.appendChild(addRow);
    applyFmCollapsed(panel, toggleBtn, isFmCollapsed());

    if (!existing) {
        editorEl?.parentNode?.insertBefore(panel, editorEl);
    }
    if (editorEl) { editorEl.style.paddingTop = '16px'; }
}
