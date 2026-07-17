import { notifyGetPathSuggestions } from "@/messaging";
import { getFileIcon } from "./fileIcons";
import { onOutsideClick } from "@/ui/outsideClick";
import type { EditorView } from "@/pm";

// Path-prefix detection that triggers completion
const PATH_PREFIX_REGEX = /^(@\/|\.{1,2}\/|[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)/;

type SuggestionItem = { path: string; isDir: boolean };
type SuggestCallback = (items: SuggestionItem[]) => void;

// Path-completion callback map: id → resolve
const _pendingSuggestions = new Map<string, SuggestCallback>();

/** Called from outside to dispatch a pathSuggestions message */
export function dispatchPathSuggestions(id: string, items: SuggestionItem[]): void {
    const cb = _pendingSuggestions.get(id);
    if (cb) {
        _pendingSuggestions.delete(id);
        cb(items);
    }
}

/** Get the inline code element at the current caret (excluding pre>code and a>code) */
function getActiveInlineCode(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { return null; }
    const node = sel.anchorNode;
    if (!node) { return null; }
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    if (!el) { return null; }
    const code = el.closest("code");
    if (!code) { return null; }
    if (code.closest("pre")) { return null; }
    if (code.closest("a")) { return null; }
    return code as HTMLElement;
}

/** Find the text range of the inlineCode mark at the current ProseMirror selection position */
function getCodeNodeRangeFromSelection(view: EditorView): { from: number; to: number } | null {
    const { state } = view;
    const codeMark = state.schema.marks["inlineCode"];
    if (!codeMark) { return null; }

    const { $from } = state.selection;
    const parentStart = $from.start();
    let from: number | undefined;
    let to: number | undefined;
    $from.parent.forEach((node, offset) => {
        if (node.isText && node.marks.some(m => m.type === codeMark)) {
            const s = parentStart + offset;
            const e = s + node.nodeSize;
            if ($from.pos >= s && $from.pos <= e) {
                from = s;
                to = e;
            }
        }
    });
    return from !== undefined && to !== undefined ? { from, to } : null;
}

export function initPathComplete(getEditorViewFn: () => EditorView | null): void {
    let dropdown: HTMLUListElement | null = null;
    let activeIndex = -1;
    let lastItems: SuggestionItem[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // Snapshot the code mark range in showDropdown, since the caret position may be unreliable on click
    let savedRange: { from: number; to: number } | null = null;
    // Suppress mouseover after keyboard navigation, so scrollIntoView-triggered mouseover doesn't override activeIndex
    let suppressMouseover = false;

    function closeDropdown(): void {
        if (dropdown) {
            dropdown.remove();
            dropdown = null;
        }
        activeIndex = -1;
        lastItems = [];
        savedRange = null;
    }

    function updateActiveItem(): void {
        if (!dropdown) { return; }
        Array.from(dropdown.children).forEach((li, i) => {
            const isActive = i === activeIndex;
            li.classList.toggle("path-complete-item--active", isActive);
            if (isActive) {
                (li as HTMLElement).scrollIntoView({ block: "nearest" });
            }
        });
    }

    function applySelection(item: SuggestionItem): void {
        const view = getEditorViewFn();
        if (!view) {
            closeDropdown();
            return;
        }
        const range = savedRange ?? getCodeNodeRangeFromSelection(view);
        if (!range) {
            closeDropdown();
            return;
        }
        const codeMark = view.state.schema.marks["inlineCode"];
        if (!codeMark) { return; }
        const { state } = view;
        view.dispatch(
            state.tr.replaceRangeWith(
                range.from,
                range.to,
                state.schema.text(item.path, [codeMark.create()]),
            ),
        );
        view.focus();

        if (item.isDir) {
            // A folder was chosen: after replacing the content, enter that directory automatically (50ms wait for the ProseMirror DOM to update)
            closeDropdown();
            setTimeout(() => {
                const newCode = getActiveInlineCode();
                if (newCode) { triggerSuggest(newCode); }
            }, 50);
        } else {
            closeDropdown();
        }
    }

    function showDropdown(code: HTMLElement, items: SuggestionItem[]): void {
        closeDropdown();
        if (items.length === 0) { return; }

        lastItems = items;

        // Snapshot the current code mark range; the caret may have moved by the time of click
        const view = getEditorViewFn();
        if (view) { savedRange = getCodeNodeRangeFromSelection(view); }

        const rect = code.getBoundingClientRect();
        const ul = document.createElement("ul");
        ul.className = "path-complete-list";
        ul.style.top = `${rect.bottom + window.scrollY + 2}px`;
        ul.style.left = `${rect.left + window.scrollX}px`;

        items.forEach((item, i) => {
            const li = document.createElement("li");
            li.className = "path-complete-item";

            // Icon
            const iconEl = document.createElement("span");
            iconEl.className = "path-complete-icon";
            iconEl.innerHTML = getFileIcon(item.path, item.isDir);

            // Show only the last file/directory name segment; the full path is the title
            const lastSeg = item.path.replace(/\/$/, '').split('/').pop() ?? item.path;
            const label = document.createElement("span");
            label.className = "path-complete-label";
            label.textContent = lastSeg;
            li.title = item.path;

            li.append(iconEl, label);

            li.addEventListener("mousedown", (e) => {
                e.preventDefault();
                activeIndex = i;
                applySelection(item);
            });
            li.addEventListener("mousemove", () => { suppressMouseover = false; });
            li.addEventListener("mouseover", () => {
                if (suppressMouseover) { return; }
                activeIndex = i;
                updateActiveItem();
            });
            ul.appendChild(li);
        });

        document.body.appendChild(ul);
        dropdown = ul;
        activeIndex = 0;
        updateActiveItem();
    }

    function triggerSuggest(code: HTMLElement): void {
        const query = (code.textContent ?? "").trim();
        if (!query || !PATH_PREFIX_REGEX.test(query)) {
            closeDropdown();
            return;
        }

        const id = `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        _pendingSuggestions.set(id, (items) => {
            const currentCode = getActiveInlineCode();
            if (currentCode === code) {
                showDropdown(code, items);
            }
        });
        notifyGetPathSuggestions(id, query);

        // Timeout cleanup
        setTimeout(() => {
            if (_pendingSuggestions.has(id)) {
                _pendingSuggestions.delete(id);
            }
        }, 5000);
    }

    // Keyboard navigation (capture phase, takes priority over the editor)
    document.addEventListener("keydown", (e) => {
        if (!dropdown) { return; }

        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeDropdown();
            return;
        }

        if (e.key === "ArrowDown") {
            e.preventDefault();
            suppressMouseover = true;
            activeIndex = activeIndex >= lastItems.length - 1 ? 0 : activeIndex + 1;
            updateActiveItem();
            return;
        }

        if (e.key === "ArrowUp") {
            e.preventDefault();
            suppressMouseover = true;
            activeIndex = activeIndex <= 0 ? lastItems.length - 1 : activeIndex - 1;
            updateActiveItem();
            return;
        }

        if (e.key === "Enter" || e.key === "Tab") {
            if (activeIndex >= 0 && activeIndex < lastItems.length) {
                e.preventDefault();
                e.stopPropagation();
                applySelection(lastItems[activeIndex]);
            }
            return;
        }
    }, true);

    // Trigger completion on input (debounced 200ms)
    document.addEventListener("keyup", (e) => {
        if (["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) { return; }

        const code = getActiveInlineCode();
        if (!code) {
            closeDropdown();
            return;
        }

        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            triggerSuggest(code);
        }, 200);
    });

    // Click elsewhere to close the dropdown. The dropdown is rebuilt per
    // suggestion reply, hence the getter; the no-dropdown guard mirrors the
    // original handler (nothing to close). Attached for the editor's
    // lifetime, like the keydown/keyup listeners above — never detached.
    onOutsideClick(
        () => [dropdown],
        () => { if (dropdown) { closeDropdown(); } },
    );

    // Close on blur
    window.addEventListener("blur", () => {
        closeDropdown();
    });
}
