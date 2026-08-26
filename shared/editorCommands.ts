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

import type { HostArrangement, HostCapability } from "./hostProfile";

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
    /**
     * The host-provided thing this command needs (shared/hostProfile.ts):
     * a text editor to switch to, a settings UI, a proofreading engine, an
     * image store. Absent on every command the editor answers by itself. A
     * host that does not declare the capability never sees the command: not
     * on the toolbar, not in the gear or slash menus, and `runEditorCommand`
     * ignores it, so a chord bound to it is inert rather than a message to a
     * host that cannot answer.
     */
    readonly hostCapability?: HostCapability;
    /**
     * An arrangement that WITHDRAWS this command (shared/hostProfile.ts).
     * Distinct from `hostCapability`, which says the host cannot answer:
     * here the host could, and the surface has settled the question the
     * command exists to reopen. Both are read by `hostHasCommand`, so a
     * withdrawn command is absent from the toolbar, the gear, the slash menu
     * and the palette, and `runEditorCommand` ignores it, exactly as a
     * capability-gated one is.
     */
    readonly absentUnder?: HostArrangement;
}

/**
 * Adding an entry here obliges three `Record<EditorCommandId, …>` tables to
 * grow with it, each of which fails to compile until it does:
 *
 *   - `editorCommands` (webview/editorCommands.ts) — what the command DOES
 *   - `COMMAND_EFFECTS` (webview/readOnly.ts) — whether it changes the document
 *   - `COMMAND_BLOCK_REACH` (webview/blockPlacement.ts) — which blocks it can
 *     reach from the caret, so every surface offering it agrees
 *
 * Listed because the compiler reports them one at a time, several files from
 * here, and each reads as a surprise rather than as a step. Answering all three
 * is the point: each is a question about the command that a surface would
 * otherwise guess at, and the guesses are what diverged (MAR-111, MAR-115).
 * A command that does none of the three is still classified, as `none`.
 */
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
    // Ticking the task the caret is in, which the checkbox and the `[x] `
    // marker could already do with a pointer or a fresh line and neither could
    // do from inside the text.
    { id: "toggleTaskChecked", title: "Toggle Task Done", palette: true, sections: [] },
    { id: "toggleBlockquote", title: "Blockquote", palette: true, sections: [] },
    { id: "insertCodeBlock", title: "Code Block", palette: true, sections: [] },
    { id: "insertHorizontalRule", title: "Horizontal Rule", palette: true, sections: [] },
    { id: "insertTable", title: "Insert Table", palette: true, sections: [] },
    { id: "insertLink", title: "Insert/Edit Link", palette: true, sections: ["link"] },
    // In-note anchor link (MAR-176): pick a heading, insert `[text](#slug)`.
    // Palette-only (no right-click section) — the discoverable surfaces are the
    // slash menu and the floating selection toolbar's own button.
    { id: "insertSectionLink", title: "Link to Section", palette: true, sections: [] },
    // Follow the link at the caret (MAR-118): the SAME resolution the hover
    // popup's Open button and the block menu's Open Link row use — anchors
    // scroll in-document, wikilinks route through the host, external URLs
    // open in the browser, everything else opens as a workspace file. A caret
    // on no link is a quiet no-op. Palette + rebindable; no default chord
    // (Cmd+Click and the block menu already carry the common paths).
    { id: "openLink", title: "Open Link", palette: true, sections: [] },
    // Ask the user's coding agent for an edit at the caret (MAR-371, MAR-272).
    // The one command that carries an ARGUMENT: the slash menu's `/ai` row
    // captures the prompt typed after it and passes `{ prompt }`; from the
    // palette the argument is absent and the extension asks for it in an
    // input box. The webview never invokes anything: it hands the prompt to
    // the extension, which composes the caret's line reference in and routes
    // it per `birta.agent.command` (src/agentBridge/askAgent.ts).
    { id: "askAgent", title: "Ask Agent", palette: true, sections: [], hostCapability: "agent" },
    // The composer in front of the same hand-off: files, and the model and
    // effort for one request. What it may OFFER is read from the harness's
    // own `--help`, so it needs no capability of its own beyond `agent`.
    { id: "askAgentAdvanced", title: "Ask Agent (advanced)", palette: true, sections: [], hostCapability: "agent" },
    { id: "editBlockSource", title: "Edit Block as Markdown", palette: true, sections: [] },
    { id: "insertImage", title: "Insert Image", palette: true, sections: [], hostCapability: "imageUpload" },
    { id: "insertMath", title: "Insert Math", palette: true, sections: [] },
    { id: "insertFootnote", title: "Insert Footnote", palette: true, sections: [] },
    // Dates. Four ids rather than one taking an offset, for the reason the
    // seven `foldLevel*` entries give: a palette row carries no argument, so
    // an id per answer is the only shape the palette can reach. `insertDate`
    // opens a calendar; the three relative ones insert without asking, and are
    // the typed gesture (`/today`) rather than something to browse for.
    // What they insert is plain text, deliberately: a date is characters in
    // the document, not a node, so it survives serialization as exactly what
    // the user read on screen and every other tool sees the same bytes.
    { id: "insertDate", title: "Insert Date", palette: true, sections: [] },
    { id: "insertToday", title: "Insert Today's Date", palette: true, sections: [] },
    { id: "insertTomorrow", title: "Insert Tomorrow's Date", palette: true, sections: [] },
    { id: "insertYesterday", title: "Insert Yesterday's Date", palette: true, sections: [] },
    { id: "insertCallout", title: "Insert Callout", palette: true, sections: [] },
    // Toolbar Quote-dropdown semantics (menuitemcheckbox rows): same-kind
    // lifts out, different-kind retypes in place, outside wraps. Not in the
    // palette — insertCallout is the plain insert everywhere else.
    { id: "toggleCallout", title: "Toggle Callout", palette: false, sections: [] },
    // `/help` (MAR-395): the Send Feedback questions, put from inside the
    // document rather than from a palette the editor's own surfaces cannot
    // reach. Ungated, because what it needs is a host that can draw a prompt
    // and both shipped surfaces can; a host that cannot says so explicitly
    // (`hostPromptResult`'s `unsupported`) rather than going quiet.
    //
    // `birta.sendFeedback` keeps its own palette entry and its own keybinding.
    // The two are one flow drawn by one renderer, so neither is an alias of
    // the other and there is nothing to keep in step by hand.
    { id: "openHelp", title: "Help and Feedback", palette: true, sections: [] },
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
    // Cmd+F2 (and Shift+Cmd+L): seed from the selection/word and open focused
    // on the replace input with every occurrence highlighted — one keystroke
    // from Replace All.
    //
    // Titled after VS Code's `editor.action.changeAll` ("Change All
    // Occurrences", Cmd+F2), which is the intent this actually serves: change
    // every instance of what's selected. It is deliberately NOT VS Code's
    // Shift+Cmd+L (`editor.action.selectHighlights`, "Select all occurrences of
    // current selection") — that puts a cursor at every match, which a
    // single-selection editor cannot do, so borrowing its verb promised
    // something we can never deliver. Shift+Cmd+L stays bound as an additional
    // chord so existing muscle memory keeps working.
    //
    // The command ID still reads `selectAllOccurrences`: renaming it would
    // silently break any user's keybindings.json entry with no migration path,
    // and the ID is not user-facing. The title is what users see.
    { id: "selectAllOccurrences", title: "Change All Occurrences", palette: true, sections: [] },
    { id: "toggleToc", title: "Toggle Table of Contents", palette: true, sections: [], hostCapability: "toc" },
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
    // Copy as Markdown / Rich Text are palette commands too: native Cmd+C
    // already yields whichever of the two birta.copyFormat selects, so the
    // palette is how you reach the OTHER format for a one-off copy.
    // (Copy as HTML stays menu-only: it copies HTML source as text — a
    // developer affordance, not a paste-into-Word one.)
    { id: "copyAsMarkdown", title: "Copy as Markdown", palette: true, sections: ["editor", "table", "link"] },
    // Writes real rich text (an HTML clipboard flavor, written webview-side —
    // vscode.env.clipboard is text-only), so rich editors paste formatting.
    { id: "copyAsRichText", title: "Copy as Rich Text", palette: true, sections: ["editor", "table", "link"] },
    // Bottom "9_view" group of every content menu; same switch path as the
    // toolbar button (carries the first visible line to preserve the viewport).
    { id: "editRawMarkdown", title: "Edit Raw Markdown", palette: false, sections: ["editor", "table", "link"], hostCapability: "textEditor" },
    // Toolbar (chrome) right-click menu. The settings-gear dropdown is built
    // from these same entries (filtered by the "toolbar" section, in this
    // order), with a separator on every `menuGroup` change, so the two menus
    // can never diverge. Hide/Show are separate idempotent commands rather
    // than one toggle so every surface shows the label that matches its state:
    // the visible bar (and gear menu) offers "Hide Toolbar", while the
    // collapsed expand tab — stamped with its own "toolbarTab" section —
    // offers only "Show Toolbar".
    { id: "customizeToolbar", title: "Customize Toolbar", palette: true, sections: ["toolbar"], menuGroup: "layout", absentUnder: "fixedToolbarLayout" },
    // Hide/Show are per-surface labels for the right-click and gear menus (each
    // shows the one that matches its state); the palette and slash menu use the
    // single `toggleToolbar` below instead, so they are palette:false here.
    { id: "hideToolbar", title: "Hide Toolbar", palette: false, sections: ["toolbar"], menuGroup: "layout", absentUnder: "fixedToolbarLayout" },
    // Show/Edit are parallel verb-first labels for the shortcuts pair: "Show"
    // opens the read-only cheatsheet overlay (learn first), "Edit" opens
    // VS Code's native Keyboard Shortcuts UI (rebind second) — see the
    // sequence-3 comment below for why the two stay distinct commands.
    // Command ids are unchanged so existing user keybindings keep working.
    { id: "openShortcutsHelp", title: "Show Keyboard Shortcuts", palette: true, sections: ["toolbar"], menuGroup: "shortcuts" },
    { id: "openKeyboardShortcuts", title: "Edit Keyboard Shortcuts", palette: false, sections: ["toolbar"], menuGroup: "shortcuts", hostCapability: "hostSettings" },
    // The full title is the SETTINGS_TITLE_TEMPLATE expansion of PRODUCT_NAME
    // (drift-guarded); the gear menu interpolates the product name via
    // settingsMenuTitle() instead of using this literal.
    { id: "openExtensionSettings", title: "Birta Writer Settings", palette: false, sections: ["toolbar"], menuGroup: "settings", hostCapability: "hostSettings" },
    // Opens the published release history in the browser (RELEASES_URL, handed
    // to the host — the webview fetches nothing). It shares the `settings`
    // group with the row above rather than opening a fourth one: both name the
    // extension itself rather than this document or this toolbar, so a
    // separator between them would draw a distinction that isn't there.
    // Palette-visible, unlike its neighbours in the group: VS Code has its own
    // Settings and Keyboard Shortcuts commands, and no command of its own
    // reaches OUR release notes.
    { id: "openWhatsNew", title: "What's New", palette: true, sections: ["toolbar"], menuGroup: "settings", hostCapability: "hostSettings" },
    // The host application's own preferences, for a surface that IS an app
    // (Jot). Shares the `settings` group with the rows above because it names
    // the same thing they do: the program, rather than this document. The
    // title is the SETTINGS_TITLE_TEMPLATE expansion of JOT_PRODUCT_NAME, the
    // way the row above expands PRODUCT_NAME, and is drift-guarded against the
    // nls string and Jot's own NSWindow title.
    { id: "openHostPreferences", title: "Birta Writer Settings", palette: false, sections: ["toolbar"], menuGroup: "settings", hostCapability: "appPreferences" },
    { id: "showToolbar", title: "Show Toolbar", palette: false, sections: ["toolbarTab"], absentUnder: "fixedToolbarLayout" },
    // View controls — the font picker, size stepper, proofread toggles, and TOC
    // side/visibility. Previously reachable only from the toolbar (and, for a
    // few, the slash menu's bespoke action dispatch); contributed here so the
    // command palette — the standard surface for editor-chrome actions — can
    // reach them too. Each preset/direction is its own id because a palette
    // entry carries no argument.
    // The reading measure, offered only where the host's editor area is wide
    // enough for it to be a choice (see `contentMeasure`).
    { id: "contentWidthFull", title: "Full Width", palette: true, sections: [], hostCapability: "contentMeasure" },
    { id: "contentWidthFixed", title: "Fixed Width", palette: true, sections: [], hostCapability: "contentMeasure" },
    { id: "fontEditor", title: "Editor Font", palette: true, sections: [], hostCapability: "editorFont" },
    { id: "fontSans", title: "Sans-Serif Font", palette: true, sections: [] },
    { id: "fontSerif", title: "Serif Font", palette: true, sections: [] },
    { id: "fontMono", title: "Monospace Font", palette: true, sections: [] },
    { id: "increaseFontSize", title: "Increase Font Size", palette: true, sections: [] },
    { id: "decreaseFontSize", title: "Decrease Font Size", palette: true, sections: [] },
    // The third of the zoom trio, and the one a stepper alone cannot give: a
    // way back. Named for what the reader sees rather than for the number it
    // writes, which is the vocabulary every macOS View menu uses.
    { id: "resetFontSize", title: "Actual Size", palette: true, sections: [] },
    { id: "toggleSpellCheck", title: "Check Spelling", palette: true, sections: [], hostCapability: "spellAndGrammar" },
    { id: "toggleGrammarCheck", title: "Check Grammar", palette: true, sections: [], hostCapability: "spellAndGrammar" },
    // Not gated, and its two neighbours are: style check is computed in the
    // page from a table the bundle carries, so it works wherever the editor
    // does. It was gated with them until a host with no lint engine turned out
    // to be losing a check it could have run.
    { id: "toggleStyleCheck", title: "Check Style", palette: true, sections: [] },
    // The in-text editor-note highlight (birta.notes.highlightMarkers). It sits
    // beside the three check toggles because it is the same kind of thing — an
    // advisory in-text annotation the user turns on and off — even though the
    // proofreading master gate does not govern it.
    // Titled after the markers, not the notes: "Highlight" alone is already the
    // `==mark==` command two rows up, and a palette search for "highlight" must
    // not offer two entries that read the same.
    { id: "toggleNoteHighlights", title: "Highlight Note Markers", palette: true, sections: [] },
    // A single toggle each for the toolbar and the TOC — the state is binary,
    // so two idempotent show/hide palette entries would always leave one that
    // does nothing. `toggleToc` (above) covers TOC visibility; these cover the
    // toolbar and the TOC dock side (mirroring the panel's own flip button).
    { id: "toggleToolbar", title: "Toggle Toolbar", palette: true, sections: [], absentUnder: "fixedToolbarLayout" },
    // Edit / Read-only (MAR-53). A single toggle, like the toolbar and TOC
    // entries above and for the same reason: the state is binary, so two
    // idempotent palette rows would always leave one that does nothing. It
    // overrides `birta.readOnly` for the session; changing the setting itself
    // re-seeds every open document. No default chord — the editor's own chords
    // are spoken for, and a user picks one in the Keyboard Shortcuts UI.
    { id: "toggleReadOnly", title: "Toggle Read-only", palette: true, sections: [], hostCapability: "readOnlyMode" },
    { id: "swapTocSide", title: "Swap Table of Contents Side", palette: true, sections: [], hostCapability: "toc" },
    // MAR-294: once focus is inside the review sidebar its keyboard model is
    // complete (Escape returns to the editor from every region), but no gesture
    // moved focus there in the first place — Tab is the editor's indent key and
    // cannot be repurposed. This is the deliberate inbound gesture, mirroring
    // VS Code's own workbench.action.focusSideBar: palette + rebindable, and it
    // opens the panel when hidden. No default chord — the editor's own chords
    // are spoken for, and a user picks one in the Keyboard Shortcuts UI.
    { id: "focusReviewSidebar", title: "Focus Review Sidebar", palette: true, sections: [], hostCapability: "toc" },
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
    // Refile (MAR-118): move a block INTO the previous sibling container /
    // lift it OUT of its enclosing one — the keyboard path to drag-refile.
    // Contributed (not hardcoded) because Cmd+]/[ carries no native
    // contenteditable default needing synchronous suppression; the chords
    // mirror VS Code's own indent/outdentLines defaults, inert here because
    // they are editorTextFocus-scoped. On list items the commands delegate to
    // the Tab machinery, so ⌘] and Tab can never diverge.
    { id: "indentBlock", title: "Indent Block", palette: true, sections: [] },
    { id: "outdentBlock", title: "Outdent Block", palette: true, sections: [] },
    { id: "deleteBlock", title: "Delete Block", palette: true, sections: [] },
    // Contributed Ctrl+J on macOS only — VS Code parity (unbound elsewhere).
    { id: "joinLines", title: "Join Lines", palette: true, sections: [] },
    // Shift+Cmd+V. Contributed as a real command rather than left to the
    // browser: VS Code does not deliver a native paste event to the webview for
    // that chord, so ProseMirror's own plain-paste modifier never fired inside
    // the editor even though it works in a plain browser (MAR-276).
    { id: "pasteAsPlainText", title: "Paste as Plain Text", palette: true, sections: [] },
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
    // Fold every region at one nesting level (MAR-116), mirroring VS Code's
    // editor.foldLevel1..7. "Level" is containment depth in the fold tree, not
    // a heading's own rank — a top-level code block or table has no rank, and
    // the argument for the choice lives on foldModel's foldLevels. Palette
    // only, with no default chord: VS Code's own Cmd+K Cmd+N chords are two-
    // stroke sequences this editor cannot claim, and seven bindings would be a
    // large unrequested claim on the user's keymap. All seven are rebindable
    // through the workbench like any contributed command.
    { id: "foldLevel1", title: "Fold Level 1", palette: true, sections: [] },
    { id: "foldLevel2", title: "Fold Level 2", palette: true, sections: [] },
    { id: "foldLevel3", title: "Fold Level 3", palette: true, sections: [] },
    { id: "foldLevel4", title: "Fold Level 4", palette: true, sections: [] },
    { id: "foldLevel5", title: "Fold Level 5", palette: true, sections: [] },
    { id: "foldLevel6", title: "Fold Level 6", palette: true, sections: [] },
    { id: "foldLevel7", title: "Fold Level 7", palette: true, sections: [] },
    // Clear every checked box in the task list containing the caret, in one
    // undo step — resets a reusable checklist. Palette-only (also offered on the
    // block menu of a task list); no default chord.
    { id: "uncheckAllTasks", title: "Uncheck All Tasks", palette: true, sections: [] },
    // Export as HTML (MAR-32): the rendered document as one self-contained
    // file. Offered wherever the copy-as commands are (palette, and the
    // right-click menu of every content section, in its own group below the
    // copy group), because it is the same gesture writ large: the whole
    // document instead of the selection, to a file instead of the clipboard.
    // No PDF sibling: a webview has no print API, so the honest PDF path is
    // the browser's print-to-PDF on the exported file (src/htmlExport.ts).
    { id: "exportHtml", title: "Export as HTML", palette: true, sections: ["editor", "table", "link"] },
] as const satisfies readonly EditorCommandMeta[];

/**
 * Title template for the open-settings entry. The row label names the product
 * (there is no group header in the gear menu): the webview expands {product}
 * with PRODUCT_NAME via settingsMenuTitle(), while the command table and
 * package.nls.json carry that same expansion, and a drift test keeps all three
 * in lockstep.
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
