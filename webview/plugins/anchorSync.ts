/**
 * anchorSync.ts — auto-update in-note `#slug` anchor links when a heading is
 * renamed (MAR-180).
 *
 * A section link `[text](#slug)` targets a heading by its TEXT-derived slug
 * (`slugifyHeadings` over `collectDocHeadings`' model `textContent`). Renaming
 * the heading changes its slug and silently orphans every `[…](#old-slug)`
 * pointing at it. This plugin detects the rename and rewrites those links to
 * the new slug IN THE SAME undo step, so a heading rename never quietly breaks
 * its inbound anchors.
 *
 * ── Why an appendTransaction (not a view update or a listener) ──────────────
 * The rewrite must be part of the SAME transaction batch as the rename so that
 * (a) it is atomic with it and (b) prosemirror-history folds it into the
 * rename's history event — one Cmd+Z restores both the heading text and the
 * hrefs. `appendTransaction(transactions, oldState, newState)` is the only hook
 * that sees the before/after states together and can contribute a transaction
 * that history attributes to the triggering edit. We return a PLAIN transaction
 * (never `addToHistory: false`): marking it out of history would revert the
 * heading on undo but strand the hrefs — the exact orphaning this fixes.
 *
 * ── The perf guard is load-bearing ─────────────────────────────────────────
 * appendTransaction runs on EVERY transaction, including every keystroke. The
 * full slug diff (two `collectDocHeadings` walks + two `slugifyHeadings`) must
 * NOT run while typing body text. So the guard bails in two cheap tiers before
 * any of that:
 *   1. no transaction changed the doc  → return null (selection-only churn);
 *   2. no changed range intersects a `heading` node → return null.
 * Tier 2 walks only the mapped step ranges (O(steps), each a tiny range) and
 * asks `nodesBetween` whether a heading sits inside — it never walks the whole
 * document. Typing in a paragraph touches only that paragraph's range, so the
 * walk sees no heading and bails, mirroring the TOC's `inlineOnlyShift`
 * discipline (webview/components/toc/index.ts): observe the real change, don't
 * recompute the world. Only an edit that actually touches a heading pays for
 * the slug diff. When the feature is disabled the guard's first line returns
 * null with zero work.
 *
 * ── Round-trip ──────────────────────────────────────────────────────────────
 * The only thing that changes is `link` mark `href` attrs; `[text](#new-slug)`
 * is ordinary Markdown, so serialization is unaffected and the file round-trips
 * exactly as before (phase-0 fidelity).
 */
