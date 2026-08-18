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

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

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

    /** Mirrors vscode.Range#isEmpty: true when start and end coincide. */
    get isEmpty(): boolean {
        return this.start.line === this.end.line && this.start.character === this.end.character;
    }
}

/** Mirrors vscode.Selection (anchor→active order preserved, like the real one) */
export class Selection extends Range {
    public readonly anchor: Position;
    public readonly active: Position;

    constructor(anchor: Position, active: Position) {
        const reversed =
            active.line < anchor.line ||
            (active.line === anchor.line && active.character < anchor.character);
        super(reversed ? active : anchor, reversed ? anchor : active);
        this.anchor = anchor;
        this.active = active;
    }
}

/** Mirrors vscode.TextEditorSelectionChangeKind (values match the real enum) */
export enum TextEditorSelectionChangeKind {
    Keyboard = 1,
    Mouse = 2,
    Command = 3,
}

/** Mirrors vscode.TextEditorRevealType (values match the real enum) */
export enum TextEditorRevealType {
    Default = 0,
    InCenter = 1,
    InCenterIfOutsideViewport = 2,
    AtTop = 3,
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

/** Mirrors vscode.TextEdit (used by the onWillSaveTextDocument flush path). */
export class TextEdit {
    constructor(public range: Range, public newText: string) {}
    static replace(range: Range, newText: string): TextEdit {
        return new TextEdit(range, newText);
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

/** Listener list backing workspace.onDidSaveTextDocument */
const textDocumentSaveListeners: Array<(doc: FakeTextDocument) => void> = [];

/** Fires all registered onDidSaveTextDocument listeners (call after doc.markSaved()) */
export function fireDidSaveTextDocument(doc: FakeTextDocument): void {
    for (const listener of [...textDocumentSaveListeners]) {
        listener(doc);
    }
}

/** Listener list backing workspace.onDidCloseTextDocument */
const textDocumentCloseListeners: Array<(doc: FakeTextDocument) => void> = [];

/** Fires all registered onDidCloseTextDocument listeners (VS Code closing a document). */
export function fireDidCloseTextDocument(doc: FakeTextDocument): void {
    for (const listener of [...textDocumentCloseListeners]) {
        listener(doc);
    }
}

/** Registry of fake documents so workspace.applyEdit can route edits by uri */
const fakeTextDocuments = new Map<string, FakeTextDocument>();

/** Listener list backing workspace.onWillSaveTextDocument */
export interface FakeWillSaveEvent {
    document: FakeTextDocument;
    reason: number;
    waitUntil(thenable: Promise<unknown>): void;
}
const willSaveTextDocumentListeners: Array<(e: FakeWillSaveEvent) => void> = [];

/**
 * Drives the onWillSaveTextDocument participants like a real save: each listener
 * may call waitUntil(promise); this awaits them all and returns the collected
 * results (TextEdit[] arrays) so a test can assert what a save would write.
 */
export async function fireWillSaveTextDocument(
    document: FakeTextDocument,
    reason = 1,
): Promise<unknown[]> {
    const waited: Array<Promise<unknown>> = [];
    const e: FakeWillSaveEvent = {
        document,
        reason,
        waitUntil: (thenable) => { waited.push(Promise.resolve(thenable)); },
    };
    for (const listener of [...willSaveTextDocumentListeners]) { listener(e); }
    return Promise.all(waited);
}

/** Drops all fake documents and change/will-save listeners; call in beforeEach */
export function resetTextDocumentMocks(): void {
    fakeTextDocuments.clear();
    textDocumentChangeListeners.length = 0;
    willSaveTextDocumentListeners.length = 0;
    textDocumentSaveListeners.length = 0;
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
    readonly lineCount: number;
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
        get lineCount() {
            return lineStarts().length;
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
        inspect: vi.fn(() => undefined),
        update: vi.fn(async (_key: string, _value: unknown, _target?: unknown) => undefined),
    })),
    getWorkspaceFolder: vi.fn(() => undefined as undefined | { uri: URI }),
    /** Workspace-relative path: strips the leading slash of an absolute fsPath (no folder model here). */
    asRelativePath: vi.fn((pathOrUri: URI | string, _includeWorkspaceFolder?: boolean) =>
        (typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath).replace(/^\//, ""),
    ),
    workspaceFolders: undefined as undefined | Array<{ uri: URI }>,
    /** Resolves to the registered fake document; rejects for unknown URIs (like the real API on a missing file). */
    openTextDocument: vi.fn(async (uri: URI) => {
        const doc = fakeTextDocuments.get(uri.toString());
        if (!doc) throw new Error(`openTextDocument: no fake document for ${uri.toString()}`);
        return doc;
    }),
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
    onDidCloseTextDocument: vi.fn(
        (listener: (doc: FakeTextDocument) => void) => {
            textDocumentCloseListeners.push(listener);
            return {
                dispose: vi.fn(() => {
                    const idx = textDocumentCloseListeners.indexOf(listener);
                    if (idx >= 0) {
                        textDocumentCloseListeners.splice(idx, 1);
                    }
                }),
            };
        },
    ),
    onWillSaveTextDocument: vi.fn(
        (listener: (e: FakeWillSaveEvent) => void) => {
            willSaveTextDocumentListeners.push(listener);
            return {
                dispose: vi.fn(() => {
                    const idx = willSaveTextDocumentListeners.indexOf(listener);
                    if (idx >= 0) {
                        willSaveTextDocumentListeners.splice(idx, 1);
                    }
                }),
            };
        },
    ),
    onDidSaveTextDocument: vi.fn(
        (listener: (doc: FakeTextDocument) => void) => {
            textDocumentSaveListeners.push(listener);
            return {
                dispose: vi.fn(() => {
                    const idx = textDocumentSaveListeners.indexOf(listener);
                    if (idx >= 0) {
                        textDocumentSaveListeners.splice(idx, 1);
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
    // Resolves `true` by default because the real API resolves a boolean and
    // callers branch on it — a bare `vi.fn()` returns undefined, which reads
    // as "the browser refused to open" and would send every test down the
    // failure path. `vi.clearAllMocks()` keeps the implementation.
    openExternal: vi.fn().mockResolvedValue(true),
    /**
     * Clipboard writes (the feedback command's always-available channel), and
     * reads — the Paste as Plain Text command's payload, since a webview is not
     * granted the permission `navigator.clipboard.readText()` needs.
     */
    clipboard: {
        writeText: vi.fn(async () => undefined),
        readText: vi.fn(async () => ""),
    },
};

/**
 * The built-in authentication providers (`vscode.authentication`), which the
 * `builtin` connector strategy uses for GitHub. Resolves `undefined` by
 * default — no session — because that is the state a fresh machine is in, and
 * a test that wants a session says so explicitly.
 */
export const authentication = {
    getSession: vi.fn(async (): Promise<{ accessToken: string } | undefined> => undefined),
};

/** Host version string, as `vscode.version` reports it. */
export const version = "1.99.0";

/** Tab input for custom editors (instanceof-checked by command routing). */
export class TabInputCustom {
    constructor(
        public readonly uri: unknown,
        public readonly viewType: string,
    ) {}
}

/** Tab input for a plain text editor (instanceof-checked alongside the above). */
export class TabInputText {
    constructor(public readonly uri: unknown) {}
}

/**
 * Minimal createQuickPick fake: records assigned items/activeItems and lets a
 * test fire the accept/hide handlers via `qp.onDidAccept.mock.calls[0][0]()`.
 * Grab the instance from `window.createQuickPick.mock.results[n].value`.
 */
function makeFakeQuickPick() {
    return {
        items: [] as unknown[],
        activeItems: [] as unknown[],
        selectedItems: [] as unknown[],
        title: "",
        placeholder: "",
        matchOnDescription: false,
        onDidAccept: vi.fn(() => ({ dispose: vi.fn() })),
        onDidHide: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeActive: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeValue: vi.fn(() => ({ dispose: vi.fn() })),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    };
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

/**
 * Minimal createStatusBarItem fake (MAR-29): records text/tooltip/name and
 * show/hide/dispose calls so a test can assert what the word-count readout
 * rendered. Grab the instance via `window.createStatusBarItem.mock.results[0].value`.
 */
function makeFakeStatusBarItem() {
    return {
        id: "",
        alignment: 0,
        priority: 0,
        text: "",
        name: "",
        tooltip: "" as string | undefined,
        command: undefined as unknown,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    };
}

export const window = {
    /**
     * Opening a document in the raw text editor. The mode switch passes its
     * `TextDocumentShowOptions` here, so a test can read back the selection the
     * switch asked for (MAR-23). Returns a fake editor whose `selection` and
     * `revealRange` calls a test can read back — the switch restores a carried
     * selection and centers the arriving caret on it.
     */
    showTextDocument: vi.fn(async () => ({
        selection: undefined as Selection | undefined,
        revealRange: vi.fn(),
    })),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    setStatusBarMessage: vi.fn(),
    /** A fake terminal whose `sendText` calls a test can read back. */
    createTerminal: vi.fn((_options?: unknown) => ({
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
    })),
    createQuickPick: vi.fn(makeFakeQuickPick),
    createStatusBarItem: vi.fn((_id?: unknown, _alignment?: unknown, _priority?: unknown) =>
        makeFakeStatusBarItem(),
    ),
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
