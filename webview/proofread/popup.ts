/**
 * Lint popup: click a flagged word to see Harper's message, apply a
 * suggestion, add the word to your dictionary (spelling), or ignore the
 * finding for this session.
 */
import type { EditorView } from "@milkdown/prose/view";
import type { HarperLint } from "../../shared/messages";
import { t } from "../i18n";
import { ignoreLintSession, learnWord } from "./engine";
import "./proofread.css";

let activePopup: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function hideLintPopup(): void {
    cleanup?.();
    cleanup = null;
    activePopup?.remove();
    activePopup = null;
}

export function showLintPopup(view: EditorView, from: number, to: number, lint: HarperLint): void {
    hideLintPopup();

    const word = view.state.doc.textBetween(from, to);
    if (!word) { return; }

    const popup = document.createElement("div");
    popup.className = "pf-popup";

    const message = document.createElement("div");
    message.className = "pf-popup-message";
    message.textContent = lint.message;
    popup.appendChild(message);

    for (const suggestion of lint.suggestions) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "pf-popup-item";
        item.textContent = suggestion === "" ? t("Remove") : suggestion;
        item.addEventListener("click", () => {
            view.dispatch(view.state.tr.insertText(suggestion, from, to));
            hideLintPopup();
            view.focus();
        });
        popup.appendChild(item);
    }

    // Writing-app convention: "Add to dictionary" persists, "Ignore" is session-only
    const dismissActions: Array<[string, () => void]> = [[t("Ignore"), () => ignoreLintSession(lint.kind, word)]];
    if (lint.kind === "Spelling") {
        dismissActions.unshift([t("Add to dictionary"), () => learnWord(word)]);
    }
    for (const [label, action] of dismissActions) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "pf-popup-item pf-popup-ignore";
        item.textContent = label;
        item.addEventListener("click", async () => {
            action();
            hideLintPopup();
            // Rescan so every occurrence is cleared immediately
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
        if (!popup.contains(e.target as Node)) { hideLintPopup(); }
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") { hideLintPopup(); }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", hideLintPopup, true);
    cleanup = () => {
        document.removeEventListener("mousedown", onMouseDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("scroll", hideLintPopup, true);
    };
}
