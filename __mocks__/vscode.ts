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
};

export const env = {
    language: "en",
    openExternal: vi.fn(),
};

export const window = {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
};

export const commands = {
    executeCommand: vi.fn(),
};

export const EventEmitter = vi.fn(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
}));

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
