/**
 * webview/components/shortcutsHelp/index.ts
 *
 * The keyboard-shortcuts HELP overlay (birta.editor.
 * openShortcutsHelp) — a read-only cheatsheet, right-docked below the topbar
 * like the find bar. Deliberately distinct from `openKeyboardShortcuts`,
 * which opens VS Code's native Keyboard Shortcuts UI and remains the
 * customize/rebind path; this overlay links to it with a button rather than
 * duplicating it.
 *
 * Content policy (the noHardcodedKeybindings.test.ts philosophy): this is an
 * inventory of what the shortcuts ARE. Only the FIXED grammar is printed —
 * the typing-level ProseMirror keymap chords (formatKeymap, history,
 * blockKeys, smartSelect, insertParagraph, tab/table keymaps) plus
 * Escape/Tab. These are hardcoded and un-rebindable (see CLAIMED_SHORTCUTS
 * in webview/keyboardShortcuts.ts), so a printed key can never lie.
 * Rebindable commands are deliberately NOT inventoried here — a names-only
 * list says nothing about actual keys, and printing defaults could lie —
 * the sticky "Edit Keyboard Shortcuts" footer opens the native Keyboard
 * Shortcuts UI, the one place effective bindings are always accurate.
 *
 * Launch cost is zero: this module is in the eager import graph
 * (webview/index.ts wires it into the command host), so the overlay DOM is
 * built lazily on the first open, never at module load.
 *
 * Escape layering: while open the overlay registers on the
 * ui/escapeLayers.ts stack; EVERY close path (Esc, the ✕ button, an outside
 * click, re-invoking the command) unregisters, so a dead entry never
 * swallows a later Escape.
 */
import "./shortcutsHelp.css";
import { t, kbd } from "@/i18n";
import { createButton } from "@/ui/dom";
import { IconKeyboard, IconX } from "@/ui/icons";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { onOutsideClick } from "@/ui/outsideClick";
import { claimDock, releaseDock } from "@/ui/dockExclusive";
import { notifyOpenKeybindings } from "@/messaging";

/**
 * kbd() output post-processing: kbd() upper-cases the final key segment
 * (fine for letters — ⌘B), but named keys and the raw Ctrl/Cmd tokens of the
 * macOS smart-select chord need their display glyphs.
 */
const KEY_DISPLAY: readonly [RegExp, string][] = [
    [/ARROWUP/g, "↑"],
    [/ARROWDOWN/g, "↓"],
    [/ARROWLEFT/g, "←"],
    [/ARROWRIGHT/g, "→"],
    [/ENTER/g, "Enter"],
    [/TAB/g, "Tab"],
    // Only ever produced by the macOS smart-select chord ("Ctrl-…-Cmd-…");
    // on Windows/Linux kbd() renders Mod as mixed-case "Ctrl", untouched.
    [/CTRL/g, "⌃"],
    [/CMD/g, "⌘"],
];

/** Platform display for a fixed ProseMirror chord: "Mod-Shift-ArrowUp" → ⌘⇧↑ / Ctrl+Shift+↑. */
function keys(chord: string): string {
    let out = kbd(chord);
    for (const [re, glyph] of KEY_DISPLAY) {
        out = out.replace(re, glyph);
    }
    return out;
}

// ── Module state (the overlay is a singleton, built once) ────────────────
let panel: HTMLDivElement | null = null;
let visible = false;
/** Escape-layer unregister handle (null while hidden). */
let layerOff: (() => void) | null = null;
/** Outside-click detach handle (null while hidden). */
let outsideOff: (() => void) | null = null;

function close(): void {
    if (!visible) {
        return;
    }
    visible = false;
    // Every close path funnels here: drop the layer entry (idempotent) or a
    // dead one would eat a later Escape.
    layerOff?.();
    layerOff = null;
    releaseDock("shortcuts-help");
    panel?.classList.remove("shortcuts-help--visible");
    outsideOff?.();
    outsideOff = null;
    // Hand focus back to the editor (the find bar's close convention).
    document.querySelector<HTMLElement>(".ProseMirror")?.focus();
}

