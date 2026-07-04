/**
 * components/pathLink/linkTargetComplete.ts
 *
 * Anchored autocompletion for link URL inputs — the link hover popup's URL
 * field and the toolbar's insert-link prompt. Typing a local path surfaces
 * matching workspace files in a dropdown styled like the frontmatter suggest
 * menu (.fm-suggest-* classes).
 *
 * Files are offered in the form matching what the user is reaching for:
 * document-relative ("../notion/index.md") by default, workspace-root-based
 * ("/write/notion/index.md") when the typed text starts with "/". External
 * targets (http/https/mailto/#anchor) never trigger suggestions.
 *
 * Flow mirrors imgPathComplete.ts: input (debounced 200ms) →
 * getLinkTargetSuggestions → linkTargetSuggestions reply → dropdown. The
 * reply is re-ranked against the input's LATEST value so a stale reply can
 * never show outdated options.
 */
import { notifyGetLinkTargetSuggestions } from "@/messaging";
import type { LinkTargetSuggestionItem } from "../../../shared/messages";
import {
    isLocalPathQuery,
    preferredLinkForm,
    rankLinkTargets,
} from "../../../shared/linkTargetSuggest";

type SuggestCallback = (items: LinkTargetSuggestionItem[]) => void;

// Reply callback registry: request id → resolve (ids are unique per request)
const _pendingSuggestions = new Map<string, SuggestCallback>();

/** Called by messageHandlers.ts to route a linkTargetSuggestions reply. */
export function dispatchLinkTargetSuggestions(
    id: string,
    items: LinkTargetSuggestionItem[],
): void {
    const cb = _pendingSuggestions.get(id);
    if (cb) {
        _pendingSuggestions.delete(id);
        cb(items);
    }
}

/**
 * Attaches workspace file autocompletion to a link URL <input>.
 *
 * Keyboard/blur behavior is strictly additive: keys are only intercepted
 * while the dropdown is open (Escape closes the menu first, Enter accepts
 * the highlight if there is one), so the input's own Enter/Escape handlers
 * (confirm/cancel) and its inputUndo attachment keep working untouched.
 * Returns a detach function.
 */
export function attachLinkTargetComplete(input: HTMLInputElement): () => void {
    let menu: HTMLDivElement | null = null;
    /** Display texts of the rendered rows (the exact strings inserted on pick). */
    let rows: string[] = [];
    let activeIndex = -1;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let isDestroyed = false;
    // Applying a suggestion re-fires "input" (for inputUndo); skip that one
    // so the accepted value does not immediately re-open the menu.
    let skipNextInput = false;

    function closeMenu(): void {
        if (menu) {
            menu.remove();
            menu = null;
        }
        rows = [];
        activeIndex = -1;
    }

    function updateActive(): void {
        if (!menu) { return; }
        menu.querySelectorAll("li").forEach((li, i) => {
            const isActive = i === activeIndex;
            li.classList.toggle("fm-suggest-item--focused", isActive);
            // Optional call: jsdom (unit tests) does not implement scrollIntoView.
            if (isActive) { li.scrollIntoView?.({ block: "nearest" }); }
        });
    }

    function applySelection(text: string): void {
        input.value = text;
        skipNextInput = true;
        // Notify inputUndo (and any other listeners) of the programmatic change
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        closeMenu();
        input.focus();
    }

    function showMenu(items: LinkTargetSuggestionItem[]): void {
        closeMenu();
        const query = input.value.trim();
        if (!isLocalPathQuery(query)) { return; }
        // Re-rank against the CURRENT input value: replies are async and the
        // user may have kept typing since the request was sent.
        const ranked = rankLinkTargets(items, query);
        rows = ranked.map((item) => preferredLinkForm(item, query));
        if (rows.length === 0) { return; }

        const div = document.createElement("div");
        div.className = "fm-suggest-menu link-target-menu";
        div.addEventListener("mousedown", (e) => {
            // preventDefault keeps focus in the input (a blur would close the
            // menu before the pick applies); stopPropagation keeps the hosting
            // popup/prompt's outside-click handlers from closing themselves.
            e.preventDefault();
            e.stopPropagation();
        });

        const list = document.createElement("ul");
        list.className = "fm-suggest-list";
        div.appendChild(list);

        const rect = input.getBoundingClientRect();
        div.style.top = `${rect.bottom + 2}px`;
        div.style.left = `${rect.left}px`;
        div.style.minWidth = `${rect.width}px`;

        rows.forEach((text, i) => {
            const li = document.createElement("li");
            li.className = "fm-suggest-item";
            li.textContent = text;
            li.title = ranked[i].rootRelative;
            li.addEventListener("mousedown", () => applySelection(text));
            li.addEventListener("mouseover", () => {
                activeIndex = i;
                updateActive();
            });
            list.appendChild(li);
        });

        document.body.appendChild(div);
        menu = div;
        // No default highlight: plain Enter keeps the input's normal confirm.
        activeIndex = -1;
    }

    function triggerSuggest(): void {
        const query = input.value.trim();
        if (!isLocalPathQuery(query)) {
            closeMenu();
            return;
        }
        const id = `lts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        _pendingSuggestions.set(id, (items) => {
            if (!isDestroyed) { showMenu(items); }
        });
        notifyGetLinkTargetSuggestions(id, query);
        // Drop the callback if no reply ever arrives
        setTimeout(() => { _pendingSuggestions.delete(id); }, 5000);
    }

    function onInput(): void {
        if (skipNextInput) {
            skipNextInput = false;
            return;
        }
        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (!isDestroyed) { triggerSuggest(); }
        }, 200);
    }

    // Registered in the capture phase so it runs before the input's own
    // (bubble-phase) Enter/Escape handlers; consumed keys are stopped with
    // stopImmediatePropagation so those handlers never see them.
    function onKeydown(e: KeyboardEvent): void {
        if (e.isComposing || !menu) { return; }

        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (e.key === "ArrowDown") {
                activeIndex = activeIndex >= rows.length - 1 ? 0 : activeIndex + 1;
            } else {
                activeIndex = activeIndex <= 0 ? rows.length - 1 : activeIndex - 1;
            }
            updateActive();
            return;
        }

        if (e.key === "Enter") {
            if (activeIndex >= 0 && activeIndex < rows.length) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                applySelection(rows[activeIndex]);
            } else {
                // No highlight: let the input's normal confirm run, but the
                // menu must not outlive the confirmed value.
                closeMenu();
            }
            return;
        }

        if (e.key === "Escape") {
            // Close the menu only; a second Escape reaches the input's own handler.
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            closeMenu();
            return;
        }
    }

    function onBlur(): void {
        // Menu mousedown calls preventDefault, so a blur here always means the
        // focus really left the input.
        closeMenu();
    }

    function onDocMousedown(e: MouseEvent): void {
        const target = e.target as Node;
        if (menu && !menu.contains(target) && target !== input) {
            closeMenu();
        }
    }

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeydown, true);
    input.addEventListener("blur", onBlur);
    document.addEventListener("mousedown", onDocMousedown, true);

    return function detach(): void {
        isDestroyed = true;
        if (debounceTimer) { clearTimeout(debounceTimer); }
        closeMenu();
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onKeydown, true);
        input.removeEventListener("blur", onBlur);
        document.removeEventListener("mousedown", onDocMousedown, true);
    };
}
