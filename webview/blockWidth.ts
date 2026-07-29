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
 *     keys don't. Duplicated content shares one width (deliberate: the same
 *     video embedded twice reads best at the same size).
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
         * update(). */
        rename(oldAnchor: string, newAnchor: string): void {
            if (oldAnchor === newAnchor) {
                return;
            }
            const map = load();
            const value = map.get(oldAnchor);
            if (value === undefined) {
                return;
            }
            map.delete(oldAnchor);
            map.set(newAnchor, value);
            persist(map);
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
