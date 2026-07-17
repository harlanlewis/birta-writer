/**
 * webview/plugins/headingFold/foldGutter.ts
 *
 * Gutter DOM construction: the fold chevrons, the block/heading marker
 * buttons (and the one shared protocol wiring them), the `…` ellipsis
 * widgets, and the MarkerSpec glyph registry the decoration pass renders
 * from. Everything here is widget-factory code — positions are derived at
 * INTERACTION time (gutterBlockPos), never captured at build time.
 */
import type { EditorView } from "../../pm";
import {
    IconAlertCircle,
    IconCheckSquare,
    IconChevronDown,
    IconChevronRight,
    IconCode,
    IconFootnote,
    IconImage,
    IconList,
    IconListOrdered,
    IconMath,
    IconNetwork,
    IconPilcrow,
    IconQuote,
    IconTable,
    IconTerminal,
} from "../../ui/icons";
import { applyTooltip, hideTooltip } from "../../ui/tooltip";
import { createFoldEllipsis } from "../../ui/foldEllipsis";
import { t } from "../../i18n";
import { isTextBearingParagraph } from "../../blockCapabilities";
// Runtime-only cycle (blockMenu imports this module's pure helpers back);
// both sides touch the other only inside event handlers / decoration passes,
// matching the slashMenu plugin ↔ component precedent.
import { openBlockMenu } from "../../components/blockMenu";
import { wireMarkerDrag } from "../../components/blockMenu/drag";
import { foldPluginKey, type FoldMeta } from "../foldState";
import {
    foldEscapeSelection,
    foldHiddenRange,
    getHeadingLevel,
    isFoldableKindNode,
    isHeadingNode,
} from "./foldModel";

/**
 * The document position of the block a gutter widget belongs to, derived at
 * INTERACTION time from the widget's own DOM position. The cached decoration
 * set is position-mapped through edits without rebuilding widget DOM, so a
 * position captured at build time would go stale — this never can. Null when
 * the widget is no longer in the view.
 */
function gutterBlockPos(view: EditorView, gutter: HTMLElement): number | null {
    if (!gutter.isConnected) {
        return null;
    }
    try {
        // The widget sits at blockPos + 1 (just inside the block).
        return view.posAtDOM(gutter, 0) - 1;
    } catch {
        return null;
    }
}

/**
 * The one marker-button protocol, shared by ALL block-handle buttons so the
 * click/drag/menu/aria wiring can never diverge between them (it churned
 * across four critique-round commits; a one-sided fix would make headings
 * and paragraphs respond differently). Two call sites own every handle:
 *   - createMarkerButton below (in-flow gutter badges and block icons),
 *     with `draggable: true`;
 *   - headingSticky's setStickyContent (the sticky heading's H-badge), with
 *     `draggable: false` — encoding the sticky's fixed-mirror property: it
 *     opens the same menu but is deliberately not a grabbable block.
 *
 * `name` is the block's identity for assistive tech ("H2 — Block options",
 * "Table — Block options"): with the action alone, a screen-reader scan
 * heard an undifferentiated stream of identical buttons.
 *
 * `blockPos` is resolved at INTERACTION time (never captured at build time —
 * both callers' positions drift as content above shifts); null means the
 * handle's block is gone and the click is a quiet no-op.
 */
export function wireMarkerButtonProtocol(
    marker: HTMLButtonElement,
    view: EditorView,
    name: string,
    blockPos: () => number | null,
    opts: { draggable: boolean },
): void {
    marker.setAttribute("aria-label", `${name} — ${t("Block options")}`);
    marker.setAttribute("aria-haspopup", "menu");
    marker.setAttribute("aria-expanded", "false");
    applyTooltip(
        marker,
        opts.draggable ? t("Click for options · Drag to move") : t("Click for options"),
        { placement: "above" },
    );
    // mousedown: keep the editor selection/caret; click: open the menu.
    marker.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    // The in-flow widgets live inside the contentEditable root, so
    // activation keys on a FOCUSED marker would bubble to ProseMirror and
    // type into the document; handle them here as button activation instead.
    // Safe unconditionally: preventDefault on the keydown suppresses the
    // native button activation click (Enter fires it on keydown, Space on
    // keyup — both cancelled by the prevented keydown), so the body-mounted
    // sticky badge gets exactly one click too, never a double fire.
    marker.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            marker.click();
        }
    });
    marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // A drag that started on this marker must not also open the menu.
        // (Without drag wiring the flag is never set — the check is inert.)
        if (marker.dataset["dragged"]) {
            delete marker.dataset["dragged"];
            return;
        }
        const pos = blockPos();
        if (pos === null) {
            return;
        }
        // The open menu supersedes the handle's tooltip (which otherwise
        // lingers over it — the fixed-position sticky badge exhibited this).
        hideTooltip();
        // A keyboard-activated button click reports detail 0 (no mouse click
        // count) — use it to move focus into the menu only for keyboard opens.
        openBlockMenu(view, pos, marker, event.detail === 0);
    });
    if (opts.draggable) {
        wireMarkerDrag(view, marker, blockPos);
    }
}

