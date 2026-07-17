/**
 * shared/editorCommands.ts
 *
 * The single authoritative list of editor actions exposed as VS Code commands
 * (command palette) and right-click `webview/context` menu items (MAR-9).
 *
 * This module is intentionally dependency-free (no Milkdown, no vscode) so it
 * can be imported from BOTH sides:
 *   - the extension (`src/extension.ts`) registers one command per entry;
 *   - the webview (`webview/editorCommands.ts`) implements the behavior;
 *   - a drift-guard test asserts package.json's contributions match this list.
 *
 * Each contributed VS Code command is `birta.editor.<id>`; the
 * message protocol carries the bare `<id>` as `EditorCommandId`.
 */

export type WebviewSection = "editor" | "table" | "link" | "toolbar" | "toolbarTab";

export interface EditorCommandMeta {
    /** Stable id; also the message payload and the command-name suffix. */
    readonly id: string;
    /** English base title (mirrored into package.nls.json keys). */
    readonly title: string;
    /** Whether the command shows in the command palette (Cmd+Shift+P). */
    readonly palette: boolean;
    /** Right-click `webview/context` sections the command appears in. */
    readonly sections: readonly WebviewSection[];
    /**
     * Toolbar-chrome menu grouping. Menu renderers insert a separator whenever
     * the group changes between consecutive TOOLBAR_MENU_COMMANDS entries; the
     * native right-click menu mirrors it via the `webview/context` group
     * prefixes in package.json (`1_layout` / `2_shortcuts` / `3_settings` —
     * VS Code draws separators between groups). Required on every
     * `sections: ["toolbar"]` entry (drift-guarded), optional elsewhere.
     */
    readonly menuGroup?: "layout" | "shortcuts" | "settings";
}

