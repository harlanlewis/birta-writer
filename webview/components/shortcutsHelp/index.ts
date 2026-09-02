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
 * Escape/Tab. These are hardcoded and therefore un-rebindable (the full
 * inventory is shared/__tests__/keymapChords.ts; whether the key-leak guard
 * also CLAIMS one is a separate question answered in
 * webview/keyboardShortcuts.ts), so a printed key can never lie.
 * Rebindable commands are deliberately NOT inventoried here — a names-only
 * list says nothing about actual keys, and printing defaults could lie —
 * the sticky "Edit Keyboard Shortcuts" footer opens the native Keyboard
 * Shortcuts UI, the one place effective bindings are always accurate.
 *
 * Launch cost is zero: this module is OFF the eager import graph. The
 * command host and the settings menu reach it through `./loader` (a cached
 * dynamic import), its CSS lives in `./styles` and is injected on the first
 * open, and the DOM is built then too, never at module load.
 *
 * Escape layering: while open the overlay registers on the
 * ui/escapeLayers.ts stack; EVERY close path (Esc, the ✕ button, an outside
 * click, re-invoking the command) unregisters, so a dead entry never
 * swallows a later Escape.
 */
import { t, kbd } from "@/i18n";
import { ensureShortcutsHelpStyles } from "./styles";
import { createButton } from "@/ui/dom";
import { IconKeyboard, IconX } from "@/ui/icons";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { onOutsideClick } from "@/ui/outsideClick";
import { claimDock, releaseDock } from "@/ui/dockExclusive";
import { notifyOpenKeybindings } from "@/messaging";
import { hostShortcuts } from "../../../shared/hostProfile";
import { commandAvailable } from "../../../shared/commandAvailability";

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

/**
 * Whether kbd() is rendering macOS chords. The panel's two platform choices
 * (the compact key column, and which smart-select chord row is printed) must
 * agree with the glyphs kbd() produces, so they are read off kbd() itself
 * rather than from a second platform probe: with `__i18n` absent, a
 * `navigator.platform` fallback here would print macOS chords through a
 * Windows-dialect kbd(), and the mixed row would be wrong on both platforms.
 */
function kbdIsMac(): boolean {
    return kbd("Mod") === "⌘";
}

// ── Module state (the overlay is a singleton, built once) ────────────────
let panel: HTMLDivElement | null = null;
let visible = false;
/** Escape-layer unregister handle (null while hidden). */
let layerOff: (() => void) | null = null;
/** Outside-click detach handle (null while hidden). */
let outsideOff: (() => void) | null = null;

/**
 * Whether a mousedown on `target` moves focus there by the browser's default
 * action: a text-entry surface (an input, textarea, select, or a
 * contenteditable region, the editor's own included). Chrome buttons and TOC
 * items are deliberately NOT in this set: they preventDefault their mousedown
 * to keep the editor focused (ui/dom.ts bindActivate), which is exactly what
 * the refocus in close() provides them.
 */
function takesFocusOnMousedown(target: EventTarget | null): boolean {
    return target instanceof Element
        && target.closest("input, textarea, select, [contenteditable]") !== null;
}

/**
 * Close the overlay. `via` is the outside mousedown that dismissed it, when
 * that is the close path; every other path (Escape, the close button, the
 * toggle, the customize action) passes nothing.
 */
function close(via?: MouseEvent): void {
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
    // Hand focus back to the editor (the find bar's close convention), unless
    // the closing click is itself a focus intent: a mousedown into a
    // text-entry surface takes focus by default the moment this handler
    // returns, and refocusing the editor first only bounces focus through it.
    if (via && takesFocusOnMousedown(via.target)) {
        return;
    }
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
    outsideOff = onOutsideClick([panel], (e) => close(e));
    // Focus lands inside so Esc/Tab work immediately; arrows scroll the list.
    panel.focus();
}

// ── DOM (lazy, one-time) ─────────────────────────────────────────────────

