/**
 * Minimal usable mock of the VS Code API for Vitest unit tests.
 * Wired in via vitest.config.ts's resolve.alias, which redirects "vscode" to this file.
 * Note: `Uri` delegates to the real `vscode-uri` package (the same implementation the VS Code
 * API exposes), so URI parsing/joining is exercised for real rather than faked.
 */
import { vi } from "vitest";
import { URI, Utils } from "vscode-uri";

// vscode-uri IS the exact URI implementation the VS Code API exposes as `vscode.Uri`,
// so tests exercise real parsing/joining/fsPath semantics instead of a hand-rolled fake.
export const Uri = {
    file: (p: string) => URI.file(p),
    parse: (s: string, strict?: boolean) => URI.parse(s, strict),
    joinPath: (base: URI, ...parts: string[]) => Utils.joinPath(base, ...parts),
};

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

/**
 * Mirrors vscode.RelativePattern: accepts a base Uri, WorkspaceFolder, or path string
 * plus a glob pattern relative to that base.
 */
export class RelativePattern {
    readonly baseUri: URI | undefined;
    readonly base: string;
    readonly pattern: string;

    constructor(base: URI | { uri: URI } | string, pattern: string) {
        if (typeof base === "string") {
            this.base = base;
        } else if ("uri" in base) {
            this.baseUri = base.uri;
            this.base = base.uri.fsPath;
        } else {
            this.baseUri = base;
            this.base = base.fsPath;
        }
        this.pattern = pattern;
    }
}

/** Creates a fake FileSystemWatcher; tests can override via mockImplementation to capture handlers */
const makeFakeFileSystemWatcher = () => ({
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
});

/** Mirrors vscode.Position (immutable line/character pair; only what the code under test uses) */
export class Position {
    constructor(
        public readonly line: number,
        public readonly character: number,
    ) {}

    isEqual(other: Position): boolean {
        return this.line === other.line && this.character === other.character;
    }
}

/** Mirrors vscode.Range; accepts (start, end) or (startLine, startChar, endLine, endChar) */
export class Range {
    public readonly start: Position;
    public readonly end: Position;

    constructor(start: Position, end: Position);
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
    constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
        if (typeof a === "number") {
            this.start = new Position(a, b as number);
            this.end = new Position(c as number, d as number);
        } else {
            this.start = a;
            this.end = b as Position;
        }
    }
}

export interface RecordedReplacement {
    uri: URI;
    range: Range;
    newText: string;
}

/** Mirrors vscode.WorkspaceEdit for the replace path; records every call for assertions */
export class WorkspaceEdit {
    readonly replacements: RecordedReplacement[] = [];

    replace(uri: URI, range: Range, newText: string): void {
        this.replacements.push({ uri, range, newText });
    }

    get size(): number {
        return this.replacements.length;
    }
}

export interface FakeTextDocumentChangeEvent {
    document: FakeTextDocument;
    contentChanges: Array<{
        range: Range;
        rangeOffset: number;
        rangeLength: number;
        text: string;
    }>;
    reason: undefined;
}

/** Listener list backing workspace.onDidChangeTextDocument */
const textDocumentChangeListeners: Array<(e: FakeTextDocumentChangeEvent) => void> = [];

/** Fires all registered onDidChangeTextDocument listeners (as applyEdit and external edits do) */
export function fireDidChangeTextDocument(e: FakeTextDocumentChangeEvent): void {
    for (const listener of [...textDocumentChangeListeners]) {
        listener(e);
    }
}

/** Registry of fake documents so workspace.applyEdit can route edits by uri */
const fakeTextDocuments = new Map<string, FakeTextDocument>();

/** Drops all fake documents and change listeners; call in beforeEach */
export function resetTextDocumentMocks(): void {
    fakeTextDocuments.clear();
    textDocumentChangeListeners.length = 0;
}

export interface FakeTextDocument {
    uri: URI;
    readonly version: number;
    readonly isDirty: boolean;
    languageId: string;
    getText(): string;
    offsetAt(position: Position): number;
    positionAt(offset: number): Position;
    lineAt(line: number): { lineNumber: number; text: string };
    save(): Promise<boolean>;
    /** Test helper: replace the full text as an EXTERNAL edit (fires the change event) */
    setTextExternally(newText: string): void;
    /** Test helper: mark the document saved (clears isDirty) */
    markSaved(): void;
}

/**
 * Creates a realistic in-memory vscode.TextDocument stand-in: getText /
 * offsetAt / positionAt / lineAt operate on a live string that
 * workspace.applyEdit mutates, firing onDidChangeTextDocument like the real
 * API. Registered by uri so applyEdit can find it.
 */
