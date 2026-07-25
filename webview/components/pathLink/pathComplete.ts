/**
 * components/pathLink/pathComplete.ts
 *
 * Path autocompletion for inline `code` spans: typing a path-looking fragment
 * inside inline code (`img/`, `./notes`, `@/docs/`) offers the matching
 * workspace entries, and picking one rewrites the code span.
 *
 * Unlike its two siblings this is a DOCUMENT-LEVEL singleton, not a per-input
 * attachment: there is no field to attach to, so it listens on `document` and
 * finds the active code span from the selection. That difference is why the
 * ProseMirror `replaceRangeWith` + `savedRange` snapshot lives here and not in
 * the shared shell — everything else (render, keyboard highlight, viewport
 * placement) comes from `ui/suggestList.ts`.
 */
import { notifyGetPathSuggestions } from "@/messaging";
import { getFileIcon } from "./fileIcons";
import { onOutsideClick } from "@/ui/outsideClick";
import {
    createSuggestMenuFromRows,
    type LinkSuggestMenu,
} from "@/ui/suggestList";
import type { EditorView } from "@/pm";
import type { PathSuggestionItem } from "../../../shared/messages";

// Path-prefix detection that triggers completion
const PATH_PREFIX_REGEX = /^(@\/|\.{1,2}\/|[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)/;

type SuggestCallback = (items: PathSuggestionItem[]) => void;

// Path-completion callback map: id → resolve
const _pendingSuggestions = new Map<string, SuggestCallback>();

/** Called from outside to dispatch a pathSuggestions message */
export function dispatchPathSuggestions(id: string, items: PathSuggestionItem[]): void {
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

/** The name a row shows: the last segment, without a trailing slash. */
function lastSegment(path: string): string {
    return path.replace(/\/$/, "").split("/").pop() ?? path;
}

/**
 * Installs the inline-code path completion. Returns a detach function that
 * removes every document/window listener and closes any open dropdown — the
 * listeners used to be attached for the editor's whole lifetime with no way
 * back off (MAR-220).
 */
export function initPathComplete(getEditorViewFn: () => EditorView | null): () => void {
    let menu: LinkSuggestMenu | null = null;
    let lastItems: PathSuggestionItem[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // Snapshot the code mark range in showDropdown, since the caret position may be unreliable on click
    let savedRange: { from: number; to: number } | null = null;
    let isDestroyed = false;

    function closeDropdown(): void {
        menu?.destroy();
        menu = null;
        lastItems = [];
        savedRange = null;
    }

    function applySelection(item: PathSuggestionItem): void {
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
                if (isDestroyed) { return; }
                const newCode = getActiveInlineCode();
                if (newCode) { triggerSuggest(newCode); }
            }, 50);
        } else {
            closeDropdown();
        }
    }

    function showDropdown(code: HTMLElement, items: PathSuggestionItem[]): void {
        closeDropdown();
        if (items.length === 0) { return; }

        lastItems = items;

        // Snapshot the current code mark range; the caret may have moved by the time of click
        const view = getEditorViewFn();
        if (view) { savedRange = getCodeNodeRangeFromSelection(view); }

        // Viewport coordinates: the shell's menu is position:fixed, so no
        // scroll offsets. `flipTop` lets it flip above a code span sitting
        // near the bottom edge instead of rendering off-screen.
        const rect = code.getBoundingClientRect();
        menu = createSuggestMenuFromRows(
            items.map((item) => ({
                // The picked value is the FULL path while the row shows only
                // its last segment, so the row owns its own content.
                text: item.path,
                title: item.path,
                render: (li) => {
                    const iconEl = document.createElement("span");
                    iconEl.className = "path-complete-icon";
                    iconEl.innerHTML = getFileIcon(item.path, item.isDir);
                    const label = document.createElement("span");
                    label.className = "path-complete-label";
                    label.textContent = lastSegment(item.path);
                    li.append(iconEl, label);
                },
            })),
            { left: rect.left, top: rect.bottom + 2, flipTop: rect.top - 2 },
            // By INDEX, not text: one directory listing can hold a folder
            // `foo/` and a file `foo`, which render the same segment.
            (_text, i) => applySelection(lastItems[i]),
            { className: "path-complete-menu", initialActive: 0 },
        );
    }

    function triggerSuggest(code: HTMLElement): void {
        const query = (code.textContent ?? "").trim();
        if (!query || !PATH_PREFIX_REGEX.test(query)) {
            closeDropdown();
            return;
        }

        const id = `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        _pendingSuggestions.set(id, (items) => {
            // The caret must still be in the SAME code span: the reply is
            // async and the user may have moved on since the request.
            if (isDestroyed) { return; }
            if (getActiveInlineCode() === code) {
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
    function onKeydown(e: KeyboardEvent): void {
        // Never touch an IME composition. This listener is on `document` in
        // the CAPTURE phase, so without the guard a CJK/Japanese candidate
        // window's Enter or arrow key was swallowed from the whole editor
        // whenever the dropdown happened to be open (MAR-220).
        if (e.isComposing || !menu) { return; }

        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeDropdown();
            return;
        }

        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            menu.moveActive(e.key === "ArrowDown" ? 1 : -1);
            return;
        }

        if (e.key === "Enter" || e.key === "Tab") {
            // pickActive routes through applySelection, which closes the menu.
            if (menu.pickActive()) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }
    }

    // Trigger completion on input (debounced 200ms)
    function onKeyup(e: KeyboardEvent): void {
        if (["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) { return; }

        const code = getActiveInlineCode();
        if (!code) {
            closeDropdown();
            return;
        }

        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (!isDestroyed) { triggerSuggest(code); }
        }, 200);
    }

    function onWindowBlur(): void {
        closeDropdown();
    }

    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("keyup", onKeyup);
    window.addEventListener("blur", onWindowBlur);
    // Click elsewhere to close the dropdown. The dropdown is rebuilt per
    // suggestion reply, hence the getter; the no-dropdown guard mirrors the
    // original handler (nothing to close).
    const outsideOff = onOutsideClick(
        () => [menu?.el],
        () => { if (menu) { closeDropdown(); } },
    );

    return function detach(): void {
        isDestroyed = true;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        closeDropdown();
        document.removeEventListener("keydown", onKeydown, true);
        document.removeEventListener("keyup", onKeyup);
        window.removeEventListener("blur", onWindowBlur);
        outsideOff();
    };
}
