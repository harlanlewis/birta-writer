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
 * ("/write/notion/index.md") when the typed text starts with "/". Same-
 * document heading anchors are offered too — alone for a `#…` query, and
 * alongside file matches when plain text matches a heading title or slug
 * (the `#` prefix is optional). External targets (http/https/mailto) never
 * trigger suggestions.
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
import {
    notifyGetLinkTargetSuggestions,
    notifyPickLinkTarget,
    notifyResolveLinkTarget,
} from "@/messaging";
import { getEditorView } from "@/editor";
import {
    collectHeadingSuggestions,
    filterHeadingSuggestions,
} from "@/utils/headingSuggest";
import { computeAnchoredPosition, viewportSize } from "@/ui/anchoredPlacement";
import { onOutsideClick } from "@/ui/outsideClick";
import type { LinkTargetSuggestionItem } from "../../../shared/messages";
import {
    isLocalPathQuery,
    preferredLinkForm,
    rankLinkTargets,
} from "../../../shared/linkTargetSuggest";

type SuggestCallback = (items: LinkTargetSuggestionItem[]) => void;

// Monotonic per-menu counter, so each rendered suggest menu's option ids are
// globally unique (aria-activedescendant / option-id references never collide
// across two menus that briefly coexist).
let suggestMenuSeq = 0;

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

type PickCallback = (path: string | null) => void;

// Reply callback registry for pickLinkTarget (ids unique per request).
const _pendingPicks = new Map<string, PickCallback>();

/** Called by messageHandlers.ts to route a linkTargetPicked reply. */
export function dispatchLinkTargetPicked(id: string, path: string | null): void {
    const cb = _pendingPicks.get(id);
    if (cb) {
        _pendingPicks.delete(id);
        cb(path);
    }
}

/**
 * Opens the OS-native file picker on the extension side; `cb` receives the
 * picked file as a document-relative path, or null on cancel. Unlike its
 * siblings the callback lives for 5 MINUTES — a native dialog waits on a
 * human, not a filesystem scan — and a genuinely lost reply only strands an
 * entry in the map, never UI state.
 */
