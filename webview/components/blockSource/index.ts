/**
 * components/blockSource — source-peek (MAR-20).
 *
 * Mod+/ swaps the caret's top-level block (or the selected block range) for a
 * textarea holding that block's Markdown. Mod+Enter or blur commits, Escape
 * cancels, and committing text that was never edited closes without touching
 * the document at all: opening a block to look at it must not dirty the file.
 *
 * The round trip itself lives in editing/blockSource.ts, which explains why
 * the commit parses with the document's definitions in scope. This module is
 * only the surface.
 *
 * Escape is handled on the textarea rather than through ui/escapeLayers: the
 * textarea holds focus for its whole lifetime, so open implies topmost, and
 * blur is itself a close path. Same carve-out the HTML source panel takes.
 */
import "./blockSource.css";
import type { EditorView } from "@/pm";
import { kbd, t } from "@/i18n";

export interface BlockSourcePanelHandlers {
    commit(text: string): void;
    cancel(): void;
}

export interface BlockSourcePanel {
    dom: HTMLElement;
    area: HTMLTextAreaElement;
    focus(): void;
    showError(message: string): void;
}

/** Commit handles by textarea, so `bankOpenBlockSourcePanel` can reach one. */
const commits = new WeakMap<HTMLTextAreaElement, () => void>();

/**
 * Commit an open block source panel inside this view, if any. Called at the
 * seams that read or persist the document while the panel may hold an
 * uncommitted edit - the mode switch and the save flush - so neither can act
 * on bytes older than what the user sees in the panel.
 *
 * This commits directly rather than through `blur`, because the panel treats
 * an early blur as a focus theft to be reclaimed rather than as the user
 * leaving.
 */
export function bankOpenBlockSourcePanel(view: EditorView): void {
    const active = document.activeElement;
    if (
        active instanceof HTMLTextAreaElement &&
        active.classList.contains("block-source-area") &&
        view.dom.contains(active)
    ) {
        commits.get(active)?.();
    }
}

/** Grow the textarea to its content so no source is hidden behind a scrollbar. */
function autosize(area: HTMLTextAreaElement): void {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
}

export function createBlockSourcePanel(
    source: string,
    handlers: BlockSourcePanelHandlers,
): BlockSourcePanel {
    const dom = document.createElement("div");
    dom.className = "block-source";

    const area = document.createElement("textarea");
    area.className = "block-source-area";
    area.value = source;
    area.spellcheck = false;
    area.setAttribute("aria-label", t("Block source"));

    const error = document.createElement("div");
    error.className = "block-source-error";
    error.hidden = true;

    const hint = document.createElement("div");
    hint.className = "block-source-hint";
    const commitHint = document.createElement("span");
    commitHint.textContent = `${kbd("Mod-Enter")} ${t("to apply")}`;
    const cancelHint = document.createElement("span");
    cancelHint.textContent = `${kbd("Escape")} ${t("to cancel")}`;
    hint.append(commitHint, cancelHint);

    dom.append(area, error, hint);

    // A commit can be reached twice (Mod+Enter, then the blur it causes), and
    // the second one would apply the same text to a range that has moved.
    let done = false;
    const once = (run: () => void) => {
        if (done) return;
        done = true;
        run();
    };

    commits.set(area, () => once(() => handlers.commit(area.value)));

    area.addEventListener("input", () => {
        autosize(area);
        error.hidden = true;
    });

    area.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            once(handlers.cancel);
            return;
        }
        // Mod+Enter applies; Mod+/ applies too, so the shortcut that opened
        // the panel also closes it rather than doing nothing from inside.
        const isMod = event.metaKey || event.ctrlKey;
        if (isMod && (event.key === "Enter" || event.key === "/")) {
            event.preventDefault();
            event.stopPropagation();
            once(() => handlers.commit(area.value));
        }
    });

    // prosemirror-view re-asserts the DOM selection on a timer shortly after
    // the editor takes focus, and guards that re-assert with `view.input
    // .mouseDown` so it cannot fight a drag. A widget that hides its events
    // from the view (`stopEvent`, which this panel needs) never sets that
    // field, so the re-assert is unguarded and can pull focus out of a panel
    // the user has only just opened. A blur that early is that timer, not the
    // user leaving, and committing on it would apply the source before they
    // typed. Reclaim focus once; a later blur is genuine.
    const RECLAIM_WINDOW_MS = 150;
    const openedAt = performance.now();
    let reclaimed = false;

    area.addEventListener("blur", () => {
        if (!reclaimed && dom.isConnected && performance.now() - openedAt < RECLAIM_WINDOW_MS) {
            reclaimed = true;
            requestAnimationFrame(() => {
                if (dom.isConnected) area.focus();
            });
            return;
        }
        once(() => handlers.commit(area.value));
    });

    return {
        dom,
        area,
        focus() {
            area.focus();
            autosize(area);
            area.setSelectionRange(area.value.length, area.value.length);
        },
        showError(message: string) {
            // Reopen the panel for another attempt rather than closing over
            // text the parser rejected.
            done = false;
            error.textContent = message;
            error.hidden = false;
            area.focus();
        },
    };
}
