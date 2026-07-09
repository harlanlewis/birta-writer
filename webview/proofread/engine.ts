/**
 * Webview-side proofread state: the user's dictionary and session-scoped
 * ignores. Grammar/spell analysis itself runs in the extension host
 * (Harper — see src/utils/harperService.ts); these sets provide instant
 * local filtering so "Add to dictionary" / "Ignore" take effect before the
 * settings round trip completes.
 */
import { notifySpellAddWord } from "../messaging";

/** Words in the user's dictionary (from settings, plus "Add to dictionary"). */
const userWords = new Set<string>();
/** `kind:text` lint keys ignored for this editor session only. */
const sessionIgnores = new Set<string>();
/** `category:text` style-check keys ignored for this editor session only. */
const styleIgnores = new Set<string>();

/** Replace the user-dictionary set (from configuration). */
export function setUserWords(words: readonly string[]): void {
    userWords.clear();
    for (const w of words) { userWords.add(w.toLowerCase()); }
}

/** Add a word to the user's dictionary and persist it to settings. */
export function learnWord(word: string): void {
    userWords.add(word.toLowerCase());
    notifySpellAddWord(word);
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
