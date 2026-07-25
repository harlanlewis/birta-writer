/**
 * ui/suggestList.ts — THE anchored suggestion dropdown.
 *
 * One widget behind every "type a fragment, pick from a list" surface: the
 * link URL fields, the caret autocompletes (link, wikilink, heading anchor),
 * the inline calc offers, the list-merge advisory, the section-link picker,
 * and the two path completions (inline code and the image path field). It
 * owns render, the ARIA listbox model, the keyboard HIGHLIGHT state, and
 * viewport placement; the key BINDINGS stay with each caller, whose contracts
 * genuinely differ (the image field delegates Enter/Escape when closed, the
 * inline-code dropdown listens on `document`, the link field must let a bare
 * Enter confirm).
 *
 * It grew inside linkTargetComplete.ts and was extracted here by MAR-220,
 * where two hand-rolled near-copies had drifted into user-visible bugs (no
 * IME guard, no viewport clamp, a missing row primitive, listeners that were
 * never detached). The class names it emits are still the `.fm-suggest-*`
 * family it was born with — they are asserted across a dozen suites and
 * shared with the frontmatter chip menu, so renaming them is churn for a
 * separate ticket. `suggestList.css` carries the surface deltas.
 */
import { computeAnchoredPosition, viewportSize } from "./anchoredPlacement";

// Monotonic per-menu counter, so each rendered suggest menu's option ids are
// globally unique (aria-activedescendant / option-id references never collide
// across two menus that briefly coexist).
let suggestMenuSeq = 0;

/** A rendered suggestion dropdown (see createSuggestMenuFromRows). */
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

/** One row of a suggest menu. */
export interface SuggestRowDef {
    /**
     * The value picked. It is also the row's visible text UNLESS `render`
     * takes the row over — the path dropdowns pick a full path while showing
     * only its last segment.
     */
    text: string;
    title?: string;
    /** Right-aligned dimmed hint (e.g. the confirm key, "Tab"). */
    hint?: string;
    /** Styled as a secondary action row (top border, dimmer text). */
    action?: boolean;
    /**
     * Takes over the row's CONTENT: when present the shell writes no label of
     * its own, so the callback owns both the leading affordance (a file icon,
     * an image thumbnail) and the label element. Used by the path dropdowns,
     * whose displayed text is not the value they pick.
     */
    render?: (li: HTMLElement) => void;
}

export interface SuggestMenuOptions {
    /**
     * One dimmed, non-interactive teaching line under the rows (the slash
     * menu's footer pattern): never picked, never highlighted, aria-hidden
     * — the keyboard model is entirely the rows above it.
     */
    footer?: string;
    /**
     * Extra surface class on the menu root, alongside the base classes, for
     * per-surface width caps and row layout (see suggestList.css).
     */
    className?: string;
    /**
     * Row highlighted when the menu opens. The default -1 (no highlight) is
     * DELIBERATE for the link/wikilink autocompletes: a bare Enter keeps its
     * normal meaning until an arrow key or hover selects a row. The path
     * dropdowns pass 0 — they are dedicated pickers where Enter accepting the
     * best match is the whole point.
     */
    initialActive?: number;
}

/**
 * Renders the anchored suggestion dropdown: rows, the ARIA listbox model,
 * mouse pick/hover, and the viewport flip. Returns null when there is
 * nothing to suggest.
 *
 * `onPick` receives the row's `text` AND its index. The index is what lets a
 * caller map back to a richer item than a string: the path dropdowns list one
 * directory level, where a folder `foo/` and a file `foo` render the same
 * segment, so a text lookup would be ambiguous.
 */
export function createSuggestMenuFromRows(
    rowDefs: ReadonlyArray<SuggestRowDef>,
    anchor: SuggestMenuAnchor,
    onPick: (text: string, index: number) => void,
    opts?: SuggestMenuOptions,
): LinkSuggestMenu | null {
    const rows = rowDefs.map((r) => r.text);
    if (rows.length === 0) { return null; }

    let activeIndex = opts?.initialActive ?? -1;
    // Set by keyboard navigation, cleared by a real pointer move: the
    // scrollIntoView below fires `mouseover` on whatever row slides under a
    // parked pointer, which would otherwise yank the highlight away from the
    // row the user just arrowed to.
    let suppressMouseover = false;
    // Stable per-menu id prefix so each option gets a unique, referenceable id
    // (the ARIA listbox/option model, mirroring blockMenu/menu.ts's combobox).
    const menuId = `fm-suggest-${++suggestMenuSeq}`;

    const div = document.createElement("div");
    div.className = "fm-suggest-menu link-target-menu";
    if (opts?.className) { div.classList.add(opts.className); }
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
    // highlight (see updateActive). This backs calc, section-link, the
    // link/wikilink autocompletes, and both path dropdowns.
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
        if (rowDefs[i].render) {
            // The row owns its content (icon/thumbnail + its own label).
            rowDefs[i].render!(li);
        } else if (rowDefs[i].hint) {
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
        li.addEventListener("mousedown", () => onPick(text, i));
        li.addEventListener("mousemove", () => { suppressMouseover = false; });
        li.addEventListener("mouseover", () => {
            if (suppressMouseover) { return; }
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
    if (activeIndex >= 0) { updateActive(); }

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
            suppressMouseover = true;
            updateActive();
        },
        pickActive(): boolean {
            if (activeIndex < 0 || activeIndex >= rows.length) { return false; }
            onPick(rows[activeIndex], activeIndex);
            return true;
        },
        destroy(): void {
            div.remove();
        },
    };
}
