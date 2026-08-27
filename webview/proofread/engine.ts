/**
 * Webview-side proofread state: the user's dictionary and session-scoped
 * ignores. Grammar/spell analysis itself runs in the extension host
 * (Harper — see src/utils/harperService.ts); these sets provide instant
 * local filtering so "Add to dictionary" / "Ignore" take effect before the
 * settings round trip completes.
 */
import { notifyStyleAddException, notifySpellAddWord } from "../messaging";
import { clearLintCache } from "./lintCache";

/** Words in the user's dictionary (from settings, plus "Add to dictionary"). */
const userWords = new Set<string>();
/** `kind:text` lint keys ignored for this editor session only. */
const sessionIgnores = new Set<string>();
/** `category:text` style-check keys ignored for this editor session only. */
const styleIgnores = new Set<string>();

/**
 * Replace the user-dictionary set (from configuration).
 *
 * A change here invalidates remembered findings, and in one direction it cannot
 * be repaired downstream. The HOST filters by this dictionary too, fresh on
 * every request, so a word added to it stops arriving as a finding at all.
 * Adding is harmless: the cached finding is still suppressed locally by
 * `isLintSuppressed`. REMOVING a word is not, because the cached answer for a
 * block already has no finding in it and nothing downstream can put one back;
 * the word would stay unflagged until that block's text changed or the tab
 * reloaded. Reachable by editing `birta.proofread.userWords` by hand, and on the
 * Mac by unlearning a word in the system dictionary.
 *
 * So the cache is dropped on any change, rather than only on a shrink: telling
 * the two apart buys nothing on a path that runs when settings change.
 */
export function setUserWords(words: readonly string[]): void {
    const next = new Set(words.map((w) => w.toLowerCase()));
    const changed = next.size !== userWords.size || [...next].some((w) => !userWords.has(w));
    userWords.clear();
    for (const w of next) { userWords.add(w); }
    if (changed) { clearLintCache(); }
}

/** Add a word to the user's dictionary and persist it to settings. */
export function learnWord(word: string): void {
    userWords.add(word.toLowerCase());
    notifySpellAddWord(word);
}

/**
 * "Keep this phrase": the flagged text is the writer's own and no check may
 * flag it again. Suppressed for this session at once (the persisted list
 * arrives a config round-trip later and recompiles the matcher for good).
 * The spelling twin is `learnWord`; this is the style checks' protect-list.
 */
export function keepStylePhrase(category: string, phrase: string): void {
    styleIgnores.add(ignoreKey(category, phrase));
    notifyStyleAddException(phrase);
}

function ignoreKey(kind: string, text: string): string {
    return `${kind}:${text.toLowerCase()}`;
}

/** Ignore a specific finding (by kind + flagged text) for this session only. */
export function ignoreLintSession(kind: string, text: string): void {
    sessionIgnores.add(ignoreKey(kind, text));
}

/** True when a finding should be suppressed locally. */
export function isLintSuppressed(kind: string, text: string): boolean {
    if (sessionIgnores.has(ignoreKey(kind, text))) { return true; }
    return kind === "Spelling" && userWords.has(text.toLowerCase());
}

/**
 * Ignore a style-check finding (by category + flagged text) for this session
 * only. Mirrors `ignoreLintSession` so the popup offers the same "Ignore"
 * gesture on style hits as it does on Harper's grammar/spelling findings.
 */
export function ignoreStyleSession(category: string, text: string): void {
    styleIgnores.add(ignoreKey(category, text));
}

/** True when a style-check finding should be suppressed locally. */
export function isStyleSuppressed(category: string, text: string): boolean {
    return styleIgnores.has(ignoreKey(category, text));
}
