import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { IconChevronDown, IconChevronRight } from "../ui/icons";
import { applyTooltip, hideTooltip } from "../ui/tooltip";
import { t } from "../i18n";

export type HeadingFoldMeta = { type: "toggle"; pos: number };
type HeadingFoldRange = { from: number; to: number };

export const headingFoldPluginKey = new PluginKey<Set<number>>("heading-fold");

type ProseNodeLike = {
    type: { name: string };
    attrs?: Record<string, unknown>;
    nodeSize: number;
};

function isHeadingNode(node: ProseNodeLike | null | undefined): node is ProseNodeLike {
    return node?.type.name === "heading";
}

function getHeadingLevel(node: { attrs?: Record<string, unknown> }): number {
    const level = node.attrs?.["level"];
    return typeof level === "number" ? level : 1;
}

/**
 * The gutter label for a heading: its literal Markdown hashes (`#`..`######`).
 * A level cue that reads as source, iA-Writer-style. Exported for unit testing.
 */
export function headingMarker(level: number): string {
    return "#".repeat(Math.min(Math.max(level, 1), 6));
}

/**
 * Retype the block at `headingPos` to a heading of `level` (1–6), or to a
 * paragraph when `level` is 0. Targets the node BY POSITION, not the current
 * selection, so the gutter menu can change a heading the caret isn't inside.
 * Heading→heading preserves the node's other attrs (e.g. the TOC-anchor id);
 * →paragraph drops them. Returns false when the position isn't a heading or the
 * change is a no-op (same level). Exported for unit testing.
 */
export function setHeadingLevelAt(view: EditorView, headingPos: number, level: number): boolean {
    const node = view.state.doc.nodeAt(headingPos);
    if (!isHeadingNode(node)) {
        return false;
    }
    const schema = view.state.schema;
    if (level <= 0) {
        const paragraph = schema.nodes["paragraph"];
        if (!paragraph) {
            return false;
        }
        view.dispatch(view.state.tr.setNodeMarkup(headingPos, paragraph, null));
    } else {
        const heading = schema.nodes["heading"];
        if (!heading) {
            return false;
        }
        const clamped = Math.min(Math.max(Math.round(level), 1), 6);
        if (getHeadingLevel(node) === clamped) {
            return false;
        }
        view.dispatch(view.state.tr.setNodeMarkup(headingPos, heading, { ...node.attrs, level: clamped }));
    }
    view.focus();
    return true;
}

// The block-type choices offered by the gutter menu: paragraph (level 0) then
// H1–H6, mirroring the toolbar's Format dropdown labels.
const HEADING_LEVEL_CHOICES: { level: number; label: string }[] = [
    { level: 0, label: "P" },
    { level: 1, label: "H1" },
    { level: 2, label: "H2" },
    { level: 3, label: "H3" },
    { level: 4, label: "H4" },
    { level: 5, label: "H5" },
    { level: 6, label: "H6" },
];

// Only one gutter menu is open at a time; opening (or clicking the same marker
// again) closes the previous one.
let closeActiveHeadingLevelMenu: (() => void) | null = null;

/**
 * Open a small popup anchored to a heading's gutter marker, letting the user
 * retype that heading (P / H1–H6). The current level is checkmarked. Positioned
 * below the marker and clamped to the viewport; closes on pick, outside click,
 * or Escape. Body-mounted (outside the editor) like the other chrome popups.
 * `viaKeyboard` moves focus onto the current-level row so arrows/Enter can drive
 * it; a mouse open leaves focus in the editor (mirrors wireHoverMenu).
 */
