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
 * Each contributed VS Code command is `markdownWysiwyg.editor.<id>`; the
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
    // order) under a product-name group header, so the two menus can never
    // diverge. Hide/Show are separate idempotent commands rather than one
    // toggle so every surface shows the label that matches its state: the
    // visible bar (and gear menu) offers "Hide Toolbar", while the collapsed
    // expand tab — stamped with its own "toolbarTab" section — offers only
    // "Show Toolbar".
    { id: "customizeToolbar", title: "Customize Toolbar", palette: true, sections: ["toolbar"] },
    // Hide/Show are per-surface labels for the right-click and gear menus (each
    // shows the one that matches its state); the palette and slash menu use the
    // single `toggleToolbar` below instead, so they are palette:false here.
    { id: "hideToolbar", title: "Hide Toolbar", palette: false, sections: ["toolbar"] },
    { id: "openKeyboardShortcuts", title: "Keyboard Shortcuts", palette: false, sections: ["toolbar"] },
    { id: "openExtensionSettings", title: "Settings", palette: false, sections: ["toolbar"] },
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
    // block, heading-section folding, and the shortcuts-help overlay.
    // `openShortcutsHelp` (a read-only cheatsheet overlay) is deliberately
    // distinct from `openKeyboardShortcuts` above, which opens VS Code's
    // native Keyboard Shortcuts UI and remains the customize/rebind path.
    { id: "openBlockMenu", title: "Open Block Menu", palette: true, sections: [] },
    { id: "foldSection", title: "Fold Section", palette: true, sections: [] },
    { id: "unfoldSection", title: "Unfold Section", palette: true, sections: [] },
    { id: "foldAllSections", title: "Fold All Sections", palette: true, sections: [] },
    { id: "unfoldAllSections", title: "Unfold All Sections", palette: true, sections: [] },
    { id: "openShortcutsHelp", title: "Keyboard Shortcuts Help", palette: true, sections: [] },
] as const satisfies readonly EditorCommandMeta[];

/**
 * Title template for the open-settings entry. The gear menu names the product
 * in its group header instead of the row label, so the template is the bare
 * word; a drift test keeps it in lockstep with package.json/nls.
 */
export const SETTINGS_TITLE_TEMPLATE = "Settings";

/** The toolbar-chrome menu entries, in display order (right-click and gear menu). */
export const TOOLBAR_MENU_COMMANDS = EDITOR_COMMANDS.filter((m) =>
    (m.sections as readonly WebviewSection[]).includes("toolbar"),
);

export type EditorCommandId = typeof EDITOR_COMMANDS[number]["id"];

/** Prefix all contributed VS Code command names share. */
export const EDITOR_COMMAND_PREFIX = "markdownWysiwyg.editor.";

/** The full VS Code command name for a bare editor-command id. */
export function editorCommandName(id: EditorCommandId): string {
    return EDITOR_COMMAND_PREFIX + id;
}
