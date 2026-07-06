import { notifyGetPathSuggestions, notifyResolveImagePath } from "@/messaging";
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
    let dropdown: HTMLUListElement | null = null;
    let activeIndex = -1;
    let lastItems: PathSuggestionItem[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let suppressMouseover = false;
    let isDestroyed = false;
    // After an autocomplete selection, skip clearing the dataset on the next onInput
    let skipDatasetClear = false;

    // ── Dropdown management ─────────────────────────────────────

    function closeDropdown(): void {
        if (dropdown) {
            dropdown.remove();
            dropdown = null;
        }
        activeIndex = -1;
        lastItems = [];
    }

    function updateActiveItem(): void {
        if (!dropdown) { return; }
        Array.from(dropdown.children).forEach((li, i) => {
            const isActive = i === activeIndex;
            li.classList.toggle("img-path-complete-item--active", isActive);
            if (isActive) {
                (li as HTMLElement).scrollIntoView({ block: "nearest" });
            }
        });
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

        if (item.isDir) {
            // A directory was selected: auto-expand the next level
            closeDropdown();
            setTimeout(() => {
                triggerSuggest();
            }, 50);
        } else {
            closeDropdown();
        }
    }

    function showDropdown(items: PathSuggestionItem[]): void {
        closeDropdown();
        // Keep only directories and image files (entries that have a webviewUri)
        const filtered = items.filter(item => item.isDir || item.webviewUri !== undefined);
        if (filtered.length === 0) { return; }
        lastItems = filtered;

        const rect = input.getBoundingClientRect();
        const ul = document.createElement("ul");
        ul.className = "img-path-complete-list";
        // position: fixed, so use viewport coordinates directly
        ul.style.top = `${rect.bottom + 2}px`;
        ul.style.left = `${rect.left}px`;
        ul.style.minWidth = `${rect.width}px`;

        filtered.forEach((item, i) => {
            const li = document.createElement("li");
            li.className = "img-path-complete-item";

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

            // Right: the file name (without a trailing slash; the full path is the title)
            const lastSeg = item.path.replace(/\/$/, "").split("/").pop() ?? item.path;
            const label = document.createElement("span");
            label.className = "img-complete-label";
            label.textContent = lastSeg;
            li.title = item.path;
            li.appendChild(label);

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

    // ── Trigger a completion request ────────────────────────────

    function triggerSuggest(): void {
        const query = input.value.trim();
        if (!query || !PATH_PREFIX_REGEX.test(query)) {
            closeDropdown();
            return;
        }

        const id = `ips_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        _pendingImgSuggestions.set(id, (items) => {
            if (!isDestroyed) {
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

        if (e.isComposing) { return; }

        // ── Enter / Escape: handle the dropdown first when open, otherwise delegate to the callbacks ──
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (dropdown && activeIndex >= 0 && activeIndex < lastItems.length) {
                applySelection(lastItems[activeIndex]);
            } else {
                onEnter?.();
            }
            return;
        }

        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (dropdown) {
                closeDropdown();
            } else {
                onEscape?.();
            }
            return;
        }

        if (!dropdown) { return; }

        // ── Dropdown arrow-key navigation ─────────────────────────
        if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            suppressMouseover = true;
            activeIndex = activeIndex >= lastItems.length - 1 ? 0 : activeIndex + 1;
            updateActiveItem();
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            suppressMouseover = true;
            activeIndex = activeIndex <= 0 ? lastItems.length - 1 : activeIndex - 1;
            updateActiveItem();
            return;
        }
        if (e.key === "Tab") {
            if (activeIndex >= 0 && activeIndex < lastItems.length) {
                e.preventDefault();
                e.stopPropagation();
                applySelection(lastItems[activeIndex]);
            }
            return;
        }
    }

    function onDocMousedown(e: MouseEvent): void {
        if (dropdown && !dropdown.contains(e.target as Node) && e.target !== input) {
            closeDropdown();
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
    document.addEventListener("mousedown", onDocMousedown, true);

    // ── cleanup ────────────────────────────────────────────────

    return function detach(): void {
        isDestroyed = true;
        if (debounceTimer) { clearTimeout(debounceTimer); }
        closeDropdown();
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onKeydown, true);
        input.removeEventListener("blur", onBlur);
        document.removeEventListener("mousedown", onDocMousedown, true);
    };
}