export function requestPickLinkTarget(cb: PickCallback): void {
    const id = `ltp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    _pendingPicks.set(id, cb);
    notifyPickLinkTarget(id);
    setTimeout(() => { _pendingPicks.delete(id); }, 300_000);
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
    rowDefs: ReadonlyArray<{
        text: string;
        title?: string;
        /** Right-aligned dimmed hint (e.g. the confirm key, "Tab"). */
        hint?: string;
        /** Styled as a secondary action row (top border, dimmer text). */
        action?: boolean;
    }>,
    anchor: SuggestMenuAnchor,
    onPick: (text: string) => void,
    opts?: {
        /**
         * One dimmed, non-interactive teaching line under the rows (the slash
         * menu's footer pattern): never picked, never highlighted, aria-hidden
         * — the keyboard model is entirely the rows above it.
         */
        footer?: string;
    },
): LinkSuggestMenu | null {
    const rows = rowDefs.map((r) => r.text);
    if (rows.length === 0) { return null; }

    let activeIndex = -1;
    // Stable per-menu id prefix so each option gets a unique, referenceable id
    // (the ARIA listbox/option model, mirroring blockMenu/menu.ts's combobox).
    const menuId = `fm-suggest-${++suggestMenuSeq}`;

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
    // Assistive-tech model: the list is a listbox, each row an option, and the
    // focused option carries aria-selected in lockstep with its visual
    // highlight (see updateActive). This backs calc, section-link, and the
    // link/wikilink autocompletes — every consumer of this widget.
    list.setAttribute("role", "listbox");
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
            // aria-selected tracks the visual highlight so screen readers
            // announce the focused option as the row moves.
            li.setAttribute("aria-selected", isActive ? "true" : "false");
            // Optional call: jsdom (unit tests) does not implement scrollIntoView.
            if (isActive) { li.scrollIntoView?.({ block: "nearest" }); }
        });
    }

    rows.forEach((text, i) => {
        const li = document.createElement("li");
        li.className = "ui-menu-row fm-suggest-item";
        if (rowDefs[i].action) { li.classList.add("fm-suggest-item--action"); }
        li.id = `${menuId}-opt-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        if (rowDefs[i].hint) {
            // Label + right-aligned hint spans; textContent-only rows stay
            // plain so existing consumers (and their tests) are unaffected.
            const label = document.createElement("span");
            label.className = "fm-suggest-item__label";
            label.textContent = text;
            const hint = document.createElement("span");
            hint.className = "fm-suggest-item__hint";
            hint.setAttribute("aria-hidden", "true");
            hint.textContent = rowDefs[i].hint ?? "";
            li.append(label, hint);
        } else {
            li.textContent = text;
        }
        if (rowDefs[i].title) { li.title = rowDefs[i].title; }
        li.addEventListener("mousedown", () => onPick(text));
        li.addEventListener("mouseover", () => {
            activeIndex = i;
            updateActive();
        });
        list.appendChild(li);
    });

    if (opts?.footer) {
        const footer = document.createElement("div");
        footer.className = "fm-suggest-footer";
        footer.setAttribute("aria-hidden", "true");
        footer.textContent = opts.footer;
        div.appendChild(footer);
    }

    document.body.appendChild(div);

    // Viewport-bottom clamp: measured after appending (the height depends on
    // the rendered rows). Flip above the anchor when the menu would overflow
    // the bottom edge and the space above the anchor is larger than below —
    // the drop point (`top`) and flip line (`flipTop`) form a zero-gap rect.
    // Horizontal is untouched: the menu is min-width-pinned to its input.
    if (anchor.flipTop !== undefined) {
        const rect = div.getBoundingClientRect();
        const placed = computeAnchoredPosition(
            { left: anchor.left, right: anchor.left, top: anchor.flipTop, bottom: anchor.top },
            { width: rect.width, height: rect.height },
            viewportSize(),
            { gap: 0, fitSlack: 0 },
        );
        if (placed.above) {
            div.style.top = `${Math.max(0, placed.top)}px`;
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

    /** Renders `rows` anchored under the input (closes on zero rows). */
    function showRows(rows: Array<{ text: string; title?: string }>): void {
        if (rows.length === 0) { closeMenu(); return; }
        removeMenu();
        const rect = input.getBoundingClientRect();
        menu = createSuggestMenuFromRows(
            rows,
            { left: rect.left, top: rect.bottom + 2, flipTop: rect.top - 2, minWidth: rect.width },
            applySelection,
        );
    }

    /**
     * SAME-DOCUMENT heading anchors matching `needle` — the path to an
     * internal section link from the URL field. The source and ranking are
     * utils/headingSuggest.ts (shared with the `#` caret autocomplete and
     * the section-link picker, and model-consistent with the anchor
     * resolver, so a picked `#slug` always resolves). Rows write `#slug`
     * into the field. Local and synchronous — no extension roundtrip.
     * `allowEmpty` lists every heading for an empty needle (the browse state
     * behind a typed bare `#`); without it an empty needle offers nothing.
     */
    function headingAnchorRows(
        needle: string,
        allowEmpty = false,
    ): Array<{ text: string; title: string }> {
        if (!needle && !allowEmpty) { return []; }
        const view = getEditorView();
        if (!view) { return []; }
        return filterHeadingSuggestions(collectHeadingSuggestions(view.state.doc), needle)
            .map((h) => ({ text: `#${h.slug}`, title: h.title }));
    }

    function showMenu(items: LinkTargetSuggestionItem[]): void {
        // Replace any previous menu without bumping closeGeneration: rendering
        // a reply is not a user-initiated close, and it must not invalidate a
        // newer request that is still in flight. Rows are re-ranked against
        // the input's CURRENT value: replies are async and the user may have
        // kept typing since the request was sent. Heading anchors ride along
        // after the file matches — typing part of a heading's title or slug
        // offers the anchor without requiring the `#` prefix.
        const trimmed = input.value.trim();
        const fileRows = isLocalPathQuery(trimmed)
            ? rankLinkTargets(items, trimmed).map((item) => ({
                text: preferredLinkForm(item, trimmed),
                title: item.rootRelative,
            }))
            : [];
        showRows([...fileRows, ...headingAnchorRows(trimmed)]);
    }

    function triggerSuggest(): void {
        const query = input.value.trim();
        if (query.startsWith("#")) {
            // Anchors only; the bare `#` is the browse state (every heading).
            showRows(headingAnchorRows(query.slice(1), true));
            return;
        }
        if (!isLocalPathQuery(query)) {
            // Not a path — but part of a heading title/slug still offers the
            // same-document anchor (the `#` prefix is optional).
            showRows(headingAnchorRows(query));
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

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeydown, true);
    input.addEventListener("blur", onBlur);
    // The menu element is recreated per reply, hence the getter. The no-menu
    // guard keeps a stray outside click from bumping closeGeneration (which
    // would silently drop a reply still in flight).
    const outsideOff = onOutsideClick(
        () => [menu?.el, input],
        () => { if (menu) { closeMenu(); } },
    );

    return function detach(): void {
        isDestroyed = true;
        if (debounceTimer) { clearTimeout(debounceTimer); }
        closeMenu();
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onKeydown, true);
        input.removeEventListener("blur", onBlur);
        outsideOff();
    };
}