function openHeadingLevelMenu(
    view: EditorView,
    headingPos: number,
    currentLevel: number,
    anchor: HTMLElement,
    viaKeyboard: boolean,
): void {
    // Toggle: a second click on the SAME marker closes its menu instead of
    // reopening it. Read the open-state before closing (close() clears the
    // class), so re-clicking the marker that owns the open menu just closes it,
    // while clicking a different marker closes the old menu and opens a new one.
    const reopeningSameMarker = anchor.classList.contains("heading-fold-marker--menu-open");
    closeActiveHeadingLevelMenu?.();
    if (reopeningSameMarker) {
        return;
    }

    const menu = document.createElement("div");
    menu.className = "heading-level-menu";
    menu.setAttribute("role", "menu");

    // Ignore mousedowns on the anchor itself: the marker's own click handler
    // owns the toggle, so closing here would race it (close-then-reopen).
    const onDocMouseDown = (event: MouseEvent): void => {
        const target = event.target as Node;
        if (!menu.contains(target) && !anchor.contains(target)) {
            close();
        }
    };
    const rowEls = (): HTMLElement[] =>
        Array.from(menu.querySelectorAll<HTMLElement>(".heading-level-item"));
    const focusRow = (el: HTMLElement | undefined): void => {
        el?.focus();
    };
    // Keyboard model mirrors wireHoverMenu (the toolbar dropdowns): arrows rove
    // over the rows, Enter/Space activate the focused row by replaying the
    // mousedown its handler listens for, Escape closes and restores marker
    // focus. Attached to the document (capture) so Escape works whether the
    // menu was opened by mouse (focus still in the editor) or keyboard.
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
            anchor.focus();
            return;
        }
        const list = rowEls();
        const idx = list.indexOf(event.target as HTMLElement);
        if (idx === -1) {
            return; // focus isn't on a row (mouse-opened, caret in editor)
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            focusRow(list[(idx + delta + list.length) % list.length]);
        } else if (event.key === "Enter" || event.key === " ") {
            // preventDefault suppresses the native keyboard click the focused
            // <button> would fire, so the replayed mousedown runs the action once.
            event.preventDefault();
            list[idx]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        }
    };
    // Tabbing out of the menu closes it (focus moving between rows does not).
    const onFocusOut = (event: FocusEvent): void => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || (!menu.contains(next) && next !== anchor)) {
            close();
        }
    };
    function close(): void {
        if (closeActiveHeadingLevelMenu === close) {
            closeActiveHeadingLevelMenu = null;
        }
        anchor.classList.remove("heading-fold-marker--menu-open");
        document.removeEventListener("mousedown", onDocMouseDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        menu.removeEventListener("focusout", onFocusOut);
        menu.remove();
    }

    let activeRow: HTMLElement | null = null;
    for (const { level, label } of HEADING_LEVEL_CHOICES) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "heading-level-item";
        row.setAttribute("role", "menuitemradio");
        row.tabIndex = -1;
        const active = level === currentLevel;
        row.setAttribute("aria-checked", active ? "true" : "false");
        row.classList.toggle("heading-level-item--active", active);
        if (active) {
            activeRow = row;
        }

        const check = document.createElement("span");
        check.className = "menu-check";
        check.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "heading-level-item-label";
        text.textContent = label;
        row.append(check, text);

        row.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            close();
            setHeadingLevelAt(view, headingPos, level);
        });
        menu.appendChild(row);
    }

    document.body.appendChild(menu);
    anchor.classList.add("heading-fold-marker--menu-open");
    menu.addEventListener("focusout", onFocusOut);

    // Position below the marker, flipping/clamping to stay on screen.
    const rect = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = rect.left;
    if (left + mw > window.innerWidth - 8) {
        left = window.innerWidth - 8 - mw;
    }
    left = Math.max(8, left);
    let top = rect.bottom + 4;
    if (top + mh > window.innerHeight - 8) {
        top = rect.top - 4 - mh;
    }
    top = Math.max(8, top);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    closeActiveHeadingLevelMenu = close;
    // Defer the outside-click listener so the opening click doesn't close it.
    setTimeout(() => document.addEventListener("mousedown", onDocMouseDown, true), 0);
    document.addEventListener("keydown", onKeyDown, true);
    hideTooltip();

    // Keyboard open: land on the current level so arrows/Enter work immediately.
    // Mouse open leaves the editor selection focused, like the toolbar menus.
    if (viaKeyboard) {
        focusRow(activeRow ?? rowEls()[0]);
    }
}

function findHeadingFoldRange(doc: any, headingPos: number, headingLevel: number): HeadingFoldRange | null {
    const headingNode = doc.nodeAt(headingPos);
    if (!isHeadingNode(headingNode)) {
        return null;
    }

    const from = headingPos + headingNode.nodeSize;
    let to = doc.content.size;
    doc.forEach((node: any, offset: number) => {
        if (offset <= headingPos || !isHeadingNode(node)) {
            return;
        }
        if (getHeadingLevel(node) <= headingLevel && to === doc.content.size) {
            to = offset;
        }
    });

    return from < to ? { from, to } : null;
}