/** An in-flow gutter handle: a rendered badge/icon button wired with the
 * shared protocol above, its position derived from the gutter's own DOM. */
function createMarkerButton(
    view: EditorView,
    gutter: HTMLElement,
    name: string,
    className: string,
    render: (el: HTMLButtonElement) => void,
): HTMLButtonElement {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = className;
    render(marker);
    wireMarkerButtonProtocol(marker, view, name, () => gutterBlockPos(view, gutter), {
        draggable: true,
    });
    return marker;
}

/**
 * The one fold-chevron protocol, shared by every foldable kind's gutter
 * (MAR-110/125): derive the block position at interaction time, dispatch
 * the shared toggle meta with zero steps and no history entry, and eject a
 * selection that would otherwise end up inside the newly hidden range.
 */
function createFoldToggle(view: EditorView, gutter: HTMLElement, collapsed: boolean): HTMLButtonElement {
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
    // Same contentEditable leak as the markers: Enter/Space on the focused
    // chevron must toggle the fold, not type into the document.
    button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            button.click();
        }
    });
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const blockPos = gutterBlockPos(view, gutter);
        const node = blockPos === null ? null : view.state.doc.nodeAt(blockPos);
        if (blockPos === null || !isFoldableKindNode(node)) {
            return;
        }

        const tr = view.state.tr
            .setMeta(foldPluginKey, { type: "toggle", pos: blockPos } satisfies FoldMeta)
            .setMeta("addToHistory", false);

        if (!collapsed) {
            const range = foldHiddenRange(view.state.doc, blockPos);
            if (
                range &&
                view.state.selection.from < range.to &&
                view.state.selection.to > range.from
            ) {
                tr.setSelection(foldEscapeSelection(tr, node, blockPos));
            }
        }

        view.dispatch(tr);
        view.focus();
        hideTooltip();
    });
    return button;
}

export function createHeadingFoldGutter(
    view: EditorView,
    level: number,
    collapsed: boolean,
    foldable: boolean,
): HTMLElement {
    const gutter = document.createElement("span");
    gutter.className = `heading-fold-gutter${foldable ? " heading-fold-gutter--foldable" : ""}`;
    gutter.contentEditable = "false";

    // The marker is a button: clicking the level badge opens a menu to
    // retype the heading (P / H1–H6) — a level cue that doubles as a level
    // control, iA-Writer-style. The widget key encodes `level`, so the badge
    // repaints live as the heading level changes (via the heading commands,
    // this menu, or a typed `#`-space). Setext headings carry no hashes in
    // their source but still show the badge — the gutter is a level cue in
    // this WYSIWYG view, not a byte mirror, and their source round-trips as
    // setext untouched. It sits to the RIGHT of the fold chevron (distinct
    // click targets), so the two never overlap. "H2" is the same identity
    // the slash menu's heading rows show in their icon slot.
    const badge = `H${Math.min(Math.max(level, 1), 6)}`;
    const marker = createMarkerButton(view, gutter, badge, "heading-fold-marker", (el) => {
        el.textContent = badge;
        el.dataset["pill"] = badge;
    });

    if (!foldable) {
        gutter.appendChild(marker);
        return gutter;
    }

    gutter.appendChild(createFoldToggle(view, gutter, collapsed));
    gutter.appendChild(marker);
    return gutter;
}

/** Chevron state for a foldable non-heading block's gutter (callouts). */
export interface GutterFoldInfo {
    foldable: boolean;
    collapsed: boolean;
}

