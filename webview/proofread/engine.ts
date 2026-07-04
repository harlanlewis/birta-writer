/**
 * Spell-check engine facade: lazy dictionary loading, the user's personal
 * dictionary (persisted), and session-scoped ignores.
 *
 * The dictionary chunk (~550 KB) is imported on first demand so documents
 * with spell check disabled never pay for it.
 */
import type { NSpell } from "nspell";
import { notifySpellAddWord } from "../messaging";

let spell: NSpell | null = null;
let loadPromise: Promise<void> | null = null;
const readyCallbacks: Array<() => void> = [];
/** Words in the user's dictionary (from settings, plus "Add to dictionary"). */
const userWords = new Set<string>();
/** Words ignored for this editor session only. */
const sessionIgnores = new Set<string>();

/** Kick off dictionary loading (idempotent); callbacks fire once it's ready. */
export function ensureSpellLoaded(): void {
    if (loadPromise) { return; }
    loadPromise = import("./spellEngine").then((m) => {
        spell = m.default;
        for (const cb of readyCallbacks) { cb(); }
    }).catch((err) => {
        console.error("[proofread] failed to load spell dictionary", err);
    });
}

export function onSpellReady(cb: () => void): void {
    if (spell) { cb(); return; }
    readyCallbacks.push(cb);
}

export function isSpellReady(): boolean {
    return spell !== null;
}

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

/** Ignore a word for this session only (not persisted). */
export function ignoreWordSession(word: string): void {
    sessionIgnores.add(word.toLowerCase());
}

/** True when the word is acceptable (known, learned, ignored, or dictionary not ready). */
export function isWordCorrect(word: string): boolean {
    if (!spell) { return true; }
    const lower = word.toLowerCase();
    if (userWords.has(lower) || sessionIgnores.has(lower)) { return true; }
    return spell.correct(word);
}

/** Suggestions for a misspelled word (empty until the dictionary is ready). */
export function suggestions(word: string, limit = 5): string[] {
    if (!spell) { return []; }
    return spell.suggest(word).slice(0, limit);
}