export const EDITOR_COMMANDS = [
    { id: "toggleBold", title: "Bold", palette: true, sections: [] },
    { id: "toggleItalic", title: "Italic", palette: true, sections: [] },
    { id: "toggleStrikethrough", title: "Strikethrough", palette: true, sections: [] },
    { id: "toggleHighlight", title: "Highlight", palette: true, sections: [] },
    { id: "toggleInlineCode", title: "Inline Code", palette: true, sections: [] },
    { id: "clearFormatting", title: "Clear Formatting", palette: true, sections: [] },
    { id: "setParagraph", title: "Paragraph", palette: true, sections: [] },
    { id: "setHeading1", title: "Heading 1", palette: true, sections: [] },
    { id: "setHeading2", title: "Heading 2", palette: true, sections: [] },
    { id: "setHeading3", title: "Heading 3", palette: true, sections: [] },
    { id: "setHeading4", title: "Heading 4", palette: true, sections: [] },
    { id: "setHeading5", title: "Heading 5", palette: true, sections: [] },
    { id: "setHeading6", title: "Heading 6", palette: true, sections: [] },
    { id: "toggleBulletList", title: "Bullet List", palette: true, sections: [] },
    { id: "toggleOrderedList", title: "Ordered List", palette: true, sections: [] },
    { id: "toggleTaskList", title: "Task List", palette: true, sections: [] },
    { id: "toggleBlockquote", title: "Blockquote", palette: true, sections: [] },
    { id: "insertCodeBlock", title: "Code Block", palette: true, sections: [] },
    { id: "insertHorizontalRule", title: "Horizontal Rule", palette: true, sections: [] },
    { id: "insertTable", title: "Insert Table", palette: true, sections: [] },
    { id: "insertLink", title: "Insert/Edit Link", palette: true, sections: ["link"] },
    // In-note anchor link (MAR-176): pick a heading, insert `[text](#slug)`.
    // Palette-only (no right-click section) — the discoverable surfaces are the
    // slash menu and the floating selection toolbar's own button.
    { id: "insertSectionLink", title: "Link to Section", palette: true, sections: [] },
    { id: "insertImage", title: "Insert Image", palette: true, sections: [] },
    { id: "insertMath", title: "Insert Math", palette: true, sections: [] },
    { id: "insertFootnote", title: "Insert Footnote", palette: true, sections: [] },
    { id: "insertCallout", title: "Insert Callout", palette: true, sections: [] },
    // Toolbar Quote-dropdown semantics (menuitemcheckbox rows): same-kind
    // lifts out, different-kind retypes in place, outside wraps. Not in the
    // palette — insertCallout is the plain insert everywhere else.
    { id: "toggleCallout", title: "Toggle Callout", palette: false, sections: [] },
    { id: "openFind", title: "Find", palette: true, sections: [] },
    { id: "openFindReplace", title: "Replace", palette: true, sections: [] },
    // Find navigation is contributed (rather than handled as hardcoded webview
    // keydowns) so users can rebind it like any VS Code keybinding; the
    // defaults in package.json mirror the built-in editor's find bindings.
    { id: "findNext", title: "Find Next", palette: true, sections: [] },
    { id: "findPrevious", title: "Find Previous", palette: true, sections: [] },
    // Cmd+D: seed from the selection/word, then advance the document selection
    // to each next occurrence (the single-selection analog of VS Code's "Add
    // Selection To Next Find Match").
    { id: "findSelection", title: "Select Next Occurrence", palette: true, sections: [] },
    // Shift+Cmd+L: seed from the selection/word and open focused on the replace
    // input with every occurrence highlighted — one keystroke from Replace All.
    { id: "selectAllOccurrences", title: "Select All Occurrences", palette: true, sections: [] },
    { id: "toggleToc", title: "Toggle Table of Contents", palette: true, sections: [] },
    { id: "editFrontmatter", title: "Edit Frontmatter", palette: true, sections: [] },
    { id: "tableInsertRowAbove", title: "Insert Row Above", palette: false, sections: ["table"] },
    { id: "tableInsertRowBelow", title: "Insert Row Below", palette: false, sections: ["table"] },
    { id: "tableInsertColumnLeft", title: "Insert Column Left", palette: false, sections: ["table"] },
    { id: "tableInsertColumnRight", title: "Insert Column Right", palette: false, sections: ["table"] },
    // Column alignment (GFM `:---:` markers). Re-picking a column's current
    // alignment clears it back to the unmarked `---` default.
    { id: "tableAlignColumnLeft", title: "Align Column Left", palette: false, sections: ["table"] },
    { id: "tableAlignColumnCenter", title: "Align Column Center", palette: false, sections: ["table"] },
    { id: "tableAlignColumnRight", title: "Align Column Right", palette: false, sections: ["table"] },
    { id: "tableDeleteRow", title: "Delete Row", palette: false, sections: ["table"] },
    { id: "tableDeleteColumn", title: "Delete Column", palette: false, sections: ["table"] },
    { id: "tableDeleteTable", title: "Delete Table", palette: false, sections: ["table"] },
    { id: "copyAsHtml", title: "Copy as HTML", palette: false, sections: ["editor", "table", "link"] },
    { id: "copyAsMarkdown", title: "Copy as Markdown", palette: false, sections: ["editor", "table", "link"] },
    // Bottom "9_view" group of every content menu; same switch path as the
    // toolbar button (carries the first visible line to preserve the viewport).
    { id: "editRawMarkdown", title: "Edit Raw Markdown", palette: false, sections: ["editor", "table", "link"] },
    // Toolbar (chrome) right-click menu. The settings-gear dropdown is built
    // from these same entries (filtered by the "toolbar" section, in this
    // order), with a separator on every `menuGroup` change, so the two menus
    // can never diverge. Hide/Show are separate idempotent commands rather
    // than one toggle so every surface shows the label that matches its state:
    // the visible bar (and gear menu) offers "Hide Toolbar", while the
    // collapsed expand tab — stamped with its own "toolbarTab" section —
    // offers only "Show Toolbar".
    { id: "customizeToolbar", title: "Customize Toolbar", palette: true, sections: ["toolbar"], menuGroup: "layout" },
    // Hide/Show are per-surface labels for the right-click and gear menus (each
    // shows the one that matches its state); the palette and slash menu use the
    // single `toggleToolbar` below instead, so they are palette:false here.
    { id: "hideToolbar", title: "Hide Toolbar", palette: false, sections: ["toolbar"], menuGroup: "layout" },
    // Show/Edit are parallel verb-first labels for the shortcuts pair: "Show"
    // opens the read-only cheatsheet overlay (learn first), "Edit" opens
    // VS Code's native Keyboard Shortcuts UI (rebind second) — see the
    // sequence-3 comment below for why the two stay distinct commands.
    // Command ids are unchanged so existing user keybindings keep working.
    { id: "openShortcutsHelp", title: "Show Keyboard Shortcuts", palette: true, sections: ["toolbar"], menuGroup: "shortcuts" },
    { id: "openKeyboardShortcuts", title: "Edit Keyboard Shortcuts", palette: false, sections: ["toolbar"], menuGroup: "shortcuts" },
    // The full title is the SETTINGS_TITLE_TEMPLATE expansion of package.json's
    // displayName (drift-guarded); the gear menu interpolates the runtime
    // product name via settingsMenuTitle() instead of using this literal.
    { id: "openExtensionSettings", title: "Birta Writer Settings", palette: false, sections: ["toolbar"], menuGroup: "settings" },
    { id: "showToolbar", title: "Show Toolbar", palette: false, sections: ["toolbarTab"] },
    // View controls — the font picker, size stepper, proofread toggles, and TOC
    // side/visibility. Previously reachable only from the toolbar (and, for a
    // few, the slash menu's bespoke action dispatch); contributed here so the
    // command palette — the standard surface for editor-chrome actions — can
    // reach them too. Each preset/direction is its own id because a palette
    // entry carries no argument.
    { id: "fontEditor", title: "Editor Font", palette: true, sections: [] },
    { id: "fontSans", title: "Sans-Serif Font", palette: true, sections: [] },
    { id: "fontSerif", title: "Serif Font", palette: true, sections: [] },
    { id: "fontMono", title: "Monospace Font", palette: true, sections: [] },
    { id: "increaseFontSize", title: "Increase Font Size", palette: true, sections: [] },
    { id: "decreaseFontSize", title: "Decrease Font Size", palette: true, sections: [] },
    { id: "toggleSpellCheck", title: "Check Spelling", palette: true, sections: [] },
    { id: "toggleGrammarCheck", title: "Check Grammar", palette: true, sections: [] },
    { id: "toggleStyleCheck", title: "Check Style", palette: true, sections: [] },
    // A single toggle each for the toolbar and the TOC — the state is binary,
    // so two idempotent show/hide palette entries would always leave one that
    // does nothing. `toggleToc` (above) covers TOC visibility; these cover the
    // toolbar and the TOC dock side (mirroring the panel's own flip button).
    { id: "toggleToolbar", title: "Toggle Toolbar", palette: true, sections: [] },
    { id: "swapTocSide", title: "Swap Table of Contents Side", palette: true, sections: [] },
    // Keyboard canon (VS Code text-editing parity). Duplicate/smart-select/
    // insert-paragraph default chords are hardcoded ProseMirror keymaps —
    // they collide with native contenteditable behavior and need synchronous
    // default-suppression (see webview/keyboardShortcuts.ts); these palette
    // entries expose the same actions, and users can bind ADDITIONAL chords.
    { id: "duplicateBlockUp", title: "Duplicate Block Up", palette: true, sections: [] },
    { id: "duplicateBlockDown", title: "Duplicate Block Down", palette: true, sections: [] },
    // Move Block Up/Down: palette entries for a HARDCODED chord (Alt+Arrow),
    // exactly like Duplicate above. Alt+Arrow can't be a contributed default
    // keybinding — on macOS Option+Arrow's native caret-nav default must be
    // suppressed synchronously in the webview, which a contributed command
    // (async round-trip) can't do. These entries give discovery + a target for
    // additional user bindings; the default chord lives in blockKeys.ts.
    { id: "moveBlockUp", title: "Move Block Up", palette: true, sections: [] },
    { id: "moveBlockDown", title: "Move Block Down", palette: true, sections: [] },
    { id: "deleteBlock", title: "Delete Block", palette: true, sections: [] },
    // Contributed Ctrl+J on macOS only — VS Code parity (unbound elsewhere).
    { id: "joinLines", title: "Join Lines", palette: true, sections: [] },
    // Palette-only, like the built-in editor's transform commands.
    { id: "transformToUppercase", title: "Transform to Uppercase", palette: true, sections: [] },
    { id: "transformToLowercase", title: "Transform to Lowercase", palette: true, sections: [] },
    { id: "transformToTitleCase", title: "Transform to Title Case", palette: true, sections: [] },
    { id: "expandSelection", title: "Expand Selection", palette: true, sections: [] },
    { id: "shrinkSelection", title: "Shrink Selection", palette: true, sections: [] },
    { id: "insertParagraphAfter", title: "Insert Paragraph Below", palette: true, sections: [] },
    { id: "insertParagraphBefore", title: "Insert Paragraph Above", palette: true, sections: [] },
    // Keyboard sequence 3: the gutter block menu opened from the caret's
    // block. `openShortcutsHelp` (the sequence's read-only cheatsheet
    // overlay, declared in the toolbar group above) is deliberately distinct
    // from `openKeyboardShortcuts`, which opens VS Code's native Keyboard
    // Shortcuts UI and remains the customize/rebind path.
    { id: "openBlockMenu", title: "Open Block Menu", palette: true, sections: [] },
    // Fold grammar (MAR-110): fold/unfold act on the innermost foldable
    // block containing the caret (heading section or callout), mirroring the
    // built-in editor's Cmd+Option+[ / ] defaults. Fold All / Unfold All are
    // palette + block-menu only: VS Code's Cmd+K fold chords are unavailable
    // here because Cmd+K is bound to insertLink in this editor.
    { id: "fold", title: "Fold", palette: true, sections: [] },
    { id: "unfold", title: "Unfold", palette: true, sections: [] },
    { id: "foldAll", title: "Fold All", palette: true, sections: [] },
    { id: "unfoldAll", title: "Unfold All", palette: true, sections: [] },
] as const satisfies readonly EditorCommandMeta[];