function cleanFoldedHeadingPositions(doc: any, folded: Iterable<number>): Set<number> {
    const next = new Set<number>();
    for (const pos of folded) {
        if (isHeadingNode(doc.nodeAt(pos))) {
            next.add(pos);
        }
    }
    return next;
}

function createHeadingFoldGutter(
    view: EditorView,
    headingPos: number,
    level: number,
    collapsed: boolean,
    foldable: boolean,
): HTMLElement {
    const gutter = document.createElement("span");
    gutter.className = `heading-fold-gutter${foldable ? " heading-fold-gutter--foldable" : ""}`;
    gutter.contentEditable = "false";

    // The marker is a button: clicking its literal Markdown hashes (`#`..
    // `######`) opens a menu to retype the heading (P / H1–H6) — a level cue
    // that doubles as a level control, iA-Writer-style. The widget key encodes
    // `level`, so the hashes repaint live as the heading level changes (via the
    // heading commands, this menu, or a typed `#`-space). Setext headings carry
    // no hashes in their source but still show `#`/`##` here — the gutter is a
    // level cue in this WYSIWYG view, not a byte mirror, and their source
    // round-trips as setext untouched. It sits to the RIGHT of the fold chevron
    // (distinct click targets), so the two never overlap.
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "heading-fold-marker";
    marker.textContent = headingMarker(level);
    const markerTip = t("Change heading level");
    marker.setAttribute("aria-label", markerTip);
    marker.setAttribute("aria-haspopup", "menu");
    applyTooltip(marker, markerTip, { placement: "above" });
    // mousedown: keep the editor selection/caret; click: open the menu.
    marker.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // A keyboard-activated button click reports detail 0 (no mouse click
        // count) — use it to move focus into the menu only for keyboard opens.
        openHeadingLevelMenu(view, headingPos, level, marker, event.detail === 0);
    });

    if (!foldable) {
        gutter.appendChild(marker);
        return gutter;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "heading-fold-toggle";
    button.innerHTML = collapsed ? IconChevronRight : IconChevronDown;
    const tipText = collapsed ? t("Expand content") : t("Collapse content");
    button.setAttribute("aria-label", tipText);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    applyTooltip(button, tipText, { placement: "above" });

    button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const node = view.state.doc.nodeAt(headingPos);
        if (!isHeadingNode(node)) {
            return;
        }

        const tr = view.state.tr
            .setMeta(headingFoldPluginKey, { type: "toggle", pos: headingPos } satisfies HeadingFoldMeta)
            .setMeta("addToHistory", false);

        if (!collapsed) {
            const range = findHeadingFoldRange(view.state.doc, headingPos, getHeadingLevel(node));
            if (
                range &&
                view.state.selection.from < range.to &&
                view.state.selection.to > range.from
            ) {
                tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(headingPos + 1, tr.doc.content.size))));
            }
        }

        view.dispatch(tr);
        view.focus();
        hideTooltip();
    });

    gutter.appendChild(button);
    gutter.appendChild(marker);
    return gutter;
}

function buildHeadingFoldDecorations(doc: any, folded: ReadonlySet<number>): DecorationSet {
    const decorations: Decoration[] = [];
    const hiddenRanges: HeadingFoldRange[] = [];

    doc.forEach((node: any, offset: number) => {
        if (!isHeadingNode(node)) {
            return;
        }

        const level = getHeadingLevel(node);
        const collapsed = folded.has(offset);
        const range = findHeadingFoldRange(doc, offset, level);
        const foldable = Boolean(range);

        decorations.push(
            Decoration.node(offset, offset + node.nodeSize, {
                class: `heading-fold-heading${foldable ? " heading-fold-heading--foldable" : ""}${collapsed ? " heading-fold-heading--collapsed" : ""}`,
                "data-heading-level": String(level),
            }),
        );
        decorations.push(
            Decoration.widget(
                offset + 1,
                (view) => createHeadingFoldGutter(view, offset, level, collapsed, foldable),
                {
                    key: `heading-fold-gutter-${offset}-${level}-${collapsed ? "closed" : "open"}-${foldable ? "foldable" : "leaf"}`,
                    side: -1,
                },
            ),
        );

        if (collapsed && range) {
            hiddenRanges.push(range);
        }
    });

    if (hiddenRanges.length > 0) {
        doc.forEach((node: any, offset: number) => {
            if (hiddenRanges.some((range) => offset >= range.from && offset < range.to)) {
                decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                        class: "heading-fold-hidden",
                    }),
                );
            }
        });
    }

    return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function isHeadingElement(element: Element | null): element is HTMLElement {
    return element instanceof HTMLElement && element.matches("h1,h2,h3,h4,h5,h6");
}

