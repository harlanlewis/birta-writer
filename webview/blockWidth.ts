/**
 * webview/blockWidth.ts
 *
 * Per-block PRESENTATION PREFERENCES: width — Full Width (span the pane,
 * like the toolbar's page-level Full Width setting, but for one block) vs
 * the block's default sizing — for embed cards, images, code blocks, and
 * tables; plus the code block word-wrap override. One `bagMap` machinery,
 * one preference class: deliberate per-block choices that survive as long
 * as the workspace, never as bytes in the file.
 *
 * This is PRESENTATION-ONLY state and it NEVER reaches the serialized
 * markdown: embeds are view-only decorations with no attr slot at all, and an
 * unrepresentable node attr would be silently dropped by the serializer (a
 * no-op save with no feedback). So widths live beside the document, not in it:
 *
 *   - The live store is this module's Map, keyed by CONTENT-derived anchors
 *     (`embed:<url>`, `img:<path>`, `code:<first line>`, `table:<header>`) —
 *     the fold-anchor lesson: positions rot across external edits, content
 *     keys don't. Identical content is disambiguated by OCCURRENCE (`base`,
 *     `base#2`, `base#3`, … in document order) so two blocks are two blocks;
 *     see "Block identity" below for why that replaced sharing.
 *   - Persistence rides the webview STATE BAG (setWebviewState → VS Code's
 *     webview state + the extension's per-URI mirror, handed back on init) —
 *     exactly the fold/scroll/frontmatter-collapse lifetime, with the same
 *     graceful degradation: an anchor that no longer matches simply reverts
 *     the block to its default width. Never guessed, never written to disk.
 *
 * NodeViews re-anchor on content edits (renameBlockWidthAnchor from their
 * update()), so an in-session edit to a full-width block's first line moves
 * the preference along instead of orphaning it.
 *
 * The breakout geometry (a full-width block escaping a Fixed-width page
 * column) is pure CSS in style.css (`bw-*` rules); the one measurement CSS
 * cannot make — the pane's scrollbar-free width — is published as `--bw-pane`
 * by initPaneWidthVar(), one rAF-throttled resize listener.
 */
import { getWebviewState, setWebviewState } from "./messaging";
import type { Node as PmNode } from "./pm";
import { isOrderedNumbering, type OrderedNumbering } from "./utils/orderedMarkers";

/** Stored, non-default modes. Absence means the block's own default —
 * capped card (embeds), natural size (images), column width (code/tables). */
export type BlockWidthMode = "fixed" | "full";

/** Bounded so a long-lived workspace bag can't grow without limit; overflow
 * evicts oldest-first (Map insertion order). */
const MAX_ENTRIES = 300;

/**
 * A content-anchored, bag-persisted preference map — the machinery every
 * per-block presentation preference shares (widths, the word-wrap
 * override): lazy hydration with strict value validation (unknown shapes
 * dropped, never guessed), write-through persistence, subscriber
 * notification, and rename-on-edit so a stored choice follows its block.
 * The bag is restored (init message) before the editor mounts, so first
 * NodeView access sees persisted values.
 */