/** Open the shortcuts-help overlay; invoking it while open closes it. */
export function openShortcutsHelp(): void {
    if (visible) {
        close();
        return;
    }
    panel ??= buildPanel();
    // The overlay shares its dock rect with the find bar; claiming closes
    // the bar if it is open (see ui/dockExclusive.ts) — otherwise the bar
    // would sit invisibly underneath with focus in an unseeable input.
    claimDock("shortcuts-help", close);
    visible = true;
    panel.classList.add("shortcuts-help--visible");
    layerOff ??= registerEscapeLayer(close);
    // Outside click closes (capture phase, so stopped mousedowns still count).
    outsideOff = onOutsideClick([panel], close);
    // Focus lands inside so Esc/Tab work immediately; arrows scroll the list.
    panel.focus();
}

// ── DOM (lazy, one-time) ─────────────────────────────────────────────────

function buildPanel(): HTMLDivElement {
    const isMac = window.__i18n?.isMac ?? /Mac/.test(navigator.platform);
    const el = document.createElement("div");
    el.className = "shortcuts-help";
    // macOS chords are compact symbol runs (⌘⇧↑); Windows/Linux chords are
    // word chains (Ctrl+Shift+↑). The key column width follows the platform
    // so neither wastes space nor overflows (see --shortcuts-keycol).
    el.classList.toggle("shortcuts-help--mac", isMac);
    el.setAttribute("role", "dialog");
    // Matches the visible header title below (the retired "… Help" phrasing
    // came from the command's old name).
    el.setAttribute("aria-label", t("Keyboard Shortcuts"));
    el.tabIndex = -1;

    // Header
    const header = document.createElement("div");
    header.className = "shortcuts-help__header";
    const headerIcon = document.createElement("span");
    headerIcon.className = "shortcuts-help__header-icon";
    headerIcon.setAttribute("aria-hidden", "true");
    headerIcon.innerHTML = IconKeyboard;
    const title = document.createElement("h2");
    title.className = "shortcuts-help__title";
    title.textContent = t("Keyboard Shortcuts");
    const btnClose = createButton({
        className: "shortcuts-help__close",
        icon: IconX,
        title: `${t("Close")} (Esc)`,
        onClick: close,
    });
    header.append(headerIcon, title, btnClose);
    el.appendChild(header);

    // The scrollable middle: header and footer stay put as fixed flex children
    // of the panel; only this body scrolls (wheel contained, never chaining to
    // the document), and its bottom padding keeps the last row clear of the
    // footer.
    const body = document.createElement("div");
    body.className = "shortcuts-help__body";
    el.appendChild(body);

    const addSection = (label: string): void => {
        const h = document.createElement("h3");
        // ui-heading: the shared chrome heading grade (matches a ToC H1).
        h.className = "shortcuts-help__section-title ui-heading";
        h.textContent = label;
        body.appendChild(h);
    };
    // Each row is a two-column grid: the description on the LEFT (its left
    // edge identical on every row) and the chips right-aligned at the row's
    // trailing edge. Chips are grouped into PAIRS — one inner array per
    // gesture alternative (e.g. the up/down chips of one move chord family)
    // — and each pair renders as an inline-flex sub-span, so line wraps only
    // ever fall BETWEEN alternatives, never inside one (the 4-chip move set
    // becomes a clean 2×2 stack instead of an arbitrary 3+1 split).
    const addRow = (keyPairs: string[][], label: string, note?: string): void => {
        const row = document.createElement("div");
        row.className = "shortcuts-help__row";
        const keysEl = document.createElement("span");
        keysEl.className = "shortcuts-help__keys";
        for (const pair of keyPairs) {
            const pairEl = document.createElement("span");
            pairEl.className = "shortcuts-help__pair";
            for (const k of pair) {
                const chip = document.createElement("kbd");
                chip.textContent = k;
                pairEl.appendChild(chip);
            }
            keysEl.appendChild(pairEl);
        }
        const descEl = document.createElement("div");
        descEl.className = "shortcuts-help__desc";
        const labelEl = document.createElement("span");
        labelEl.className = "shortcuts-help__label";
        labelEl.textContent = label;
        descEl.appendChild(labelEl);
        if (note) {
            // The note is a quieter second line INSIDE the description cell,
            // so it never sprawls into the key column.
            const noteEl = document.createElement("div");
            noteEl.className = "shortcuts-help__note";
            noteEl.textContent = note;
            descEl.appendChild(noteEl);
        }
        row.append(descEl, keysEl);
        body.appendChild(row);
    };

    // ── The fixed grammar — every chord below is a hardcoded typing-level
    // ProseMirror keymap (verified against blockKeys/smartSelect/
    // insertParagraph/tabKeymap/formatKeymap/history + CLAIMED_SHORTCUTS),
    // so printing it can never contradict the user's keybindings. ──
    addSection(t("Selection"));
    addRow([["Esc"]], t("Select the block; again to collapse back to the caret"),
        t("Esc first closes the open menu, popup, or find bar."));
    addRow([[keys("Shift-ArrowUp"), keys("Shift-ArrowDown")]], t("Grow / shrink a block selection"));
    addRow([[keys("Mod-a")]], t("Select more: block text → block → document"));
    addRow(
        isMac
            ? [[keys("Ctrl-Shift-Cmd-ArrowRight"), keys("Ctrl-Shift-Cmd-ArrowLeft")]]
            : [[keys("Shift-Alt-ArrowRight"), keys("Shift-Alt-ArrowLeft")]],
        t("Expand / shrink the selection by structure"),
    );

    addSection(t("Blocks"));
    addRow(
        // Two alternatives for the same gesture — each pair stays intact,
        // so the four chips always read as a 2×2 stack.
        [
            [keys("Alt-ArrowUp"), keys("Alt-ArrowDown")],
            [keys("Mod-Shift-ArrowUp"), keys("Mod-Shift-ArrowDown")],
        ],
        t("Move block up / down"),
        t("Move carries a heading's whole section."),
    );
    addRow(
        [[keys("Shift-Alt-ArrowUp"), keys("Shift-Alt-ArrowDown")]],
        t("Duplicate block above / below"),
        t("Duplicate copies the block alone — it never drags a section along."),
    );
    addRow([[keys("Mod-Enter")]], t("Insert paragraph below"),
        t("Inside a code block or table: exits it instead."));
    addRow([[keys("Mod-Shift-Enter")]], t("Insert paragraph above"));
    addRow([["←", "→"]], t("Collapse / expand the selected foldable block"));
    addRow([["Tab", keys("Shift-Tab")]], t("Indent / outdent a list item; next / previous table cell"));

    addSection(t("Formatting & history"));
    addRow([[keys("Mod-b")]], t("Bold"));
    addRow([[keys("Mod-i")]], t("Italic"));
    addRow([[keys("Mod-e")]], t("Inline Code"));
    addRow([[keys("Mod-Shift-x")]], t("Strikethrough"));
    addRow([[keys("Mod-z")]], t("Undo"));
    // Redo's two chords are independent alternatives, so they are separate
    // (single-chip) pairs and may wrap apart.
    addRow([[keys("Mod-Shift-z")], [keys("Mod-y")]], t("Redo"));

    // Rebindable commands are deliberately NOT inventoried here: a names-only
    // list says nothing about actual keys, and printing defaults could lie.
    // The sticky footer below routes to VS Code's Keyboard Shortcuts — the
    // one accurate inventory of everything rebindable.
    const footer = document.createElement("div");
    footer.className = "shortcuts-help__footer";
    const btnCustomize = createButton({
        className: "shortcuts-help__customize",
        label: t("Edit Keyboard Shortcuts"),
        onClick: () => {
            close();
            notifyOpenKeybindings();
        },
    });
    footer.appendChild(btnCustomize);
    el.appendChild(footer);

    // Esc closes from anywhere inside the panel; with editor focus the
    // escape-layer stack (blockKeys' Escape wiring) covers it instead.
    el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    });
    // Keep clicks inside the panel out of the editor (find-bar convention).
    el.addEventListener("mousedown", (e) => e.stopPropagation());

    document.body.appendChild(el);
    return el;
}