/**
 * The non-heading twin of the heading gutter: the block's slash-menu icon
 * (pilcrow, list flavor, quote, code, image, …), invisible until its block
 * is hovered (CSS), opening the block menu at full contrast when interacted
 * with — so every top-level block's conversions and actions are as reachable
 * as a heading's. Foldable blocks (callouts with a body) get the same fold
 * chevron headings carry, left of the marker (MAR-110).
 */
export function createBlockGutter(
    view: EditorView,
    spec: MarkerSpec,
    nestedDepth?: number,
    fold?: GutterFoldInfo,
): HTMLElement {
    const gutter = document.createElement("span");
    gutter.className = `heading-fold-gutter heading-fold-gutter--block${fold?.foldable ? " heading-fold-gutter--foldable" : ""}`;
    gutter.contentEditable = "false";
    if (nestedDepth !== undefined) {
        // Container children: the CSS positions the marker clear of every
        // ancestor container's border bar, one inset step per nesting level.
        // The capped depth CLASS pairs with the same class on the host so
        // hover-reveal can address "this host's own gutter" even when the
        // wrapper's NodeView buries it under chrome (see the reveal rules
        // in style.css — a plain descendant selector would pop deeper
        // children's markers along with the hovered host's own).
        gutter.classList.add("heading-fold-gutter--nested");
        gutter.classList.add(`heading-fold-gutter--d${Math.min(nestedDepth, 6)}`);
        gutter.style.setProperty("--nested-gutter-depth", String(nestedDepth));
    }

    // --paragraph kept as the P marker's stable test/back-compat hook; every
    // hover-revealed marker (including P) carries --block for shared styling.
    const marker = createMarkerButton(
        view,
        gutter,
        spec.label,
        `heading-fold-marker heading-fold-marker--block${spec.key === "P" ? " heading-fold-marker--paragraph" : ""}`,
        (el) => {
            if (spec.text !== undefined) {
                el.textContent = spec.text;
            } else {
                el.innerHTML = spec.icon;
            }
            el.dataset["pill"] = spec.label;
        },
    );

    if (fold?.foldable) {
        gutter.appendChild(createFoldToggle(view, gutter, fold.collapsed));
    }
    gutter.appendChild(marker);
    return gutter;
}

/**
 * The gutter glyph for a non-heading top-level block, or null for blocks that
 * get no marker. Glyphs mirror the markdown source, dimmed (the design
 * principle the heading hashes established): `-`/`1.`/`[ ]` lists, `>` quote,
 * `[!]` callout, ``` code, `![]` standalone image, `<>` raw HTML.
 *
 * Deliberately absent: leaf atoms — `---` (hr) and orphaned
 * link_definitions — which have no content position for the in-block widget
 * to ride on (nodeSize 1); they'd need an overlay-based handle. Tables DO
 * get a marker (grab/menu/drag) alongside their own grips/insert bars —
 * the two serve different jobs (block-level vs cell-level).
 */
/** A gutter marker's rendering: the same icon its slash-menu row uses (or
 * a text badge — nested headings show H1-H6 like the slash menu's heading
 * rows), a stable fingerprint/widget key, and the drag pill's name. */
export interface MarkerSpec {
    key: string;
    icon: string;
    label: string;
    /** Text badge instead of an SVG (heading "H2"). */
    text?: string;
}

export function blockMarkerSpec(node: any): MarkerSpec | null {
    switch (node.type.name) {
        case "paragraph": {
            if (isTextBearingParagraph(node)) {
                return { key: "P", icon: IconPilcrow, label: t("Paragraph") };
            }
            let sawImage = false;
            node.forEach((child: any) => {
                if (child.type.name === "image") {
                    sawImage = true;
                }
            });
            return sawImage
                ? { key: "img", icon: IconImage, label: t("Image") }
                : { key: "html", icon: IconCode, label: t("HTML") };
        }
        // Lists get PER-ITEM markers (emitItemGutters), not a list-level one.
        case "blockquote":
            return { key: "quote", icon: IconQuote, label: t("Blockquote") };
        case "callout":
        case "notion_callout":
            return { key: "callout", icon: IconAlertCircle, label: t("Callout") };
        case "container_directive":
            return { key: "directive", icon: IconAlertCircle, label: t("Directive") };
        case "code_block": {
            const language = String(node.attrs?.["language"] ?? "").toLowerCase();
            if (language === "mermaid") {
                return { key: "mermaid", icon: IconNetwork, label: t("Mermaid Diagram") };
            }
            if (language === "latex" || language === "tex" || language === "katex") {
                return { key: "math", icon: IconMath, label: t("Math Block") };
            }
            return { key: "code", icon: IconTerminal, label: t("Code Block") };
        }
        case "footnote_definition":
            return { key: "fn", icon: IconFootnote, label: t("Footnote") };
        case "table":
            // The menu gives kind-less blocks an actions-only menu (no Turn
            // into that would mangle a table); grab/menu/drag all apply.
            return { key: "table", icon: IconTable, label: t("Table") };
        default:
            return null;
    }
}