import type { EditorState, Node as ProseNode, Transaction } from "../pm";
import { Mapping, Plugin, PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import { collectDocHeadings } from "../utils/headingUtils";
import { computeSlugRenames } from "../utils/slug";
import { EXTERNAL_SYNC_META } from "./docChange";

/** Auto-update ships ON; the flag is baked into __i18n at panel load (like
 *  calc/embeds). When off, the appendTransaction bails before any scan. */
function autoUpdateEnabled(): boolean {
    return window.__i18n?.autoUpdateAnchors ?? true;
}

export const anchorSyncKey = new PluginKey("birta-anchor-sync");

/**
 * TIER-2 PERF GUARD (exported for direct unit testing): did any changed range
 * of these transactions intersect a `heading` node in the pre-edit document?
 *
 * Walks the mapped ranges of every step against the doc that step applied to
 * (`tr.docs[i]` is the document BEFORE step `i`, so the map's OLD coordinates
 * resolve in it). `nodesBetween` over a step's changed range descends only into
 * that range — a body-text edit resolves inside a paragraph and never reaches a
 * heading, so this is O(steps · changed-range), never an O(document) walk.
 *
 * Deliberately conservative: a false POSITIVE (an edit next to a heading that
 * flags true) only costs one wasted slug diff that then finds no rename and
 * returns null. A false NEGATIVE would miss a real rename, so the test errs
 * toward "touched" — a heading deletion, whose whole node sits in the deleted
 * range, is correctly caught here even though it produces no rename (its links
 * are meant to be left dangling).
 */
export function headingRangeTouched(
    transactions: readonly Transaction[],
    _oldDoc: ProseNode,
): boolean {
    for (const tr of transactions) {
        if (!tr.docChanged) {
            continue;
        }
        const { steps, docs } = tr;
        for (let i = 0; i < steps.length; i++) {
            const docBefore = docs[i];
            if (!docBefore) {
                continue;
            }
            const size = docBefore.content.size;
            let touched = false;
            steps[i].getMap().forEach((fromA, toA) => {
                if (touched) {
                    return;
                }
                const from = Math.max(0, Math.min(fromA, size));
                const to = Math.max(from, Math.min(toA, size));
                docBefore.nodesBetween(from, to, (node) => {
                    if (touched) {
                        return false;
                    }
                    if (node.type.name === "heading") {
                        touched = true;
                        return false;
                    }
                    return true; // keep descending containers toward any heading
                });
            });
            if (touched) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Pair each OLD heading with the NEW heading it BECAME, by mapping the old
 * heading's document position forward through the accumulated transaction
 * mapping. Returns `oldToNew[i]` = index of the paired new heading, or -1.
 *
 * Why position-mapping and not text-matching: a text edit inside a heading
 * shifts every later position but the mapping tracks that exactly, so the old
 * heading lands precisely on its renamed self even as slugs change around it.
 *
 * Two conditions must both hold for a pair, and together they reject a MOVED
 * heading (which must NOT trigger a rewrite):
 *   - forward: `map(oldPos)` lands exactly on a new heading's start, and
 *   - inverse round-trip: mapping that new heading's start BACK returns the old
 *     position. A moved heading is a delete+insert: its old position maps to
 *     the collapse point (some OTHER heading, or nothing), and that heading's
 *     start inverse-maps to ITS own old position, not this one — so the round
 *     trip fails and the pair is dropped. An in-place rename round-trips
 *     cleanly. Levels must also match, a cheap extra guard against a coincidental
 *     positional collision.
 */
function pairOldToNew(
    transactions: readonly Transaction[],
    oldHeadings: readonly { pos: number; level: number }[],
    newHeadings: readonly { pos: number; level: number }[],
): number[] {
    const mapping = new Mapping();
    for (const tr of transactions) {
        mapping.appendMapping(tr.mapping);
    }
    const inverse = mapping.invert();
    const newByPos = new Map<number, number>();
    newHeadings.forEach((h, j) => newByPos.set(h.pos, j));

    return oldHeadings.map((oh) => {
        const fwd = mapping.map(oh.pos);
        const j = newByPos.get(fwd);
        if (j === undefined) {
            return -1;
        }
        if (newHeadings[j].level !== oh.level) {
            return -1;
        }
        if (inverse.map(newHeadings[j].pos) !== oh.pos) {
            return -1; // not an in-place edit (moved / relocated) — don't pair
        }
        return j;
    });
}

/**
 * Rewrite every `link` mark whose href is `#<oldSlug>` to `#<newSlug>`, in one
 * transaction on `state`. Reads each link's CURRENT href and looks it up in the
 * rename map exactly once, so `foo → bar` never chains into a later `bar → …`
 * substitution. Positions from the walk stay valid because mark edits never
 * change document size (only `removeMark`/`addMark`), so no re-mapping is
 * needed as edits accumulate on the transaction.
 */
function rewriteLinks(
    state: EditorState,
    renames: Map<string, string>,
): Transaction | null {
    const linkType = state.schema.marks["link"];
    if (!linkType) {
        return null;
    }
    const tr = state.tr;
    let changed = false;
    state.doc.descendants((node, pos) => {
        if (!node.isText) {
            return; // marks live on text nodes; keep descending containers
        }
        const linkMark = node.marks.find((m) => m.type === linkType);
        if (!linkMark) {
            return;
        }
        const href = linkMark.attrs["href"];
        if (typeof href !== "string" || !href.startsWith("#")) {
            return;
        }
        const newSlug = renames.get(href.slice(1));
        if (newSlug === undefined) {
            return;
        }
        const from = pos;
        const to = pos + node.nodeSize;
        // Replace only this link mark on this text node, preserving its other
        // attrs (e.g. title). removeMark by type clears the stale href; addMark
        // reinstates it with the new one. Adjacent text nodes that shared the
        // old href each rewrite to the same new href, so they still serialize
        // as a single `[text](#new-slug)`.
        tr.removeMark(from, to, linkType);
        tr.addMark(from, to, linkType.create({ ...linkMark.attrs, href: `#${newSlug}` }));
        changed = true;
    });
    return changed ? tr : null;
}

export const anchorSyncPlugin = $prose(
    () =>
        new Plugin({
            key: anchorSyncKey,
            appendTransaction: (transactions, oldState, newState) => {
                // Feature gate first: a disabled feature costs nothing.
                if (!autoUpdateEnabled()) {
                    return null;
                }
                // NEVER react to inbound external sync (git checkout, a
                // side-by-side text editor, VS Code undo of a save). Those
                // transactions carry the on-disk truth; "auto-fixing" links
                // the file legitimately holds would silently diverge the
                // editor from the file and persist an uncommanded rewrite on
                // the next keystroke — a phase-0 fidelity violation. This
                // feature exists to keep up with renames the USER makes in
                // this editor, nothing else.
                if (transactions.some((tr) => tr.getMeta(EXTERNAL_SYNC_META))) {
                    return null;
                }
                // TIER 1: selection-only churn can't rename a heading.
                if (!transactions.some((tr) => tr.docChanged)) {
                    return null;
                }
                // TIER 2: no heading in any changed range ⇒ no rename possible.
                // This is the keystroke-cheap bail that keeps body typing free.
                if (!headingRangeTouched(transactions, oldState.doc)) {
                    return null;
                }

                // A heading WAS touched — now (and only now) pay for the diff.
                const oldHeadings = collectDocHeadings(oldState.doc);
                const newHeadings = collectDocHeadings(newState.doc);
                if (oldHeadings.length === 0) {
                    return null; // nothing could have been renamed FROM
                }

                const oldToNew = pairOldToNew(transactions, oldHeadings, newHeadings);
                const renames = computeSlugRenames(
                    oldHeadings.map((h) => h.text),
                    newHeadings.map((h) => h.text),
                    oldToNew,
                );
                if (renames.size === 0) {
                    return null; // heading edit that changed no slug (e.g. a move)
                }
                return rewriteLinks(newState, renames);
            },
        }),
);
