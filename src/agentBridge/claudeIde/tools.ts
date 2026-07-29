/**
 * src/agentBridge/claudeIde/tools.ts
 *
 * The IDE endpoint's tool set, built over an injected `IdeHost` so the tool
 * semantics are unit-testable without `vscode`. Tool names, input schemas, and
 * payload shapes are copied from the official Anthropic IDE server's live
 * `tools/list` / `tools/call` responses (v2.1.220) — the `claude` CLI is the
 * consumer, and it gets exactly the dialect it already speaks.
 *
 * Deliberately a subset: the pull tools (selection, editors, workspace,
 * open/save/dirty/diagnostics). The edit-review surfaces (`openDiff`,
 * `close_tab`, `closeAllDiffTabs`) and Jupyter's `executeCode` are not
 * implemented — a tool absent from `tools/list` degrades gracefully in the
 * CLI (it simply doesn't offer the flow), and those belong with the push
 * (`selection_changed`) increment, not the pull one.
 */

import type { McpTool } from "./protocol";

/** The selection payload the CLI expects (0-indexed, VS Code convention). */
export interface IdeSelectionPayload {
    text: string;
    filePath: string;
    fileUrl: string;
    selection: {
        start: { line: number; character: number };
        end: { line: number; character: number };
        isEmpty: boolean;
    };
}

/** One entry of getOpenEditors' `tabs`, as the official server shapes it. */
export interface IdeTabPayload {
    uri: string;
    isActive: boolean;
    isPinned: boolean;
    isPreview: boolean;
    isDirty: boolean;
    label: string;
    groupIndex: number;
    viewColumn: number;
    isGroupActive: boolean;
    fileName: string;
    languageId: string;
    lineCount?: number;
    isUntitled: boolean;
}

export interface IdeWorkspaceFolderPayload {
    name: string;
    uri: string;
    path: string;
    index: number;
}

export interface IdeDiagnosticsEntry {
    uri: string;
    diagnostics: unknown[];
}

export interface OpenFileArgs {
    filePath: string;
    preview: boolean;
    startText?: string;
    endText?: string;
    selectToEndOfLine: boolean;
    makeFrontmost: boolean;
}

/**
 * What the endpoint needs from the editor side. Implemented over `vscode` in
 * vscodeHost.ts; faked wholesale in tests.
 */
export interface IdeHost {
    /** The active Birta editor's live selection, or null when none is active. */
    getSelection(): Promise<IdeSelectionPayload | null>;
    listOpenEditors(): IdeTabPayload[];
    workspaceFolders(): { folders: IdeWorkspaceFolderPayload[]; rootPath: string | null };
    openFile(args: OpenFileArgs): Promise<{ success: boolean; message: string }>;
    /** null when the document is not open (matching the official failure path). */
    documentDirty(filePath: string): { isDirty: boolean; isUntitled: boolean } | null;
    saveDocument(filePath: string): Promise<{ success: boolean; message: string }>;
    diagnostics(uri?: string): IdeDiagnosticsEntry[];
}

const NO_ARGS_SCHEMA = { type: "object", properties: {} } as const;

/**
 * Resolve openFile's `startText`/`endText` patterns against the document text
 * into a 0-indexed range, per the official tool's semantics: the selection
 * runs from the start of the first `startText` match to the end of the first
 * `endText` match at-or-after it (or the end of the `startText` match itself
 * when `endText` is absent/unmatched); `selectToEndOfLine` extends the end to
 * its line end. Null when `startText` is absent or not found — the file still
 * opens, nothing is selected.
 */
export function resolveTextSelection(
    text: string,
    args: Pick<OpenFileArgs, "startText" | "endText" | "selectToEndOfLine">,
): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
    if (!args.startText) { return null; }
    const startOffset = text.indexOf(args.startText);
    if (startOffset === -1) { return null; }
    let endOffset = startOffset + args.startText.length;
    if (args.endText) {
        const endMatch = text.indexOf(args.endText, startOffset);
        if (endMatch !== -1) { endOffset = endMatch + args.endText.length; }
    }
    if (args.selectToEndOfLine) {
        const nextNewline = text.indexOf("\n", endOffset);
        endOffset = nextNewline === -1 ? text.length : nextNewline;
    }
    const toPosition = (offset: number): { line: number; character: number } => {
        const before = text.slice(0, offset);
        const line = (before.match(/\n/g) ?? []).length;
        return { line, character: offset - (before.lastIndexOf("\n") + 1) };
    };
    return { start: toPosition(startOffset), end: toPosition(endOffset) };
}

/**
 * Build the endpoint's tools. `getLatestSelection` caches the last non-null
 * selection any pull observed, mirroring the official server's semantics: the
 * CLI asks it for "what was selected even if focus moved on".
 */
