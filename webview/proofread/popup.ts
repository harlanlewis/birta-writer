/**
 * Spell-check suggestion popup: click a flagged word to see corrections,
 * apply one, or ignore the word (persisted to settings).
 */
import type { EditorView } from "@milkdown/prose/view";
import { t } from "../i18n";
import { ignoreWordSession, learnWord, suggestions } from "./engine";
import "./proofread.css";

let activePopup: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function hideSpellPopup(): void {
    cleanup?.();
    cleanup = null;
    activePopup?.remove();
    activePopup = null;
}

export function showSpellPopup(view: EditorView, from: number, to: number): void {
    hideSpellPopup();

    const word = view.state.doc.textBetween(from, to);
    if (!word) { return; }

    const popup = document.createElement("div");
    popup.className = "pf-popup";

    const list = suggestions(word);
    if (list.length === 0) {
        const empty = document.createElement("div");
        empty.className = "pf-popup-empty";
        empty.textContent = t("No suggestions");
        popup.appendChild(empty);
    }
    for (const suggestion of list) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "pf-popup-item";
        item.textContent = suggestion;
        item.addEventListener("click", () => {
            view.dispatch(view.state.tr.insertText(suggestion, from, to));
            hideSpellPopup();
            view.focus();
        });
        popup.appendChild(item);
    }

    // Writing-app convention: "Add to dictionary" persists, "Ignore" is session-only
    const dismissActions: Array<[string, (w: string) => void]> = [
        [t("Add to dictionary"), learnWord],
        [t("Ignore"), ignoreWordSession],
    ];
    for (const [label, action] of dismissActions) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "pf-popup-item pf-popup-ignore";
        item.textContent = label;
        item.addEventListener("click", async () => {
            action(word);
            hideSpellPopup();
            // Rescan so every occurrence of the word is cleared immediately
            const { refreshProofread } = await import("../plugins/proofread");
            refreshProofread(view);
            view.focus();
        });
        popup.appendChild(item);
    }

    document.body.appendChild(popup);
    activePopup = popup;

    // Position below the word, clamped to the viewport
    const coords = view.coordsAtPos(from);
    const rect = popup.getBoundingClientRect();
    const left = Math.min(coords.left, window.innerWidth - rect.width - 8);
    const top = coords.bottom + 4 + rect.height > window.innerHeight
        ? coords.top - rect.height - 4
        : coords.bottom + 4;
    popup.style.left = `${Math.max(8, left)}px`;
    popup.style.top = `${Math.max(8, top)}px`;

    const onMouseDown = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) { hideSpellPopup(); }
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") { hideSpellPopup(); }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", hideSpellPopup, true);
    cleanup = () => {
        document.removeEventListener("mousedown", onMouseDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("scroll", hideSpellPopup, true);
    };
}
