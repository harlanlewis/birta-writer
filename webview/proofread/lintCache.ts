/**
 * Spelling and grammar results, remembered by the text they were computed for.
 *
 * The proofread rescan walks the WHOLE document on a debounce after every edit
 * and hands every block to the host's checker. One keystroke changes one block,
 * so without this the other blocks are re-checked for an answer nobody has any
 * reason to expect to have changed. What that costs is not theoretical and not
 * the page's own time: on this surface the checker is `NSSpellChecker`, which is
 * AppKit and runs on the main thread, the same thread key events arrive on, so
 * a whole-document recheck is paid in caret latency. `jot-trace lint` prints
 * `blocks`, `chars` and `ms` for every round trip and is how to read the cost
 * back rather than trusting a number written here.
 *
 * The cache key is the block's plain text and nothing else, which is the whole
 * reason this is safe: the checker is a pure function of the text it is given.
 * Block POSITION deliberately is not part of the key, so moving a paragraph, or
 * editing the one above it, keeps its answer.
 *
 * It is not invalidated when the user learns a word or ignores a finding, and
 * that is correct rather than an oversight: both are applied downstream at
 * decoration-build time by `isLintSuppressed`, over whatever this returns. A
 * cache cleared on learn would be a cache cleared for nothing.
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
 * A large note is a few hundred blocks, so this holds several of them, and the
 * entries are short strings plus a usually-empty array.
 */
const MAX_ENTRIES = 4096;

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
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done) { break; }
        cache.delete(oldest.value);
    }
}

/**
 * Forget everything.
 *
 * For a change in what the CHECKER would answer, which no edit to the document
 * can cause: the host swapping engines, or a language change underneath it.
 * Exported chiefly so tests start from a known state, because a module-level
 * cache is otherwise shared between them.
 */
export function clearLintCache(): void {
    cache.clear();
}

/** How many texts are remembered. For tests and for the eviction bound. */
export function lintCacheSize(): number {
    return cache.size;
}
