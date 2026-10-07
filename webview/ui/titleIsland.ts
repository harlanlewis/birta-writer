/**
 * The editable title a container draws in its own chrome row: a callout's
 * title, a directive's, a `<details>` summary. The text lives in a node attr,
 * so the span is its own contentEditable island rather than ProseMirror's,
 * and every one of them keeps the same four promises:
 *
 *   - Enter commits, by leaving the island (blur is what commits);
 *   - Escape reverts to the stored text, then leaves;
 *   - Mod+A selects within the island, where natively it escapes into the
 *     surrounding contenteditable and selects the whole document;
 *   - an untouched title commits nothing, so focusing one never dirties.
 *
 * One place, so the three cannot drift apart in which keys they honour.
 * Read-only is the caller's, through `markEditableIsland`.
 */
import { isBareEscape } from "./escapeLayers";

export interface TitleIslandOptions {
    /** The text the island shows when nothing is being typed, read fresh. */
    current: () => string;
    /** Called on blur with the trimmed text, only when it differs from `current()`. */
    commit: (typed: string) => void;
}

export function bindTitleIsland(el: HTMLElement, options: TitleIslandOptions): void {
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            el.blur();
        } else if (isBareEscape(e)) {
            e.preventDefault();
            el.textContent = options.current();
            el.blur();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        }
    });
    el.addEventListener("blur", () => {
        const typed = (el.textContent ?? "").trim();
        if (typed !== options.current()) {
            options.commit(typed);
        }
    });
}
