/**
 * components/imageView/imgPathComplete.ts
 *
 * Image-path autocompletion for the image toolbar's path field: typing a
 * path-looking fragment offers the directories and IMAGE files under it, with
 * a live thumbnail per row. Render, keyboard highlight, and viewport placement
 * come from the shared dropdown (`ui/suggestList.ts`); what stays here is what
 * is genuinely image-specific — the `webviewUri` filter and the
 * `dataset.imgWebviewUri` handoff that lets confirm() render the picked file
 * without a second resolve roundtrip.
 */
import { notifyGetPathSuggestions, notifyResolveImagePath } from "@/messaging";
import { onOutsideClick } from "@/ui/outsideClick";
import {
    createSuggestMenuFromRows,
    trackSuggestMenuAnchor,
    type LinkSuggestMenu,
} from "@/ui/suggestList";
import { getFileIcon } from "../pathLink/fileIcons";
import type { PathSuggestionItem } from "../../../shared/messages";

// ─── resolveImagePath async mechanism ────────────────────────
const _pendingResolve = new Map<string, (uri: string) => void>();

/** Called by index.ts when an imagePathResolved message arrives */
export function dispatchImagePathResolved(id: string, webviewUri: string): void {
    const cb = _pendingResolve.get(id);
    if (cb) { _pendingResolve.delete(id); cb(webviewUri); }
}

