/**
 * components/gotoLine/index.ts
 *
 * The Go to Line prompt (Ctrl+G): one field under the bar that takes a
 * document line number and puts the caret there, the way VS Code's own Go to
 * Line does for a text editor. The built-in one binds to the active TEXT
 * editor, which a rendered document is not, so a reader who presses Ctrl+G
 * over this editor got nothing at all; the same reason `birta.gotoSymbol`
 * exists (src/extension.ts).
 *
 * One implementation for every host, drawn by the page: the extension routes
 * its contributed keybinding here as the `gotoLine` editor command, and the
 * Mac app's menu row runs the same command, so the two surfaces cannot ask
 * the question differently. The line it takes is a DOCUMENT line, frontmatter
 * included, which is the number the line-number gutter draws and the number
 * a diff, a compiler and a reviewer all quote.
 *
 * Preview as you type, commit on Enter, put it back on Escape. The document
 * scrolls to the line while the number is being typed, because the point of
 * the prompt is to look at a line and a reader who sees the wrong one wants
 * to change the number rather than press Enter and start again; the caret
 * moves only on Enter, since a caret that followed every keystroke would
 * move the selection the reader was about to come back to. Escape restores
 * the scroll position the prompt opened at, so a preview that went nowhere
 * useful costs nothing. A press outside the card does the same: the reader
 * has gone back to the text, and the text should be where they left it.
 *
 * A number past the end is refused, not clamped (`./parse.ts` says why), and
 * the refusal is a sentence under the field rather than a closed prompt: the
 * document's length is exactly the fact the reader was missing.
 *
 * Lazily loaded through `./loader.ts`, never from the launch path.
 */
import { t } from "@/i18n";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { claimDock, releaseDock } from "@/ui/dockExclusive";
import { watchOutsidePress } from "@/ui/outsidePress";
import { parseGotoLine } from "./parse";
import { ensureGotoLineStyles } from "./styles";
import type { GotoLineHost } from "./loader";

export type { GotoLineHost } from "./loader";

/** The dock slot id, shared with the find bar and the shortcuts overlay. */
const DOCK_ID = "goto-line";

let open: (() => void) | null = null;

/**
 * Open the prompt, or refocus it when it is already open. The host is read
 * on every open, so a document that changed length since the last one is
 * measured again.
 */
export function openGotoLine(host: GotoLineHost): void {
    if (open) {
        open();
        return;
    }
    ensureGotoLineStyles();

    const card = document.createElement("div");
    card.className = "goto-line";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", t("Go to Line"));

    const input = document.createElement("input");
    input.className = "goto-line__input";
    input.type = "text";
    input.inputMode = "numeric";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", t("Line number"));

    const hint = document.createElement("div");
    hint.className = "goto-line__hint";
    hint.id = "goto-line-hint";
    input.setAttribute("aria-describedby", hint.id);

    card.append(input, hint);
    document.body.appendChild(card);

    let lineCount = 1;
    let openedAtY = 0;
    let escapeOff: (() => void) | null = null;
    let outsideOff: (() => void) | null = null;

    function say(text: string, refused: boolean): void {
        hint.textContent = text;
        hint.classList.toggle("goto-line__hint--refused", refused);
    }

    /** What the field currently means, said under it; previewed when it is a line. */
    function react(): void {
        const parsed = parseGotoLine(input.value, lineCount);
        switch (parsed.kind) {
            case "empty": {
                const current = host.currentLine();
                const range = `${t("Type a line number, 1 to")} ${lineCount}.`;
                say(current === null ? range : `${range} ${t("The caret is on line")} ${current}.`, false);
                return;
            }
            case "target":
                say(`${t("Press Enter to go to line")} ${parsed.target.line}.`, false);
                host.reveal(parsed.target, false);
                return;
            case "outOfRange":
                say(`${t("There is no line")} ${parsed.line}. ${t("The last line is")} ${lineCount}.`, true);
                return;
            case "invalid":
                say(`${t("Type a line number, 1 to")} ${lineCount}.`, true);
                return;
        }
    }

    function close({ restore }: { restore: boolean }): void {
        if (!card.classList.contains("goto-line--visible")) { return; }
        card.classList.remove("goto-line--visible");
        escapeOff?.();
        escapeOff = null;
        outsideOff?.();
        outsideOff = null;
        releaseDock(DOCK_ID);
        if (restore) {
            window.scrollTo({ top: openedAtY });
        }
        // Removed rather than kept hidden: the prompt is rare, and a card
        // left in the DOM is one more fixed box for every layout to carry.
        open = null;
        card.remove();
        host.focusEditor();
    }

    function commit(): void {
        const parsed = parseGotoLine(input.value, lineCount);
        if (parsed.kind !== "target") {
            // Enter on a refused number says the refusal again rather than
            // closing: the sentence is the answer.
            react();
            return;
        }
        // Close first, so the caret placement is the last thing to touch the
        // scroll position rather than the restore.
        close({ restore: false });
        host.reveal(parsed.target, true);
    }

    input.addEventListener("input", react);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            commit();
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close({ restore: true });
        }
    });

    open = (): void => {
        lineCount = Math.max(1, host.lineCount());
        openedAtY = window.scrollY;
        claimDock(DOCK_ID, () => close({ restore: true }));
        card.classList.add("goto-line--visible");
        escapeOff ??= registerEscapeLayer(() => close({ restore: true }));
        outsideOff ??= watchOutsidePress([card], () => close({ restore: true }));
        input.value = "";
        react();
        input.focus();
    };
    open();
}

/** Whether the prompt is on screen (tests). */
export function isGotoLineOpen(): boolean {
    return open !== null;
}