/** The marker for a block NESTED inside a container OR a list item: its
 * normal spec, with two exceptions — text paragraphs are the container's own
 * prose (the container's/item's marker is their handle; a P on every quoted or
 * item line is noise), and headings get a badge marker (nested headings don't
 * own fold sections, so no chevron machinery). Exported for the nesting-
 * position coverage guard (gutterCoverage.test.ts). */
export function nestedChildSpec(node: any): MarkerSpec | null {
    if (isHeadingNode(node)) {
        const level = Math.min(Math.max(getHeadingLevel(node), 1), 6);
        return { key: `h${level}`, icon: "", label: t("Heading"), text: `H${level}` };
    }
    const spec = blockMarkerSpec(node);
    return spec?.key === "P" ? null : spec;
}

/** The marker for ONE list item: the icon of its list flavor (matching the
 * slash menu's Bullet/Ordered/Task rows), uniform across items. */
export function itemMarkerSpec(listNode: any, item: any): MarkerSpec {
    if (item.attrs["checked"] != null) {
        return { key: "task", icon: IconCheckSquare, label: t("Task") };
    }
    if (listNode.type.name === "ordered_list") {
        return { key: "ol", icon: IconListOrdered, label: t("Numbered item") };
    }
    return { key: "ul", icon: IconList, label: t("List item") };
}

/** The collapsed list item's `…` widget: expand is a `set` meta targeting
 * the innermost FOLDED list-item ancestor derived at CLICK time (the
 * heading-ellipsis protocol applied to items). */
export function createItemEllipsis(view: EditorView, hiddenCount: number): HTMLElement {
    const ellipsis = createFoldEllipsis(hiddenCount, () => {
        if (!ellipsis.dom.isConnected) {
            return;
        }
        try {
            const folded = foldPluginKey.getState(view.state)?.folded;
            const $pos = view.state.doc.resolve(view.posAtDOM(ellipsis.dom, 0));
            for (let depth = $pos.depth; depth > 0; depth--) {
                const before = $pos.before(depth);
                if ($pos.node(depth).type.name === "list_item" && folded?.has(before)) {
                    view.dispatch(
                        view.state.tr
                            .setMeta(foldPluginKey, {
                                type: "set",
                                pos: before,
                                folded: false,
                            } satisfies FoldMeta)
                            .setMeta("addToHistory", false),
                    );
                    view.focus();
                    return;
                }
            }
        } catch {
            /* widget no longer resolvable — nothing to expand */
        }
    });
    return ellipsis.dom;
}

/** The heading's collapsed `…` widget (mirrors `editor.unfoldOnClickAfterEndOfLine`):
 * expand is a `set` meta targeting the heading derived at CLICK time. */
export function createHeadingEllipsis(view: EditorView, hiddenCount: number): HTMLElement {
    const ellipsis = createFoldEllipsis(hiddenCount, () => {
        if (!ellipsis.dom.isConnected) {
            return;
        }
        try {
            const $pos = view.state.doc.resolve(view.posAtDOM(ellipsis.dom, 0));
            if ($pos.depth < 1 || !isHeadingNode($pos.node(1))) {
                return;
            }
            view.dispatch(
                view.state.tr
                    .setMeta(foldPluginKey, {
                        type: "set",
                        pos: $pos.before(1),
                        folded: false,
                    } satisfies FoldMeta)
                    .setMeta("addToHistory", false),
            );
            view.focus();
        } catch {
            /* widget no longer resolvable — nothing to expand */
        }
    });
    return ellipsis.dom;
}