function findSectionHeadingPosAt(view: EditorView, pos: number): number | null {
    let headingPos: number | null = null;
    const searchTo = Math.min(Math.max(pos, 0), view.state.doc.content.size);

    view.state.doc.nodesBetween(0, searchTo, (node, nodePos) => {
        if (!isHeadingNode(node)) {
            return;
        }

        const range = findHeadingFoldRange(view.state.doc, nodePos, getHeadingLevel(node));
        if (range && nodePos <= pos && pos < range.to) {
            headingPos = nodePos;
        }
    });

    return headingPos;
}

function getHeadingGutter(heading: HTMLElement | null): HTMLElement | null {
    return heading?.querySelector<HTMLElement>(".heading-fold-gutter--foldable") ?? null;
}

function getHeadingElementAtPos(view: EditorView, pos: number): HTMLElement | null {
    const dom = view.nodeDOM(pos);
    return isHeadingElement(dom as Element | null) ? dom as HTMLElement : null;
}

export const headingFoldPlugin = $prose(() =>
    new Plugin<Set<number>>({
        key: headingFoldPluginKey,
        state: {
            init: () => new Set<number>(),
            apply(tr, value, _oldState, newState) {
                let next = value;

                if (tr.docChanged) {
                    next = new Set<number>();
                    for (const pos of value) {
                        const mapped = tr.mapping.map(pos, -1);
                        if (isHeadingNode(newState.doc.nodeAt(mapped))) {
                            next.add(mapped);
                        }
                    }
                    next = cleanFoldedHeadingPositions(newState.doc, next);
                }

                const meta = tr.getMeta(headingFoldPluginKey) as HeadingFoldMeta | undefined;
                if (meta?.type === "toggle") {
                    next = new Set<number>(next);
                    if (next.has(meta.pos)) {
                        next.delete(meta.pos);
                    } else if (isHeadingNode(newState.doc.nodeAt(meta.pos))) {
                        next.add(meta.pos);
                    }
                }

                return next;
            },
        },
        props: {
            decorations(state) {
                return buildHeadingFoldDecorations(state.doc, headingFoldPluginKey.getState(state) ?? new Set<number>());
            },
        },
        view(view) {
            let hoveredGutter: HTMLElement | null = null;

            const clearHoveredGutter = () => {
                hoveredGutter?.classList.remove("heading-fold-gutter--section-hover");
                hoveredGutter = null;
            };

            const setHoveredGutter = (gutter: HTMLElement | null) => {
                if (gutter === hoveredGutter) {
                    return;
                }
                clearHoveredGutter();
                hoveredGutter = gutter;
                hoveredGutter?.classList.add("heading-fold-gutter--section-hover");
            };

            const handleMouseMove = (event: MouseEvent) => {
                const target = event.target as Element | null;
                const directHeading = target?.closest("h1,h2,h3,h4,h5,h6") ?? null;
                if (directHeading && view.dom.contains(directHeading)) {
                    setHoveredGutter(getHeadingGutter(isHeadingElement(directHeading) ? directHeading : null));
                    return;
                }

                const coords = view.posAtCoords({
                    left: event.clientX,
                    top: event.clientY,
                });
                const headingPos = coords ? findSectionHeadingPosAt(view, coords.pos) : null;
                setHoveredGutter(headingPos === null ? null : getHeadingGutter(getHeadingElementAtPos(view, headingPos)));
            };

            view.dom.addEventListener("mousemove", handleMouseMove);
            view.dom.addEventListener("mouseleave", clearHoveredGutter);

            return {
                update() {
                    if (hoveredGutter && !view.dom.contains(hoveredGutter)) {
                        hoveredGutter = null;
                    }
                },
                destroy() {
                    view.dom.removeEventListener("mousemove", handleMouseMove);
                    view.dom.removeEventListener("mouseleave", clearHoveredGutter);
                    clearHoveredGutter();
                },
            };
        },
    }),
);