function buildPanel(): HTMLDivElement {
    ensureShortcutsHelpStyles();
    const isMac = kbdIsMac();
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
        className: "ui-btn ui-btn--icon shortcuts-help__close",
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
            noteEl.className = "ui-caption shortcuts-help__note";
            noteEl.textContent = note;
            descEl.appendChild(noteEl);
        }
        row.append(descEl, keysEl);
        body.appendChild(row);
    };

    // ── The fixed grammar — every chord below is a hardcoded typing-level
    // ProseMirror keymap (pinned by shared/__tests__/keymapChords.ts, which
    // the chord-literal scan checks this file against), so printing it can
    // never contradict the user's keybindings. ──
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
        [[keys("Alt-ArrowUp"), keys("Alt-ArrowDown")]],
        t("Move block up / down"),
        t("A heading moves alone — drag it in the table of contents to move its section."),
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
    // The one row in this section a publishing target can withdraw. Every
    // other chord here writes CommonMark, which no target takes away; this one
    // is bound by the same keymap and gated by the same predicate
    // (webview/plugins/formatKeymap.ts), so printing it unconditionally would
    // name a key that no longer does anything.
    if (commandAvailable("toggleStrikethrough")) {
        addRow([[keys("Mod-Shift-x")]], t("Strikethrough"));
    }
    addRow([[keys("Mod-z")]], t("Undo"));
    // Redo's two chords are independent alternatives, so they are separate
    // (single-chip) pairs and may wrap apart.
    addRow([[keys("Mod-Shift-z")], [keys("Mod-y")]], t("Redo"));

    // The host's own shortcuts, where it has any. Same content policy as
    // everything above: a key is printed only where it cannot be rebound, so
    // it cannot lie. Inside VS Code every command chord IS rebindable, which
    // is why the extension declares none of these and the footer below sends
    // the reader to the one accurate inventory instead. A standalone app whose
    // menu IS the binding is the case this exists for.
    //
    // One section per menu the keys come from, in the order the host declares
    // them. A host that binds its whole menu bar declares more keys than any
    // other section here holds, and a flat list of them would be the only
    // section in the panel with no organising idea. A key that names no section
    // still prints, under the generic heading, so a host that declares less is
    // not a host whose keys disappear.
    // Filtered before the sections are opened, not inside the loop: a heading
    // is emitted when the section changes, so dropping rows as they arrive
    // would leave a heading over a section a narrowed target had emptied.
    //
    // A row naming no command is kept whatever the target says. It is a key
    // the host binds to something that is not an editor command (a window
    // gesture, a native panel), so there is nothing for a target to withdraw.
    const printableShortcuts = hostShortcuts().filter(
        (shortcut) => shortcut.command === undefined || commandAvailable(shortcut.command),
    );
    let openSection: string | null = null;
    for (const shortcut of printableShortcuts) {
        const section = shortcut.section ?? t("This app");
        if (section !== openSection) {
            addSection(section);
            openSection = section;
        }
        addRow([[keys(shortcut.keys)]], shortcut.label);
    }

    // Rebindable commands are deliberately NOT inventoried here: a names-only
    // list says nothing about actual keys, and printing defaults could lie.
    // The sticky footer below routes to VS Code's Keyboard Shortcuts — the
    // one accurate inventory of everything rebindable. It is the same action
    // as the `openKeyboardShortcuts` command, so it goes with that command on
    // a host that has no keybindings UI (shared/hostProfile.ts).
    if (commandAvailable("openKeyboardShortcuts")) {
        const footer = document.createElement("div");
        footer.className = "shortcuts-help__footer";
        const btnCustomize = createButton({
            className: "ui-btn ui-btn--primary shortcuts-help__customize",
            label: t("Edit Keyboard Shortcuts"),
            onClick: () => {
                close();
                notifyOpenKeybindings();
            },
        });
        footer.appendChild(btnCustomize);
        el.appendChild(footer);
    }

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