export function makeFakeTextDocument(
    content: string,
    uri: URI = URI.file("/project/note.md"),
): FakeTextDocument {
    let text = content;
    let version = 1;
    let dirty = false;

    const lineStarts = (): number[] => {
        const starts = [0];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === "\n") {
                starts.push(i + 1);
            }
        }
        return starts;
    };

    const doc: FakeTextDocument & {
        applyReplace(range: Range, newText: string): void;
    } = {
        uri,
        get version() {
            return version;
        },
        get isDirty() {
            return dirty;
        },
        languageId: "markdown",
        getText: () => text,
        offsetAt(position: Position): number {
            const starts = lineStarts();
            const line = Math.min(position.line, starts.length - 1);
            const lineStart = starts[line];
            const lineEnd = line + 1 < starts.length ? starts[line + 1] : text.length;
            return Math.min(lineStart + position.character, lineEnd);
        },
        positionAt(offset: number): Position {
            const clamped = Math.max(0, Math.min(offset, text.length));
            const starts = lineStarts();
            let line = 0;
            for (let i = starts.length - 1; i >= 0; i--) {
                if (starts[i] <= clamped) {
                    line = i;
                    break;
                }
            }
            return new Position(line, clamped - starts[line]);
        },
        lineAt(line: number) {
            const starts = lineStarts();
            const lineStart = starts[line] ?? text.length;
            const lineEnd = line + 1 < starts.length ? starts[line + 1] : text.length;
            return { lineNumber: line, text: text.slice(lineStart, lineEnd).replace(/\r?\n$/, "") };
        },
        save: vi.fn(async () => {
            dirty = false;
            return true;
        }),
        applyReplace(range: Range, newText: string): void {
            const startOffset = doc.offsetAt(range.start);
            const endOffset = doc.offsetAt(range.end);
            const rangeLength = endOffset - startOffset;
            text = text.slice(0, startOffset) + newText + text.slice(endOffset);
            version++;
            dirty = true;
            fireDidChangeTextDocument({
                document: doc,
                contentChanges: [{ range, rangeOffset: startOffset, rangeLength, text: newText }],
                reason: undefined,
            });
        },
        setTextExternally(newText: string): void {
            const fullRange = new Range(doc.positionAt(0), doc.positionAt(text.length));
            const rangeLength = text.length;
            text = newText;
            version++;
            fireDidChangeTextDocument({
                document: doc,
                contentChanges: [{ range: fullRange, rangeOffset: 0, rangeLength, text: newText }],
                reason: undefined,
            });
        },
        markSaved(): void {
            dirty = false;
        },
    };

    fakeTextDocuments.set(uri.toString(), doc);
    return doc;
}

export const workspace = {
    fs: {
        readFile: vi.fn<() => Promise<Uint8Array>>(),
        writeFile: vi.fn<() => Promise<void>>(),
        readDirectory: vi.fn<() => Promise<[string, number][]>>(),
        stat: vi.fn<() => Promise<{ type: number }>>(),
        createDirectory: vi.fn<() => Promise<void>>(),
        delete: vi.fn<() => Promise<void>>(),
    },
    getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
    })),
    getWorkspaceFolder: vi.fn(() => undefined as undefined | { uri: URI }),
    workspaceFolders: undefined as undefined | Array<{ uri: URI }>,
    createFileSystemWatcher: vi.fn(makeFakeFileSystemWatcher),
    findFiles: vi.fn(async (): Promise<URI[]> => []),
    onDidChangeTextDocument: vi.fn(
        (listener: (e: FakeTextDocumentChangeEvent) => void) => {
            textDocumentChangeListeners.push(listener);
            return {
                dispose: vi.fn(() => {
                    const idx = textDocumentChangeListeners.indexOf(listener);
                    if (idx >= 0) {
                        textDocumentChangeListeners.splice(idx, 1);
                    }
                }),
            };
        },
    ),
    applyEdit: vi.fn(async (edit: WorkspaceEdit): Promise<boolean> => {
        for (const { uri, range, newText } of edit.replacements) {
            const doc = fakeTextDocuments.get(uri.toString()) as
                | (FakeTextDocument & { applyReplace(range: Range, newText: string): void })
                | undefined;
            doc?.applyReplace(range, newText);
        }
        return true;
    }),
    save: vi.fn(async (uri: URI): Promise<URI | undefined> => {
        const doc = fakeTextDocuments.get(uri.toString());
        if (doc) {
            await doc.save();
        }
        return uri;
    }),
};

export const env = {
    language: "en",
    openExternal: vi.fn(),
};

/** Tab input for custom editors (instanceof-checked by command routing). */
export class TabInputCustom {
    constructor(
        public readonly uri: unknown,
        public readonly viewType: string,
    ) {}
}

export const window = {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    /**
     * Tab-group state for command routing tests. Mutate
     * `tabGroups.activeTabGroup.activeTab` to simulate the focused tab;
     * reset it to undefined between tests.
     */
    tabGroups: {
        activeTabGroup: { activeTab: undefined as { input?: unknown } | undefined },
        all: [] as unknown[],
    },
};

export const commands = {
    executeCommand: vi.fn(),
};

// No extensions installed in tests: theme discovery (themeManager.getAllThemes)
// iterates this and falls back to the auto theme when it finds nothing.
export const extensions = {
    all: [] as Array<{ id: string; extensionPath: string; packageJSON: unknown }>,
};

/** Functional EventEmitter: event() registers listeners, fire() dispatches to them */
export class EventEmitter<T> {
    private readonly _listeners: Array<(e: T) => void> = [];

    readonly event = (listener: (e: T) => void) => {
        this._listeners.push(listener);
        return {
            dispose: () => {
                const idx = this._listeners.indexOf(listener);
                if (idx >= 0) {
                    this._listeners.splice(idx, 1);
                }
            },
        };
    };

    fire(data: T): void {
        for (const listener of [...this._listeners]) {
            listener(data);
        }
    }

    dispose(): void {
        this._listeners.length = 0;
    }
}

export const l10n = {
    t: vi.fn((msg: string, ...args: unknown[]) =>
        args.reduce<string>((s, arg, i) => s.replace(`{${i}}`, String(arg)), msg)
    ),
};

export const CancellationTokenSource = vi.fn(() => ({
    token: { isCancellationRequested: false, onCancellationRequested: vi.fn() },
    cancel: vi.fn(),
    dispose: vi.fn(),
}));
