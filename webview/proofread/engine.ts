/**
 * Spell-check engine facade: lazy dictionary loading + ignored-word handling.
 *
 * The dictionary chunk (~550 KB) is imported on first demand so documents
 * with spell check disabled never pay for it.
 */
import type { NSpell } from "nspell";
import { notifySpellIgnoreWord } from "../messaging";

let spell: NSpell | null = null;
let loadPromise: Promise<void> | null = null;
const readyCallbacks: Array<() => void> = [];
const ignored = new Set<string>();

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

/** Replace the ignored-word set (from configuration). */
export function setIgnoredWords(words: readonly string[]): void {
    ignored.clear();
    for (const w of words) { ignored.add(w.toLowerCase()); }
}

/** Ignore a word locally and persist it to the user's settings. */
export function ignoreWord(word: string): void {
    ignored.add(word.toLowerCase());
    notifySpellIgnoreWord(word);
}

/** True when the word is acceptable (known, ignored, or dictionary not ready). */
export function isWordCorrect(word: string): boolean {
    if (!spell) { return true; }
    if (ignored.has(word.toLowerCase())) { return true; }
    return spell.correct(word);
}

/** Suggestions for a misspelled word (empty until the dictionary is ready). */
export function suggestions(word: string, limit = 5): string[] {
    if (!spell) { return []; }
    return spell.suggest(word).slice(0, limit);
}
