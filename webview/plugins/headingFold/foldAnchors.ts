/**
 * webview/plugins/headingFold/foldAnchors.ts
 *
 * Fold persistence: the T2 structural-anchor encoding that lets fold state
 * survive the tab-hide webview teardown (via the webview state bag), and
 * the T1 syntax-default seeding (`[!kind]-` callouts start collapsed).
 * Reads the model only; the plugin decides when to persist and restore.
 */
import type { EditorState } from "@milkdown/prose/state";
import { slugify } from "../../utils/slug";
import { getWebviewState, setWebviewState } from "../../messaging";
import { foldPluginKey } from "../foldState";
import {
    cachedFoldRanges,
    foldHiddenRange,
    isCalloutNode,
    isCodeBlockNode,
    isFoldableCallout,
    isHeadingNode,
    isListItemNode,
    isTableNode,
} from "./foldModel";

// ─── T2 persistence (webview state bag, structural anchors) ─────────────────

/**
 * Fold state persisted as structural anchors, not positions — absolute
 * positions rot across external edits/reverts. Headings anchor as
 * `slug:occurrenceIndex` (the link-anchor identity scheme, shared/slug.ts);
 * callouts as a root-relative child-index path (`"2"`, `"1/0"`). On restore,
 * anchors that no longer resolve are dropped silently (never guess).
 */
export interface FoldAnchors {
    headings: string[];
    /** Root-relative child-index paths (`"2"`, `"1/0"`) for callouts. */
    callouts: string[];
    /** Same path encoding for the other node-anchored foldables (list
     * items, tables, code blocks — MAR-125). A separate array (not merged
     * into `callouts`) so older persisted bags round-trip untouched. */
    blocks: string[];
}

const FOLD_ANCHORS_STATE_KEY = "foldAnchors";

export function computeFoldAnchors(doc: any, folded: ReadonlySet<number>): FoldAnchors {
    const headings: string[] = [];
    const callouts: string[] = [];
    const blocks: string[] = [];
    if (folded.size === 0) {
        return { headings, callouts, blocks };
    }
    const counts = new Map<string, number>();
    doc.forEach((node: any, offset: number) => {
        if (!isHeadingNode(node)) {
            return;
        }
        const slug = slugify((node as { textContent?: string }).textContent ?? "");
        const occurrence = counts.get(slug) ?? 0;
        counts.set(slug, occurrence + 1);
        if (folded.has(offset)) {
            headings.push(`${slug}:${occurrence}`);
        }
    });
    for (const pos of folded) {
        const node = doc.nodeAt(pos);
        const isCallout = isCalloutNode(node);
        if (!isCallout && !isListItemNode(node) && !isTableNode(node) && !isCodeBlockNode(node)) {
            continue;
        }
        const $pos = doc.resolve(pos);
        const path: number[] = [];
        for (let depth = 0; depth <= $pos.depth; depth++) {
            path.push($pos.index(depth));
        }
        (isCallout ? callouts : blocks).push(path.join("/"));
    }
    return { headings, callouts, blocks };
}

/** Resolve a root-relative child-index path (`"1/0"`) back to a position
 * and node, or null when it no longer points anywhere. */
function resolveChildPath(doc: any, encoded: string): { pos: number; node: any } | null {
    const path = encoded.split("/").map(Number);
    if (path.length === 0 || path.some((i) => !Number.isInteger(i) || i < 0)) {
        return null;
    }
    let node: any = doc;
    let pos = 0;
    for (let depth = 0; depth < path.length; depth++) {
        const index = path[depth]!;
        if (index >= node.childCount) {
            return null;
        }
        let childPos = depth === 0 ? 0 : pos + 1;
        for (let sibling = 0; sibling < index; sibling++) {
            childPos += node.child(sibling).nodeSize;
        }
        pos = childPos;
        node = node.child(index);
    }
    return { pos, node };
}

export function resolveFoldAnchors(doc: any, anchors: FoldAnchors): Set<number> {
    const folded = new Set<number>();
    const wanted = new Set(anchors.headings);
    if (wanted.size > 0) {
        const ranges = cachedFoldRanges(doc);
        const counts = new Map<string, number>();
        doc.forEach((node: any, offset: number) => {
            if (!isHeadingNode(node)) {
                return;
            }
            const slug = slugify((node as { textContent?: string }).textContent ?? "");
            const occurrence = counts.get(slug) ?? 0;
            counts.set(slug, occurrence + 1);
            if (wanted.has(`${slug}:${occurrence}`) && ranges.get(offset)) {
                folded.add(offset);
            }
        });
    }
    // Same predicates as the live layers: an anchor persisted for a block
    // that is no longer foldable (or never was — e.g. a list-item-nested
    // one from an older build) is dropped, never restored into an
    // invisible fold. `?? []` tolerates pre-MAR-125 anchor bags with no
    // `blocks` array.
    for (const encoded of anchors.callouts ?? []) {
        const hit = resolveChildPath(doc, encoded);
        if (hit && isFoldableCallout(doc, hit.pos, hit.node)) {
            folded.add(hit.pos);
        }
    }
    for (const encoded of anchors.blocks ?? []) {
        const hit = resolveChildPath(doc, encoded);
        if (
            hit &&
            (isListItemNode(hit.node) || isTableNode(hit.node) || isCodeBlockNode(hit.node)) &&
            foldHiddenRange(doc, hit.pos) !== null
        ) {
            folded.add(hit.pos);
        }
    }
    return folded;
}

export function readPersistedFoldAnchors(): FoldAnchors | null {
    const raw = getWebviewState()?.[FOLD_ANCHORS_STATE_KEY];
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const partial = raw as Partial<FoldAnchors>;
    const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    return {
        headings: strings(partial.headings),
        callouts: strings(partial.callouts),
        blocks: strings(partial.blocks),
    };
}

export function persistFoldAnchors(state: EditorState): void {
    const pluginState = foldPluginKey.getState(state);
    if (!pluginState) {
        return;
    }
    setWebviewState({
        ...(getWebviewState() ?? {}),
        [FOLD_ANCHORS_STATE_KEY]: computeFoldAnchors(state.doc, pluginState.folded),
    });
}

/** T1 default state from syntax: `[!kind]-` callouts start collapsed. */
export function seedSyntaxFolds(doc: any): Set<number> {
    const folded = new Set<number>();
    doc.descendants((node: any, pos: number) => {
        if (node.attrs?.["fold"] === "-" && isFoldableCallout(doc, pos, node)) {
            folded.add(pos);
        }
        return true;
    });
    return folded;
}