/**
 * Title template for the open-settings entry. The row label names the product
 * (there is no group header in the gear menu): the webview expands {product}
 * with the runtime product name via settingsMenuTitle(), while the command
 * table and package.nls.json carry the package.json displayName expansion —
 * a drift test keeps all three in lockstep.
 */
export const SETTINGS_TITLE_TEMPLATE = "{product} Settings";

/** The settings row label for a given product name. */
export function settingsMenuTitle(product: string): string {
    return SETTINGS_TITLE_TEMPLATE.replace("{product}", product);
}

/**
 * The toolbar-chrome menu entries, in display order (right-click and gear
 * menu). Widened to the interface type (keeping the id union) so `menuGroup`
 * — absent from most entries' literal types — is uniformly readable.
 */
export const TOOLBAR_MENU_COMMANDS: readonly (EditorCommandMeta & { id: EditorCommandId })[] =
    EDITOR_COMMANDS.filter((m) => (m.sections as readonly WebviewSection[]).includes("toolbar"));

export type EditorCommandId = typeof EDITOR_COMMANDS[number]["id"];

/** Prefix all contributed VS Code command names share. */
export const EDITOR_COMMAND_PREFIX = "birta.editor.";

/** The full VS Code command name for a bare editor-command id. */
export function editorCommandName(id: EditorCommandId): string {
    return EDITOR_COMMAND_PREFIX + id;
}
