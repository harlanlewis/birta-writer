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

export type WebviewSection = "editor" | "table" | "link";

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
    { id: "openFind", title: "Find", palette: true, sections: [] },
    { id: "openFindReplace", title: "Replace", palette: true, sections: [] },
    { id: "toggleToc", title: "Toggle Table of Contents", palette: true, sections: [] },
    { id: "editFrontmatter", title: "Edit Frontmatter", palette: true, sections: [] },
    { id: "tableInsertRowAbove", title: "Insert Row Above", palette: false, sections: ["table"] },
    { id: "tableInsertRowBelow", title: "Insert Row Below", palette: false, sections: ["table"] },
    { id: "tableInsertColumnLeft", title: "Insert Column Left", palette: false, sections: ["table"] },
    { id: "tableInsertColumnRight", title: "Insert Column Right", palette: false, sections: ["table"] },
    { id: "tableDeleteRow", title: "Delete Row", palette: false, sections: ["table"] },
    { id: "tableDeleteColumn", title: "Delete Column", palette: false, sections: ["table"] },
    { id: "copyAsHtml", title: "Copy as HTML", palette: false, sections: ["editor"] },
    { id: "copyAsMarkdown", title: "Copy as Markdown", palette: false, sections: ["editor"] },
] as const satisfies readonly EditorCommandMeta[];

export type EditorCommandId = typeof EDITOR_COMMANDS[number]["id"];

/** Prefix all contributed VS Code command names share. */
export const EDITOR_COMMAND_PREFIX = "markdownWysiwyg.editor.";

/** The full VS Code command name for a bare editor-command id. */
export function editorCommandName(id: EditorCommandId): string {
    return EDITOR_COMMAND_PREFIX + id;
}
