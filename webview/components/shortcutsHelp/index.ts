/**
 * webview/components/shortcutsHelp/index.ts
 *
 * The keyboard-shortcuts HELP overlay (markdownWysiwyg.editor.
 * openShortcutsHelp) — a read-only cheatsheet, right-docked below the topbar
 * like the find bar. Deliberately distinct from `openKeyboardShortcuts`,
 * which opens VS Code's native Keyboard Shortcuts UI and remains the
 * customize/rebind path; this overlay links to it with a button rather than
 * duplicating it.
 *
 * Content policy (the noHardcodedKeybindings.test.ts philosophy):
 *   - Only the FIXED grammar is printed with keys: the typing-level
 *     ProseMirror keymap chords (formatKeymap, history, blockKeys,
 *     smartSelect, insertParagraph, tab/table keymaps) plus Escape/Tab.
 *     These are hardcoded and un-rebindable (see CLAIMED_SHORTCUTS in
 *     webview/keyboardShortcuts.ts), so a printed key can never lie.
 *   - Everything rebindable is listed by NAME only, with one note and an
 *     "Edit Keyboard Shortcuts" button that opens the native Keyboard
 *     Shortcuts UI (the one place effective bindings are always accurate).
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
import { claimDock, releaseDock } from "@/ui/dockExclusive";
import { notifyOpenKeybindings } from "@/messaging";
import { EDITOR_COMMANDS, type EditorCommandId } from "../../../shared/editorCommands";

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
 * Rebindable commands shown by NAME only, grouped. Titles come from the
 * command registry so the overlay can never drift from the palette. Commands
 * whose fixed default chord is already printed in the grammar sections
 * (bold, undo, duplicate, …) are deliberately not repeated here.
 */
const REBINDABLE_GROUPS: readonly { label: string; ids: readonly EditorCommandId[] }[] = [
    {
        label: "Find",
        ids: ["openFind", "openFindReplace", "findNext", "findPrevious", "findSelection", "selectAllOccurrences"],
    },
    { label: "Blocks", ids: ["openBlockMenu", "deleteBlock"] },
    { label: "Folding", ids: ["fold", "unfold", "foldAll", "unfoldAll"] },
    {
        label: "Headings & lists",
        ids: [
            "setParagraph", "setHeading1", "setHeading2", "setHeading3", "setHeading4",
            "setHeading5", "setHeading6", "toggleBulletList", "toggleOrderedList",
            "toggleTaskList", "toggleBlockquote",
        ],
    },
    {
        label: "Insert",
        ids: [
            "insertLink", "insertImage", "insertTable", "insertCodeBlock",
            "insertMath", "insertFootnote", "insertCallout", "insertHorizontalRule",
        ],
    },
    {
        label: "Text",
        ids: [
            "toggleHighlight", "clearFormatting", "transformToUppercase",
            "transformToLowercase", "transformToTitleCase", "joinLines",
        ],
    },
    {
        label: "View",
        ids: [
            "toggleToc", "swapTocSide", "toggleToolbar", "customizeToolbar",
            "editFrontmatter", "editRawMarkdown",
        ],
    },
    {
        label: "Fonts",
        ids: [
            "fontEditor", "fontSans", "fontSerif", "fontMono",
            "increaseFontSize", "decreaseFontSize",
        ],
    },
    { label: "Proofreading", ids: ["toggleSpellCheck", "toggleGrammarCheck", "toggleStyleCheck"] },
];

// ── Module state (the overlay is a singleton, built once) ────────────────
let panel: HTMLDivElement | null = null;
let visible = false;
/** Escape-layer unregister handle (null while hidden). */
let layerOff: (() => void) | null = null;

/** Outside click closes (capture phase, so stopped mousedowns still count). */
function onDocMousedown(e: MouseEvent): void {
    if (panel && e.target instanceof Node && !panel.contains(e.target)) {
        close();
    }
}

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
    document.removeEventListener("mousedown", onDocMousedown, true);
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
    document.addEventListener("mousedown", onDocMousedown, true);
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

    const addSection = (label: string): void => {
        const h = document.createElement("h3");
        h.className = "shortcuts-help__section-title";
        h.textContent = label;
        el.appendChild(h);
    };
    // Each row is a two-column grid: a fixed-width key column (chips
    // right-aligned, wrapping within the column) and a description column
    // whose left edge is identical on every row. Chips are grouped into
    // PAIRS — one inner array per gesture alternative (e.g. the up/down
    // chips of one move chord family) — and each pair renders as an
    // inline-flex sub-span, so line wraps only ever fall BETWEEN
    // alternatives, never inside one (the 4-chip move set becomes a clean
    // 2×2 stack instead of an arbitrary 3+1 split).
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
            // so it never sprawls across the key column.
            const noteEl = document.createElement("div");
            noteEl.className = "shortcuts-help__note";
            noteEl.textContent = note;
            descEl.appendChild(noteEl);
        }
        row.append(keysEl, descEl);
        el.appendChild(row);
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

    // ── Rebindable commands: names only — their keys live in (and may be
    // changed via) VS Code's Keyboard Shortcuts, so printing a default here
    // could show a wrong chord. ──
    addSection(t("Customizable commands"));
    const titleOf = new Map<string, string>(EDITOR_COMMANDS.map((c) => [c.id, c.title]));
    // Structure over prose: each group is a small subheading followed by a
    // two-column name list (NO kbd chips — these are rebindable, so a
    // printed chord could lie). Scans vertically instead of wrapping inline.
    for (const group of REBINDABLE_GROUPS) {
        const div = document.createElement("div");
        div.className = "shortcuts-help__group";
        const name = document.createElement("h4");
        name.className = "shortcuts-help__group-name";
        name.textContent = t(group.label);
        // A real list (ul/li) so assistive tech announces item count and
        // boundaries — the visual grid alone gives adjacent names no
        // accessible delimitation.
        const items = document.createElement("ul");
        items.className = "shortcuts-help__group-items";
        for (const id of group.ids) {
            const item = document.createElement("li");
            item.className = "shortcuts-help__group-item";
            const itemName = t(titleOf.get(id) ?? id);
            item.textContent = itemName;
            // Names ellipsize in the two-column grid; the title makes a
            // clipped name recoverable on hover.
            item.title = itemName;
            items.appendChild(item);
        }
        div.append(name, items);
        el.appendChild(div);
    }

    const footer = document.createElement("div");
    footer.className = "shortcuts-help__footer";
    const note = document.createElement("span");
    note.className = "shortcuts-help__note";
    note.textContent = t("These commands' keys are shown — and customizable — in VS Code's Keyboard Shortcuts.");
    const btnCustomize = createButton({
        className: "shortcuts-help__customize",
        label: t("Edit Keyboard Shortcuts"),
        onClick: () => {
            close();
            notifyOpenKeybindings();
        },
    });
    footer.append(note, btnCustomize);
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
