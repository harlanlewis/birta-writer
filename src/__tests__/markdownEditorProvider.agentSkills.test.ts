/**
 * The extension's half of the skill picker (MAR-483): a `requestAgentCapabilities`
 * is answered with the skills the scan reached, read through the workspace
 * fs off the document's workspace folder and the home directory, and nothing
 * is scanned without an agent command to scan for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";
import type { AgentSkill } from "../../shared/messages";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
        workspaceState: { get: vi.fn(() => undefined), update: vi.fn() },
        subscriptions: [],
    }) as unknown as vscode.ExtensionContext;

const makePanel = () => ({
    viewColumn: 1,
    active: true,
    visible: true,
    webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview-resource:",
        postMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
});

const readDirectory = vscode.workspace.fs.readDirectory as unknown as ReturnType<typeof vi.fn>;
const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;
const getWorkspaceFolder = vscode.workspace.getWorkspaceFolder as unknown as ReturnType<typeof vi.fn>;
const getConfiguration = vi.mocked(vscode.workspace.getConfiguration);
const defaultConfiguration = getConfiguration.getMockImplementation()!;

const HOME = "/home/u";
let agentCommand = "claude -p {prompt}";
let files: Record<string, string>;

function mountDisk(contents: Record<string, string>): void {
    files = contents;
    readDirectory.mockImplementation(async (uri: vscode.Uri) => {
        const prefix = uri.fsPath.replace(/\/+$/, "") + "/";
        const names = new Map<string, number>();
        for (const p of Object.keys(files)) {
            if (!p.startsWith(prefix)) { continue; }
            const head = p.slice(prefix.length).split("/")[0]!;
            // A folder named `linked-*` is reported the way a symlinked folder
            // is: the SymbolicLink bit beside the Directory bit.
            const dirKind = head.startsWith("linked-") ? vscode.FileType.SymbolicLink | vscode.FileType.Directory : vscode.FileType.Directory;
            names.set(head, p.slice(prefix.length).includes("/") ? dirKind : vscode.FileType.File);
        }
        if (names.size === 0) { throw new Error("ENOENT"); }
        return [...names.entries()];
    });
    readFile.mockImplementation(async (uri: vscode.Uri) => {
        const text = files[uri.fsPath];
        if (text === undefined) { throw new Error("ENOENT"); }
        return new TextEncoder().encode(text);
    });
}

async function open(path: string) {
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("", vscode.Uri.file(path));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    const handler = panel.webview.onDidReceiveMessage.mock.calls[0]![0] as (msg: Record<string, unknown>) => Promise<void>;
    return { panel, handler };
}

function skillsSent(panel: ReturnType<typeof makePanel>): AgentSkill[][] {
    return panel.webview.postMessage.mock.calls
        .map((c) => c[0] as { type: string; skills: AgentSkill[] })
        .filter((m) => m.type === "agentSkills")
        .map((m) => m.skills);
}

async function settle(): Promise<void> {
    for (let i = 0; i < 30; i++) { await Promise.resolve(); }
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n`;

describe("MarkdownEditorProvider: the agent skills", () => {
    const home = process.env.HOME;
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
        process.env.HOME = HOME;
        agentCommand = "claude -p {prompt}";
        getConfiguration.mockImplementation(() => ({
            get: vi.fn((key: string, defaultValue?: unknown) => (key === "agent.command" ? agentCommand : defaultValue)),
            inspect: vi.fn(() => undefined),
            update: vi.fn(async () => undefined),
        }) as never);
        vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file("/ws") }];
        getWorkspaceFolder.mockImplementation((uri: vscode.Uri) =>
            uri.fsPath.startsWith("/ws/") ? { uri: vscode.Uri.file("/ws") } : undefined);
    });
    afterEach(() => {
        process.env.HOME = home;
        getConfiguration.mockImplementation(defaultConfiguration);
        vscode.workspace.workspaceFolders = undefined;
        getWorkspaceFolder.mockReset();
        getWorkspaceFolder.mockImplementation(() => undefined);
    });

    it("asking for capabilities should also answer with the project's and the machine's skills, in that order", async () => {
        mountDisk({
            "/ws/.claude/skills/birta-changelog/SKILL.md": skill("birta-changelog", "Write a changelog entry."),
            [`${HOME}/.claude/skills/house-style/SKILL.md`]: skill("house-style", "Our voice."),
            [`${HOME}/.codex/skills/codex-only/SKILL.md`]: skill("codex-only", "Not for claude."),
        });
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestAgentCapabilities" });
        await settle();
        expect(skillsSent(panel)).toEqual([[
            { name: "birta-changelog", description: "Write a changelog entry.", scope: "project" },
            { name: "house-style", description: "Our voice.", scope: "user" },
        ]]);
    });

    it("a symlinked skill folder should be offered like any other, since the harness follows the link", async () => {
        mountDisk({ [`${HOME}/.claude/skills/linked-plugin-skill/SKILL.md`]: skill("plugin-skill", "Linked in.") });
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestAgentCapabilities" });
        await settle();
        expect(skillsSent(panel)[0]!.map((s) => s.name)).toEqual(["plugin-skill"]);
    });

    it("the configured harness should decide which extra folder is read", async () => {
        agentCommand = "codex exec {prompt}";
        mountDisk({ [`${HOME}/.codex/skills/codex-only/SKILL.md`]: skill("codex-only", "Codex keeps this.") });
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestAgentCapabilities" });
        await settle();
        expect(skillsSent(panel)[0]!.map((s) => s.name)).toEqual(["codex-only"]);
    });

    it("with no agent command, nothing should be scanned and nothing sent", async () => {
        agentCommand = "";
        mountDisk({ [`${HOME}/.claude/skills/house-style/SKILL.md`]: skill("house-style", "x") });
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestAgentCapabilities" });
        await settle();
        expect(skillsSent(panel)).toEqual([]);
        expect(readDirectory).not.toHaveBeenCalled();
    });

    it("a machine with no skill folder at all should be answered with an empty list, so the picker still offers free text", async () => {
        mountDisk({});
        const { panel, handler } = await open("/ws/note.md");
        await handler({ type: "requestAgentCapabilities" });
        await settle();
        expect(skillsSent(panel)).toEqual([[]]);
    });
});