export function buildIdeTools(host: IdeHost): McpTool[] {
    let latestSelection: IdeSelectionPayload | null = null;

    const pullSelection = async (): Promise<IdeSelectionPayload | null> => {
        const current = await host.getSelection();
        if (current) { latestSelection = current; }
        return current;
    };

    return [
        {
            name: "getCurrentSelection",
            description: "Get the current text selection in the active editor",
            inputSchema: NO_ARGS_SCHEMA,
            run: async () => {
                const current = await pullSelection();
                return current
                    ? { success: true, ...current }
                    : { success: false, message: "No active editor found" };
            },
        },
        {
            name: "getLatestSelection",
            description: "Get the most recent text selection (even if not in the active editor)",
            inputSchema: NO_ARGS_SCHEMA,
            run: async () => {
                const current = await pullSelection();
                const answer = current ?? latestSelection;
                // Deliberately NO `success: true` wrapper on the happy path —
                // the official server answers this tool with the bare payload
                // (observed live, v2.1.220), unlike getCurrentSelection.
                return answer ?? { success: false, message: "No selection available" };
            },
        },
        {
            name: "getOpenEditors",
            description: "Get information about currently open editors",
            inputSchema: NO_ARGS_SCHEMA,
            run: async () => ({ tabs: host.listOpenEditors() }),
        },
        {
            name: "getWorkspaceFolders",
            description: "Get all workspace folders currently open in the IDE",
            inputSchema: NO_ARGS_SCHEMA,
            run: async () => {
                const { folders, rootPath } = host.workspaceFolders();
                return { success: true, folders, rootPath, workspaceFile: null };
            },
        },
        {
            name: "openFile",
            description: "Open a file in the editor and optionally select a range of text",
            inputSchema: {
                type: "object",
                properties: {
                    filePath: { type: "string", description: "Path to the file to open" },
                    preview: {
                        type: "boolean",
                        description: "Whether to open the file in preview mode",
                        default: false,
                    },
                    startText: {
                        type: "string",
                        description:
                            "Text pattern to find the start of the selection range. Selects from the beginning of this match.",
                    },
                    endText: {
                        type: "string",
                        description:
                            "Text pattern to find the end of the selection range. Selects up to the end of this match. If not provided, only the startText match will be selected.",
                    },
                    selectToEndOfLine: {
                        type: "boolean",
                        description:
                            "If true, selection will extend to the end of the line containing the endText match.",
                        default: false,
                    },
                    makeFrontmost: {
                        type: "boolean",
                        description:
                            "Whether to make the file the active editor tab. If false, the file will be opened in the background without changing focus.",
                        default: true,
                    },
                },
                required: ["filePath"],
            },
            run: async (args) => {
                const filePath = typeof args.filePath === "string" ? args.filePath : "";
                if (!filePath) { return { success: false, message: "filePath is required" }; }
                return host.openFile({
                    filePath,
                    preview: args.preview === true,
                    startText: typeof args.startText === "string" ? args.startText : undefined,
                    endText: typeof args.endText === "string" ? args.endText : undefined,
                    selectToEndOfLine: args.selectToEndOfLine === true,
                    makeFrontmost: args.makeFrontmost !== false,
                });
            },
        },
        {
            name: "checkDocumentDirty",
            description: "Check if a document has unsaved changes (is dirty)",
            inputSchema: {
                type: "object",
                properties: {
                    filePath: { type: "string", description: "Path to the file to check" },
                },
                required: ["filePath"],
            },
            run: async (args) => {
                const filePath = typeof args.filePath === "string" ? args.filePath : "";
                const state = host.documentDirty(filePath);
                return state
                    ? { success: true, filePath, ...state }
                    : { success: false, message: `Document not open: ${filePath}` };
            },
        },
        {
            name: "saveDocument",
            description: "Save a document with unsaved changes",
            inputSchema: {
                type: "object",
                properties: {
                    filePath: { type: "string", description: "Path to the file to save" },
                },
                required: ["filePath"],
            },
            run: async (args) => {
                const filePath = typeof args.filePath === "string" ? args.filePath : "";
                if (!filePath) { return { success: false, message: "filePath is required" }; }
                return host.saveDocument(filePath);
            },
        },
        {
            name: "getDiagnostics",
            description: "Get language diagnostics from VS Code",
            inputSchema: {
                type: "object",
                properties: {
                    uri: {
                        type: "string",
                        description:
                            "Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files.",
                    },
                },
            },
            run: async (args) =>
                host.diagnostics(typeof args.uri === "string" ? args.uri : undefined),
        },
    ];
}
