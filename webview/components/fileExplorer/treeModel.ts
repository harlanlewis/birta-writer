/**
 * components/fileExplorer/treeModel.ts
 *
 * The file explorer's tree, with no DOM in it: which folders are open, which
 * listings are held, and the flat row list the panel draws from that. The
 * panel (./index.ts) asks the host for listings and paints rows; this decides
 * what to ask for and what the rows are, so both halves can be tested on
 * their own.
 *
 * Paths are root-relative and POSIX-separated, `""` being the root, exactly
 * as they cross the wire (shared/messages.ts). The root is always expanded.
 *
 * Two costs are held flat by construction. A listing is requested for a
 * folder exactly when it is expanded and holds no listing, so the number of
 * listings in flight never exceeds the number of open folders. And the
 * dotfile switch is a flag on the rows rather than a filter over the tree:
 * hidden entries are in the row list with `concealed` set, so flipping the
 * switch is a re-render and never a re-list.
 */
import type { ProjectEntry } from "../../../shared/messages";

export type ListingState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; entries: readonly ProjectEntry[] };

/** One drawable row. `loading` and `error` rows stand in for a folder's children. */
export interface TreeRow {
    /** The entry's own path; for a stand-in row, the folder it stands in for. */
    path: string;
    name: string;
    kind: "dir" | "file" | "loading" | "error";
    /** Nesting depth, 1 at the root's children (`aria-level`). */
    level: number;
    /** Folders only: whether its children follow it in the list. */
    expanded: boolean;
    /** Files only: false for one the host hands to another application. */
    openable: boolean;
    /** A hidden entry, or one under a hidden folder. */
    hidden: boolean;
    /** Hidden AND the switch is off: the row exists and is not drawn. */
    concealed: boolean;
    /** The error row's text. */
    message?: string;
}

export interface TreeModel {
    /** Sorted, folders first, names in natural order. */
    sortEntries(entries: readonly ProjectEntry[]): ProjectEntry[];
    /** The rows to draw, top to bottom, over the root and every expanded folder. */
    visibleRows(showHidden: boolean): TreeRow[];
    isExpanded(path: string): boolean;
    /** Every folder open below the root, shallowest first, as the host is told them. */
    expandedPaths(): string[];
    /** Open a folder. Returns the paths that now need a listing (itself, when it has none). */
    expand(path: string): string[];
    collapse(path: string): void;
    /** Open a closed folder or close an open one; the paths that need a listing, if any. */
    toggle(path: string): string[];
    /**
     * Make a file reachable: open every ancestor. Returns the ancestors that
     * need a listing, root included when it has none, in root-first order.
     */
    revealPath(file: string): string[];
    /** Drop a folder's listing; it is asked for again when next needed. */
    invalidate(path: string): void;
    /** Whether a folder needs a listing to draw its children: expanded (or the root) with none held. */
    needsListing(path: string): boolean;
    setLoading(path: string): void;
    setError(path: string, message: string): void;
    applyListing(path: string, entries: readonly ProjectEntry[]): void;
    listing(path: string): ListingState | undefined;
    /** Every path a listing is held or pending for. */
    listedPaths(): string[];
    /** The folder a path sits in, `""` for a root child, null for the root itself. */
    parentPath(path: string): string | null;
    /** Forget everything: a new root, or none. */
    reset(): void;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function parentPath(path: string): string | null {
    if (path === "") { return null; }
    const cut = path.lastIndexOf("/");
    return cut === -1 ? "" : path.slice(0, cut);
}

export function joinPath(dir: string, name: string): string {
    return dir === "" ? name : `${dir}/${name}`;
}

/** Every proper ancestor of `path`, root first: `a/b/c` gives `""`, `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
    const out: string[] = [];
    let cur = parentPath(path);
    while (cur !== null) {
        out.unshift(cur);
        cur = parentPath(cur);
    }
    return out;
}

export function createTreeModel(): TreeModel {
    const expanded = new Set<string>();
    const listings = new Map<string, ListingState>();

    function sortEntries(entries: readonly ProjectEntry[]): ProjectEntry[] {
        return [...entries].sort((a, b) => {
            if (a.kind !== b.kind) { return a.kind === "dir" ? -1 : 1; }
            return collator.compare(a.name, b.name);
        });
    }

    function isExpanded(path: string): boolean {
        return path === "" || expanded.has(path);
    }

    function needsListing(path: string): boolean {
        return isExpanded(path) && !listings.has(path);
    }

    function expand(path: string): string[] {
        if (path !== "") { expanded.add(path); }
        return needsListing(path) ? [path] : [];
    }

    function collapse(path: string): void {
        if (path !== "") { expanded.delete(path); }
    }

    function visibleRows(showHidden: boolean): TreeRow[] {
        const rows: TreeRow[] = [];
        const walk = (dir: string, level: number, parentHidden: boolean): void => {
            const state = listings.get(dir);
            if (!state || state.kind === "loading") {
                rows.push({
                    path: dir, name: "", kind: "loading", level, expanded: false,
                    openable: false, hidden: parentHidden, concealed: parentHidden && !showHidden,
                });
                return;
            }
            if (state.kind === "error") {
                rows.push({
                    path: dir, name: "", kind: "error", level, expanded: false,
                    openable: false, hidden: parentHidden, concealed: parentHidden && !showHidden,
                    message: state.message,
                });
                return;
            }
            for (const entry of state.entries) {
                const path = joinPath(dir, entry.name);
                const hidden = parentHidden || entry.hidden;
                const open = entry.kind === "dir" && isExpanded(path);
                rows.push({
                    path, name: entry.name, kind: entry.kind, level, expanded: open,
                    openable: entry.kind === "dir" ? true : entry.openable,
                    hidden, concealed: hidden && !showHidden,
                });
                if (open) { walk(path, level + 1, hidden); }
            }
        };
        walk("", 1, false);
        return rows;
    }

    return {
        sortEntries,
        visibleRows,
        isExpanded,
        expandedPaths: () => [...expanded].sort((a, b) => a.split("/").length - b.split("/").length || collator.compare(a, b)),
        expand,
        collapse,
        toggle(path) {
            if (isExpanded(path)) { collapse(path); return []; }
            return expand(path);
        },
        revealPath(file) {
            const needed: string[] = [];
            for (const dir of ancestorsOf(file)) {
                needed.push(...expand(dir));
            }
            return needed;
        },
        invalidate(path) { listings.delete(path); },
        needsListing,
        setLoading(path) { listings.set(path, { kind: "loading" }); },
        setError(path, message) { listings.set(path, { kind: "error", message }); },
        applyListing(path, entries) { listings.set(path, { kind: "ready", entries: sortEntries(entries) }); },
        listing(path) { return listings.get(path); },
        listedPaths() { return [...listings.keys()]; },
        parentPath,
        reset() { expanded.clear(); listings.clear(); },
    };
}
