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
 * reply is re-ranked against the input's LATEST value so a stale (debounced)
 * reply can never show outdated options.
 *
 * The request/reply machinery (requestLinkTargetSuggestions) and the menu
 * builder (createLinkSuggestMenu) are exported for reuse by the caret URL
 * autocomplete plugin (webview/plugins/linkUrlComplete.ts), which shows the
 * same dropdown anchored at the editor caret instead of under an <input>.
 */
import { notifyGetLinkTargetSuggestions, notifyResolveLinkTarget } from "@/messaging";
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
 * Posts a getLinkTargetSuggestions request and registers `cb` for its reply.
 * The callback is dropped after 5s if no reply ever arrives. Staleness
 * handling (the user closed the menu / kept typing) stays the caller's job.
 */
export function requestLinkTargetSuggestions(
    query: string,
    cb: SuggestCallback,
): void {
    const id = `lts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    _pendingSuggestions.set(id, cb);
    notifyGetLinkTargetSuggestions(id, query);
    // Drop the callback if no reply ever arrives
    setTimeout(() => { _pendingSuggestions.delete(id); }, 5000);
}

type ResolveCallback = (resolved: string | null) => void;

// Reply callback registry for resolveLinkTarget (ids unique per request).
const _pendingResolves = new Map<string, ResolveCallback>();

/** Called by messageHandlers.ts to route a linkTargetResolved reply. */
export function dispatchLinkTargetResolved(id: string, resolved: string | null): void {
    const cb = _pendingResolves.get(id);
    if (cb) {
        _pendingResolves.delete(id);
        cb(resolved);
    }
}

/**
 * Asks the host where a link path would open right now (the openFile
 * resolver, no side effects). Same contract as
 * requestLinkTargetSuggestions: the callback is dropped after 5s, staleness
 * handling stays the caller's job.
 */
export function requestLinkTargetResolve(
    path: string,
    wiki: boolean,
    cb: ResolveCallback,
): void {
    const id = `ltr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    _pendingResolves.set(id, cb);
    notifyResolveLinkTarget(id, path, wiki ? true : undefined);
    setTimeout(() => { _pendingResolves.delete(id); }, 5000);
}

/** A rendered suggestion dropdown (see createLinkSuggestMenu). */
export interface LinkSuggestMenu {
    /** The menu root, appended to document.body. */
    el: HTMLDivElement;
    /** Display texts of the rendered rows (the exact strings picked). */
    rows: string[];
    /** Moves the keyboard highlight down (+1) or up (-1), wrapping. */
    moveActive(delta: 1 | -1): void;
    /** Applies onPick to the highlighted row; false when none is highlighted. */
    pickActive(): boolean;
    /** Removes the menu DOM. */
    destroy(): void;
}

/** Anchor geometry shared by every suggest-menu placement. */
export interface SuggestMenuAnchor {
    left: number;
    /** Menu top (viewport y) when placed below the anchor. */
    top: number;
    /**
     * Viewport y the menu's BOTTOM edge should sit at when flipped above
     * the anchor (the anchor's top edge minus the gap). When provided,
     * the menu flips above whenever it would overflow the viewport
     * bottom and there is more room above the anchor than below it.
     */
    flipTop?: number;
    minWidth?: number;
}

/**
 * Renders the anchored workspace-file dropdown shared by the link URL
 * inputs and the caret autocomplete: ranks `items` against `query`
 * (re-ranking a possibly stale reply against the CURRENT query), renders
 * them in the form the user is reaching for, and wires mouse pick/hover.
 * Returns null when there is nothing to suggest.
 */
export function createLinkSuggestMenu(
    items: readonly LinkTargetSuggestionItem[],
    query: string,
    anchor: SuggestMenuAnchor,
    onPick: (text: string) => void,
): LinkSuggestMenu | null {
    const trimmed = query.trim();
    if (!isLocalPathQuery(trimmed)) { return null; }
    const ranked = rankLinkTargets(items, trimmed);
    return createSuggestMenuFromRows(
        ranked.map((item) => ({
            text: preferredLinkForm(item, trimmed),
            title: item.rootRelative,
        })),
        anchor,
        onPick,
    );
}

/**
 * The DOM half of the suggest menu, decoupled from path ranking so callers
 * with their own row shapes (the wikilink caret autocomplete) can reuse the
 * exact widget. Rows start with no highlight so plain Enter keeps its normal
 * meaning until an arrow key or hover selects a row.
 */
