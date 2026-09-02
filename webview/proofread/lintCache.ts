/**
 * Spelling and grammar results, remembered by the text they were computed for.
 *
 * The proofread rescan walks the blocks near the viewport on a debounce after
 * every edit, and without this it would hand every one of them to the host's
 * checker. One keystroke changes one block, so the rest would be re-checked
 * for an answer nobody has any reason to expect to have changed. What that
 * costs is not theoretical and not always the page's own time: in Birta Writer
 * for Mac the checker is `NSSpellChecker`, which is AppKit and runs on the main
 * thread, the same thread key events arrive on, so a recheck is paid in caret
 * latency. `birta-trace lint` prints `blocks`, `chars` and `ms` for every round
 * trip and is how to read the cost back rather than trusting a number here.
 *
 * It is also what the drawn set is BUILT from (MAR-426): every lint decoration
 * is a lookup by the block's current text, so a reply is remembered here and
 * then drawn for whatever window the reader is on, never from the positions
 * the request was keyed to. That is why an answer can never be stale in
 * position, and why the review sidebar, which lists the whole document, can
 * be answered from here for the blocks a host has ever been asked about.
 *
 * The cache key is the block's plain text and nothing else. Block POSITION
 * deliberately is not part of the key, so moving a paragraph, or editing the one
 * above it, keeps its answer.
 *
 * That is safe as long as the host's answer depends on nothing but the text, and
 * there is exactly one thing it also depends on: the user's dictionary, which
 * both hosts read fresh on every request. `setUserWords` in `engine.ts` clears
 * this for that reason, and its comment carries the argument for why one
 * direction of that change cannot be repaired downstream.
 *
 * Learning a word or ignoring a finding does NOT invalidate anything here, and
 * that is correct rather than an oversight: both are applied downstream at
 * decoration-build time by `isLintSuppressed`, over whatever this returns.
 *
 * Host-agnostic on purpose. The extension's Harper pass has the same shape and
 * the same waste, so this belongs beside the plugin rather than in either host.
 */
import type { HarperLint } from "../../shared/messages";

/**
 * How many block texts to remember.
 *
 * Sized against the document, not the session: what has to fit is every block
 * of the file being edited, or the very next rescan re-asks for the ones that
 * fell out and the cache buys nothing on exactly the documents it exists for.
 * A FIFO smaller than the document is worse than no cache, because it evicts
 * every entry before the next pass reads it, so the bound sits above the
 * block count of the largest document the heavy perf fixtures stand in for
 * (`huge-outline`), the same bound the style cache carries. The entries are
 * short strings plus a usually-empty array. Exported so the eviction test
 * reads the bound rather than restating it.
 */
export const LINT_CACHE_MAX = 16384;

/**
 * Bumped by every write, so a memo built from this cache can tell whether an
 * answer has arrived since it was built. The review sidebar's document-wide
 * lint set is the reader: the drawn set is windowed, and the list rebuilds
 * only when the document, the config or this has moved.
 */
let generation = 0;

/**
 * Insertion-ordered, which is what makes the eviction below cheap: a `Map`
 * yields its keys oldest-first, so the oldest is `keys().next()`. Re-reading an
 * entry does NOT refresh its position, so this is FIFO rather than LRU. That is
 * deliberate: promoting on read would touch the map on every block of every
 * rescan, and the access pattern here is a whole document swept at once rather
 * than a hot subset, so recency carries almost no information.
 */
const cache = new Map<string, HarperLint[]>();

/** The remembered findings for this exact text, or undefined if unseen. */
export function lookupLints(text: string): HarperLint[] | undefined {
    return cache.get(text);
}

/** Remember what the host answered for this exact text. */
export function rememberLints(text: string, lints: HarperLint[]): void {
    if (cache.has(text)) { cache.delete(text); }
    cache.set(text, lints);
    generation++;
    while (cache.size > LINT_CACHE_MAX) {
        const oldest = cache.keys().next();
        if (oldest.done) { break; }
        cache.delete(oldest.value);
    }
}

/** A number that moves whenever the remembered answers do. */
export function lintCacheGeneration(): number {
    return generation;
}

/**
 * Forget everything.
 *
 * For a change in what the CHECKER would answer, which no edit to the document
 * can cause. `setUserWords` is the production caller and the case that matters;
 * a host swapping engines or a language changing underneath it would be the
 * same shape. Tests also use it, because a module-level cache is otherwise
 * shared between them.
 */
export function clearLintCache(): void {
    cache.clear();
    generation++;
}

/** How many texts are remembered. For tests and for the eviction bound. */
export function lintCacheSize(): number {
    return cache.size;
}