/** Resolve a relPath to a webviewUri (async; returns the original value on a 3s timeout) */
export function resolveToWebviewUri(relPath: string): Promise<string> {
    return new Promise((resolve) => {
        const id = `rip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
        const timer = setTimeout(() => {
            _pendingResolve.delete(id);
            resolve(relPath); // timeout fallback
        }, 3000);
        _pendingResolve.set(id, (uri) => {
            clearTimeout(timer);
            resolve(uri);
        });
        notifyResolveImagePath(id, relPath);
    });
}

// Path-prefix detection that triggers completion (kept consistent with pathComplete.ts)
const PATH_PREFIX_REGEX = /^(@\/|\.{1,2}\/|[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)/;

type SuggestCallback = (items: PathSuggestionItem[]) => void;

// Callback map: id → resolve (globally unique; each input is distinguished by id)
const _pendingImgSuggestions = new Map<string, SuggestCallback>();

/** Called from outside to dispatch a pathSuggestions message into this module */
export function dispatchImgPathSuggestions(id: string, items: PathSuggestionItem[]): void {
    const cb = _pendingImgSuggestions.get(id);
    if (cb) {
        _pendingImgSuggestions.delete(id);
        cb(items);
    }
}

/** The name a row shows: the last segment, without a trailing slash. */
function lastSegment(path: string): string {
    return path.replace(/\/$/, "").split("/").pop() ?? path;
}

/**
 * Attach image-path autocompletion to an <input> element.
 * @param onEnter  called on Enter when the dropdown is closed (i.e. confirm)
 * @param onEscape called on Escape when the dropdown is closed (i.e. cancel)
 * Returns a cleanup function that removes the event listeners and closes the dropdown.
 */
export function attachImgPathComplete(
    input: HTMLInputElement,
    onEnter?: () => void,
    onEscape?: () => void,
): () => void {
    let menu: LinkSuggestMenu | null = null;
    let lastItems: PathSuggestionItem[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let isDestroyed = false;
    // After an autocomplete selection, skip clearing the dataset on the next onInput
    let skipDatasetClear = false;
    // Bumped on every deliberate close (Escape, blur, outside click, pick):
    // replies to requests issued before the last close are stale and must not
    // re-open a dropdown the user already dismissed.
    let closeGeneration = 0;

    // ── Dropdown management ─────────────────────────────────────

    let reflowOff: (() => void) | null = null;

    function closeDropdown(): void {
        closeGeneration++;
        reflowOff?.();
        reflowOff = null;
        menu?.destroy();
        menu = null;
        lastItems = [];
    }

    function applySelection(item: PathSuggestionItem): void {
        // Show the relative path; if there's a webviewUri, store it in dataset so confirm() can use it to ensure the image renders
        input.value = item.path;
        if (item.webviewUri) {
            input.dataset.imgWebviewUri = item.webviewUri;
        } else {
            delete input.dataset.imgWebviewUri;
        }
        skipDatasetClear = true;
        // Cancel any queued debounce so selecting doesn't immediately re-trigger completion
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        input.focus();

        const wasDir = item.isDir;
        closeDropdown();
        if (wasDir) {
            // A directory was selected: auto-expand the next level
            setTimeout(() => {
                if (!isDestroyed) { triggerSuggest(); }
            }, 50);
        }
    }

    function showDropdown(items: PathSuggestionItem[]): void {
        closeDropdown();
        // Keep only directories and image files (entries that have a webviewUri)
        const filtered = items.filter(item => item.isDir || item.webviewUri !== undefined);
        if (filtered.length === 0) { return; }
        lastItems = filtered;

        // Viewport coordinates (the shell's menu is position:fixed); flipTop
        // lets a field near the bottom edge drop its list upward instead of
        // off-screen.
        const rect = input.getBoundingClientRect();
        menu = createSuggestMenuFromRows(
            filtered.map((item) => ({
                // The picked value is the FULL path while the row shows only
                // its last segment, so the row owns its own content.
                text: item.path,
                title: item.path,
                render: (li) => {
                    // Left: a thumbnail (image) or folder icon (directory)
                    if (item.webviewUri) {
                        const thumb = document.createElement("img");
                        thumb.className = "img-complete-thumb";
                        thumb.src = item.webviewUri;
                        thumb.alt = "";
                        li.appendChild(thumb);
                    } else {
                        const iconEl = document.createElement("span");
                        iconEl.className = "img-complete-icon";
                        iconEl.innerHTML = getFileIcon(item.path, item.isDir);
                        li.appendChild(iconEl);
                    }
                    const label = document.createElement("span");
                    label.className = "img-complete-label";
                    label.textContent = lastSegment(item.path);
                    li.appendChild(label);
                },
            })),
            {
                left: rect.left,
                top: rect.bottom + 2,
                flipTop: rect.top - 2,
                minWidth: rect.width,
            },
            // By INDEX, not text: one directory listing can hold a folder
            // `foo/` and a file `foo`, which render the same segment.
            (_text, i) => applySelection(lastItems[i]),
            { className: "img-path-complete-menu", initialActive: 0 },
        );
        reflowOff ??= trackSuggestMenuAnchor(input, () => menu, { pinWidth: true });
    }

    // ── Trigger a completion request ────────────────────────────

    function triggerSuggest(): void {
        const query = input.value.trim();
        if (!query || !PATH_PREFIX_REGEX.test(query)) {
            closeDropdown();
            return;
        }

        const id = `ips_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const requestGeneration = closeGeneration;
        _pendingImgSuggestions.set(id, (items) => {
            // Ignore replies to requests issued before the last close: the
            // user dismissed the dropdown while this one was in flight.
            if (!isDestroyed && requestGeneration === closeGeneration) {
                showDropdown(items);
            }
        });
        notifyGetPathSuggestions(id, query);

        // Timeout cleanup
        setTimeout(() => {
            _pendingImgSuggestions.delete(id);
        }, 5000);
    }

    // ── Event listeners ─────────────────────────────────────────

    function onInput(): void {
        // On the first onInput after an autocomplete selection, don't clear the dataset (dataset is how we tell manual input apart)
        if (skipDatasetClear) {
            skipDatasetClear = false;
        } else {
            delete input.dataset.imgWebviewUri;
        }
        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (!isDestroyed) { triggerSuggest(); }
        }, 200);
    }

    function onKeydown(e: KeyboardEvent): void {
        // Never interrupt an IME composition — the candidate window owns
        // Enter and the arrow keys while it is open.
        if (e.isComposing) { return; }

        // ── Enter / Escape: handle the dropdown first when open, otherwise delegate to the callbacks ──
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (!menu?.pickActive()) { onEnter?.(); }
            return;
        }

        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            // Close unconditionally: even with no dropdown up this invalidates
            // any in-flight request, so a reply can't drop a dropdown onto a
            // field the user just cancelled. Escape only reaches the caller's
            // cancel handler when there was nothing to dismiss first.
            const hadMenu = menu !== null;
            closeDropdown();
            if (!hadMenu) { onEscape?.(); }
            return;
        }

        if (!menu) { return; }

        // ── Dropdown arrow-key navigation ─────────────────────────
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            menu.moveActive(e.key === "ArrowDown" ? 1 : -1);
            return;
        }
        if (e.key === "Tab") {
            if (menu.pickActive()) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }
    }

    function onBlur(): void {
        // Delay closing so the mousedown's applySelection runs first
        setTimeout(() => {
            if (!isDestroyed) { closeDropdown(); }
        }, 150);
    }

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeydown, true);
    input.addEventListener("blur", onBlur);
    // The dropdown is rebuilt per suggestion reply, hence the getter; the
    // no-dropdown guard mirrors the original handler (nothing to close).
    const outsideOff = onOutsideClick(
        () => [menu?.el, input],
        () => { if (menu) { closeDropdown(); } },
    );

    // ── cleanup ────────────────────────────────────────────────

    return function detach(): void {
        isDestroyed = true;
        if (debounceTimer) { clearTimeout(debounceTimer); }
        closeDropdown();
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onKeydown, true);
        input.removeEventListener("blur", onBlur);
        outsideOff();
    };
}