export function createSuggestMenuFromRows(
    rowDefs: ReadonlyArray<{ text: string; title?: string }>,
    anchor: SuggestMenuAnchor,
    onPick: (text: string) => void,
): LinkSuggestMenu | null {
    const rows = rowDefs.map((r) => r.text);
    if (rows.length === 0) { return null; }

    let activeIndex = -1;

    const div = document.createElement("div");
    div.className = "fm-suggest-menu link-target-menu";
    div.addEventListener("mousedown", (e) => {
        // preventDefault keeps focus where it is (a blur would close the
        // menu before the pick applies); stopPropagation keeps the hosting
        // popup/prompt's outside-click handlers from closing themselves.
        e.preventDefault();
        e.stopPropagation();
    });

    const list = document.createElement("ul");
    list.className = "fm-suggest-list";
    div.appendChild(list);

    div.style.top = `${anchor.top}px`;
    div.style.left = `${anchor.left}px`;
    if (anchor.minWidth !== undefined) {
        div.style.minWidth = `${anchor.minWidth}px`;
    }

    function updateActive(): void {
        list.querySelectorAll("li").forEach((li, i) => {
            const isActive = i === activeIndex;
            li.classList.toggle("fm-suggest-item--focused", isActive);
            // Optional call: jsdom (unit tests) does not implement scrollIntoView.
            if (isActive) { li.scrollIntoView?.({ block: "nearest" }); }
        });
    }

    rows.forEach((text, i) => {
        const li = document.createElement("li");
        li.className = "fm-suggest-item";
        li.textContent = text;
        if (rowDefs[i].title) { li.title = rowDefs[i].title; }
        li.addEventListener("mousedown", () => onPick(text));
        li.addEventListener("mouseover", () => {
            activeIndex = i;
            updateActive();
        });
        list.appendChild(li);
    });

    document.body.appendChild(div);

    // Viewport-bottom clamp: measured after appending (the height depends on
    // the rendered rows). Flip above the anchor when the menu would overflow
    // the bottom edge and the space above the anchor is larger than below.
    if (anchor.flipTop !== undefined) {
        const height = div.getBoundingClientRect().height;
        const overflowsBottom = anchor.top + height > window.innerHeight;
        const spaceBelow = window.innerHeight - anchor.top;
        if (overflowsBottom && anchor.flipTop > spaceBelow) {
            div.style.top = `${Math.max(0, anchor.flipTop - height)}px`;
        }
    }

    return {
        el: div,
        rows,
        moveActive(delta: 1 | -1): void {
            activeIndex = delta > 0
                ? (activeIndex >= rows.length - 1 ? 0 : activeIndex + 1)
                : (activeIndex <= 0 ? rows.length - 1 : activeIndex - 1);
            updateActive();
        },
        pickActive(): boolean {
            if (activeIndex < 0 || activeIndex >= rows.length) { return false; }
            onPick(rows[activeIndex]);
            return true;
        },
        destroy(): void {
            div.remove();
        },
    };
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
    let menu: LinkSuggestMenu | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let isDestroyed = false;
    // Applying a suggestion re-fires "input" (for inputUndo); skip that one
    // so the accepted value does not immediately re-open the menu.
    let skipNextInput = false;
    // Bumped on every deliberate close (blur, Escape, outside click, pick):
    // replies to requests issued before the last close are stale and must not
    // re-open a menu the user already dismissed.
    let closeGeneration = 0;

    /** Tears the menu DOM down without invalidating in-flight requests. */
    function removeMenu(): void {
        menu?.destroy();
        menu = null;
    }

    /** Closes the menu AND marks any in-flight suggestion request as stale. */
    function closeMenu(): void {
        closeGeneration++;
        removeMenu();
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
        // Replace any previous menu without bumping closeGeneration: rendering
        // a reply is not a user-initiated close, and it must not invalidate a
        // newer request that is still in flight. The menu builder re-ranks
        // against the input's CURRENT value: replies are async and the user
        // may have kept typing since the request was sent.
        removeMenu();
        const rect = input.getBoundingClientRect();
        menu = createLinkSuggestMenu(
            items,
            input.value,
            {
                left: rect.left,
                top: rect.bottom + 2,
                flipTop: rect.top - 2,
                minWidth: rect.width,
            },
            applySelection,
        );
    }

    function triggerSuggest(): void {
        const query = input.value.trim();
        if (!isLocalPathQuery(query)) {
            closeMenu();
            return;
        }
        const requestGeneration = closeGeneration;
        requestLinkTargetSuggestions(query, (items) => {
            // Ignore replies to requests issued before the last close: the
            // user dismissed the menu (blur/Escape) while this was in flight.
            if (!isDestroyed && requestGeneration === closeGeneration) { showMenu(items); }
        });
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
            menu.moveActive(e.key === "ArrowDown" ? 1 : -1);
            return;
        }

        if (e.key === "Enter") {
            if (menu.pickActive()) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
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
        if (menu && !menu.el.contains(target) && target !== input) {
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