function bagMap<T>(stateKey: string, validate: (value: unknown) => value is T) {
    let cache: Map<string, T> | null = null;
    type Listener = (anchor: string, value: T | null) => void;
    const listeners = new Set<Listener>();

    const load = (): Map<string, T> => {
        if (cache) {
            return cache;
        }
        cache = new Map();
        const raw = getWebviewState()?.[stateKey];
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
                if (validate(value)) {
                    cache.set(key, value);
                    if (cache.size >= MAX_ENTRIES) {
                        break;
                    }
                }
            }
        }
        return cache;
    };

    const persist = (map: Map<string, T>): void => {
        setWebviewState({ ...(getWebviewState() ?? {}), [stateKey]: Object.fromEntries(map) });
    };

    return {
        get(anchor: string): T | null {
            return load().get(anchor) ?? null;
        },
        /** Set (or clear, with null). Notifies subscribers so chrome that
         * didn't originate the change (the table view under the block menu)
         * can re-render. Not a document edit: deliberately outside undo
         * history. */
        set(anchor: string, value: T | null): void {
            const map = load();
            if (value === null) {
                if (!map.delete(anchor)) {
                    return;
                }
            } else {
                if (map.get(anchor) === value) {
                    return;
                }
                if (!map.has(anchor) && map.size >= MAX_ENTRIES) {
                    const oldest = map.keys().next().value;
                    if (oldest !== undefined) {
                        map.delete(oldest);
                    }
                }
                map.set(anchor, value);
            }
            persist(map);
            for (const listener of [...listeners]) {
                listener(anchor, value);
            }
        },
        /** Carry a stored value across a content edit that changes the
         * block's anchor (src edit, first-line edit) — from NodeView
         * update().
         *
         * Two guards. It REFUSES an occupied destination, because another block
         * already answers to that key and overwriting hands one block's width to
         * a different one. And it NOTIFIES both keys, because a rename changes
         * what `get(oldAnchor)` returns and chrome anchored there has no other
         * way to hear it — without this a peer paints a width the store does not
         * back, and disagrees with itself on reload. */
        rename(oldAnchor: string, newAnchor: string): void {
            if (oldAnchor === newAnchor) {
                return;
            }
            const map = load();
            const value = map.get(oldAnchor);
            if (value === undefined || map.has(newAnchor)) {
                return;
            }
            map.delete(oldAnchor);
            map.set(newAnchor, value);
            persist(map);
            for (const listener of [...listeners]) {
                listener(oldAnchor, null);
                listener(newAnchor, value);
            }
        },
        entries(): [string, T][] {
            return [...load().entries()];
        },
        subscribe(listener: Listener): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

const widths = bagMap<BlockWidthMode>(
    "blockWidths",
    (value): value is BlockWidthMode => value === "full" || value === "fixed",
);

export function getBlockWidth(anchor: string): BlockWidthMode | null {
    return widths.get(anchor);
}

export function setBlockWidth(anchor: string, mode: BlockWidthMode | null): void {
    widths.set(anchor, mode);
}

export function renameBlockWidthAnchor(oldAnchor: string, newAnchor: string): void {
    widths.rename(oldAnchor, newAnchor);
}

export function onBlockWidthChange(
    listener: (anchor: string, mode: BlockWidthMode | null) => void,
): () => void {
    return widths.subscribe(listener);
}

/**
 * Per-block word-wrap override for code blocks (`codeWrap` bag key) — the
 * same "deliberate per-block choice" class as width: absent means follow
 * the birta.codeBlockWordWrap setting; a stored boolean overrides it, keyed
 * by the block's codeWidthAnchor and renamed alongside it on first-line
 * edits.
 */
const wraps = bagMap<boolean>("codeWrap", (value): value is boolean => typeof value === "boolean");

export function getBlockWrap(anchor: string): boolean | null {
    return wraps.get(anchor);
}

export function setBlockWrap(anchor: string, wrap: boolean | null): void {
    wraps.set(anchor, wrap);
}

export function renameBlockWrapAnchor(oldAnchor: string, newAnchor: string): void {
    wraps.rename(oldAnchor, newAnchor);
}

/**
 * Ordered-list NUMBERING style (`listNumbering` bag key) — the third member of
 * the same preference class: a deliberate per-block choice about how a block is
 * drawn, never a byte in the file. `decimal` is the default and is stored as
 * absence, so an untouched list keeps the by-depth cascade (style.css).
 *
 * Unlike width and wrap, the LIVE truth is a node attr on the ordered_list
 * (plugins/listNumbering.ts), because a list can be created empty and a
 * content anchor for an empty list names nothing. This bag is the reload
 * mirror, reconciled FROM the document rather than migrated, so no rename
 * path is needed here.
 */
const numberings = bagMap<OrderedNumbering>("listNumbering", isOrderedNumbering);

export function getListNumbering(anchor: string): OrderedNumbering | null {
    return numberings.get(anchor);
}

export function setListNumbering(anchor: string, style: OrderedNumbering | null): void {
    numberings.set(anchor, style === "decimal" ? null : style);
}

/** Every stored (anchor, style) pair — the reconcile pass diffs against this
 * rather than walking the bag through the store's single-key API. */
export function listNumberingEntries(): [string, OrderedNumbering][] {
    return numberings.entries();
}

// ─── Block identity ─────────────────────────────────────────────────────────

/**
 * A content anchor names CONTENT, which is not an identity: two blocks can hold
 * the same content. A preference set on one block belongs to that block, so a
 * stored key is CONTENT plus OCCURRENCE — `base` for the first block with that
 * content in document order, `base#2`, `base#3`, … for the rest. Content still
 * carries the persistence (positions rot across external edits, the fold-anchor
 * lesson); the ordinal only separates ties (MAR-334).
 *
 * Ties are ordinary, not exotic: two tables under the same header row
 * ("Name | Value"), two code blocks opening on the same line, one image used
 * twice, one URL embedded twice. Duplicate makes one in a click.
 *
 * WHAT AN ORDINAL CANNOT DO, and this is the trap: it is document ORDER, so
 * reordering two identical blocks swaps their widths, and retitling one so it
 * leaves or joins a tie group renumbers the rest. Both revert a block to its
 * default width, which is the graceful degradation this module already promises
 * for an anchor that stops matching, and neither touches the file. Per-node
 * identity would fix it and markdown has nowhere to store one. Duplicate
 * carries every affected block's preference across explicitly instead
 * (inheritDuplicatedAnchors).
 */

/**
 * Derives a block's anchor base, or null for a node this kind doesn't own.
 * Must be a module-level function: the per-document index memoizes on its
 * identity, so a fresh closure per call would index the document per call.
 */
export type AnchorBaseOf = (node: PmNode) => string | null;

/** Registered by node type name so the index walk is one map lookup per node
 * rather than a call into every kind. */
const anchorKinds = new Map<string, AnchorBaseOf[]>();

/** Declare a width-carrying block kind, from the module that owns it.
 * Returns `baseOf` so a call site can register and name it in one statement. */
export function registerAnchorKind(typeName: string, baseOf: AnchorBaseOf): AnchorBaseOf {
    const existing = anchorKinds.get(typeName);
    if (existing) {
        if (!existing.includes(baseOf)) {
            existing.push(baseOf);
        }
    } else {
        anchorKinds.set(typeName, [baseOf]);
    }
    return baseOf;
}

/** base -> the positions holding it, in document order. */
type AnchorIndex = Map<AnchorBaseOf, Map<string, number[]>>;

/**
 * One walk per document VERSION, shared by every kind and every block — the
 * launch-perf constraint. A NodeView asks at mount and again only when its
 * own base changed, so a keystroke that leaves every base alone costs
 * nothing. Keyed on the doc node, so a new document version simply misses
 * and nothing has to be invalidated by hand.
 */
const indexCache = new WeakMap<PmNode, AnchorIndex>();

function anchorIndex(doc: PmNode): AnchorIndex {
    const cached = indexCache.get(doc);
    if (cached) {
        return cached;
    }
    const index: AnchorIndex = new Map();
    doc.descendants((node: PmNode, pos: number) => {
        const derivers = anchorKinds.get(node.type.name);
        if (derivers) {
            for (const baseOf of derivers) {
                const base = baseOf(node);
                if (base === null) {
                    continue;
                }
                let byBase = index.get(baseOf);
                if (!byBase) {
                    byBase = new Map();
                    index.set(baseOf, byBase);
                }
                const positions = byBase.get(base);
                if (positions) {
                    positions.push(pos);
                } else {
                    byBase.set(base, [pos]);
                }
            }
        }
        return true;
    });
    indexCache.set(doc, index);
    return index;
}

/** `base`, `base#2`, `base#3`, … — `#` cannot appear in an ordinal, so a base
 * that itself ends in `#2` still can't be confused for one. */
export function occurrenceAnchor(base: string, ordinal: number): string {
    return ordinal <= 0 ? base : `${base}#${ordinal + 1}`;
}

/**
 * The stored-preference key for the block at `pos`, or null when the node
 * there isn't of `baseOf`'s kind. An unrecognized position degrades to the
 * bare base rather than throwing: a NodeView asking mid-teardown gets the
 * key it would have had as the sole occurrence.
 */
export function anchorAt(doc: PmNode, pos: number | undefined, baseOf: AnchorBaseOf): string | null {
    if (pos === undefined || pos < 0 || pos > doc.content.size) {
        return null;
    }
    const node = doc.nodeAt(pos);
    // The node must be one this kind was REGISTERED for, not merely one the
    // deriver can produce a string from: a table deriver handed a paragraph
    // reads its first child's text and returns a plausible `table:…` key for a
    // block that is not a table. Checking the registration is what makes the
    // null contract above true.
    if (!node || !anchorKinds.get(node.type.name)?.includes(baseOf)) {
        return null;
    }
    const base = baseOf(node);
    if (base === null) {
        return null;
    }
    const ordinal = anchorIndex(doc).get(baseOf)?.get(base)?.indexOf(pos) ?? 0;
    return occurrenceAnchor(base, Math.max(ordinal, 0));
}

/**
 * Carry presentation preferences across a Duplicate, so the copy reads the way
 * the block it copied does and every OTHER block keeps what it had.
 *
 * Both halves are needed because an insertion renumbers ordinals: with one
 * `Fruit` table full-width, duplicating it downward makes the copy `Fruit#2`
 * (stored nothing, so it would paint narrow next to its original), and
 * duplicating UPWARD makes the COPY `Fruit` and pushes the original to
 * `Fruit#2` — the original would go narrow and the copy would inherit. So
 * this maps every occurrence in the new document back to the block it came
 * from and rewrites the bag to match.
 *
 * The mapping is exact rather than a diff, because a duplicate's geometry is
 * known: `size` bytes of a verbatim copy of `[sourceFrom, …]` landed at
 * `insertAt`. Values are read from `before` and applied in one pass at the
 * end, so an entry can't be clobbered by an earlier write in the same sweep.
 */
export function inheritDuplicatedAnchors(opts: {
    before: PmNode;
    after: PmNode;
    sourceFrom: number;
    insertAt: number;
    size: number;
}): void {
    const { before, after, sourceFrom, insertAt, size } = opts;
    if (size <= 0 || anchorKinds.size === 0) {
        return;
    }
    /** The position in `before` that the block now at `pos` came from. */
    const originOf = (pos: number): number =>
        pos < insertAt ? pos
        : pos < insertAt + size ? sourceFrom + (pos - insertAt)
        : pos - size;

    const widthWrites: [string, BlockWidthMode | null][] = [];
    const wrapWrites: [string, boolean | null][] = [];
    for (const [baseOf, byBase] of anchorIndex(after)) {
        for (const positions of byBase.values()) {
            // A base held by exactly one block cannot have been renumbered,
            // and its key is unchanged — nothing to carry.
            if (positions.length < 2) {
                continue;
            }
            for (const pos of positions) {
                const from = anchorAt(before, originOf(pos), baseOf);
                const to = anchorAt(after, pos, baseOf);
                if (to === null || to === from) {
                    continue;
                }
                widthWrites.push([to, from === null ? null : getBlockWidth(from)]);
                wrapWrites.push([to, from === null ? null : getBlockWrap(from)]);
            }
        }
    }
    for (const [anchor, mode] of widthWrites) {
        setBlockWidth(anchor, mode);
    }
    for (const [anchor, wrap] of wrapWrites) {
        setBlockWrap(anchor, wrap);
    }
}

// ─── Anchors ────────────────────────────────────────────────────────────────

export function embedWidthAnchor(url: string): string {
    return `embed:${url}`;
}

/** `path` should be the display (relative) path, not the webview URI — the
 * URI's resource authority is session-scoped and would rot across reopens. */
export function imageWidthAnchor(path: string): string {
    return `img:${path}`;
}

export function codeWidthAnchor(text: string): string {
    const nl = text.indexOf("\n");
    return `code:${(nl === -1 ? text : text.slice(0, nl)).slice(0, 120)}`;
}

export function tableWidthAnchor(headerText: string): string {
    return `table:${headerText.slice(0, 120)}`;
}

/**
 * The two kinds whose base needs nothing but the node register here; images
 * and embeds register from their own modules, because their bases need a
 * display-path rewrite and a sole-bare-link read that live there. Every kind
 * must reach `registerAnchorKind` before the first `anchorAt` call, which
 * holds because all four owners are on the eager launch graph.
 */
export const tableAnchorBase = registerAnchorKind(
    "table",
    (node) => tableWidthAnchor(node.firstChild?.textContent ?? ""),
);

export const codeAnchorBase = registerAnchorKind(
    "code_block",
    (node) => codeWidthAnchor(node.textContent),
);

/** A list anchors on its FIRST ITEM's text — the list's own "first line", the
 * same choice codeWidthAnchor makes, and the part a reader would name it by. */
export function listNumberingAnchor(firstItemText: string): string {
    return `list:${firstItemText.slice(0, 120)}`;
}

export const listAnchorBase = registerAnchorKind(
    "ordered_list",
    (node) => listNumberingAnchor(node.firstChild?.textContent ?? ""),
);

// ─── DOM application ────────────────────────────────────────────────────────

/** One writer for the width classes so element state can't drift from the
 * store's vocabulary. Safe on NodeView doms and widget internals (class
 * changes there are invisible to ProseMirror's mutation observer). */
export function applyBlockWidthClass(el: HTMLElement, mode: BlockWidthMode | null): void {
    el.classList.toggle("bw-full", mode === "full");
    el.classList.toggle("bw-fixed", mode === "fixed");
}

// ─── Pane metric for the breakout CSS ───────────────────────────────────────

/**
 * Publish the pane's true content width as `--bw-pane`. The breakout math
 * needs the scrollbar-free width; 100vw (the CSS fallback) includes the
 * webview's layout scrollbar, and a formula off by that much overhangs the
 * pane and grows a horizontal scrollbar. One listener, rAF-throttled — the
 * value only changes on a real pane resize.
 */
export function initPaneWidthVar(): void {
    const apply = (): void => {
        document.documentElement.style.setProperty(
            "--bw-pane",
            `${document.documentElement.clientWidth}px`,
        );
    };
    apply();
    let raf = 0;
    window.addEventListener("resize", () => {
        if (raf) {
            return;
        }
        raf = requestAnimationFrame(() => {
            raf = 0;
            apply();
        });
    });
}
