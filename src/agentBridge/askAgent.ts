/**
 * src/agentBridge/askAgent.ts
 *
 * Ask Agent (MAR-371, MAR-272, MAR-376): a request typed at the caret, handed
 * once to whatever coding agent the user already runs. The webview's
 * `/ai <request>` row and the palette's "Ask Agent" both arrive here; the
 * extension composes ONE line, the request plus the caret's `path.md#L12`
 * reference, and routes it per `birta.agent.command`. Nothing here talks to a
 * model, opens a socket, or keeps a connection: it is the Send Feedback shape
 * (compose, hand off, the user's own tool does the rest), rung 0b of
 * `docs/NETWORK_POSTURE.md`, and `docs/AGENT_BRIDGE.md`'s standing
 * instruction against wire adapters is untouched.
 *
 * Routes, all in one string setting so it stays greppable and needs no vendor
 * list to rot:
 *   - a shell command template (`claude -p {prompt} ...`), run per
 *     `birta.agent.mode`: `background` (a child process of the extension host,
 *     no terminal, the run's start and end reported to the webview so it can
 *     mark the request's block in the gutter) or `terminal` (one reused
 *     "Birta AI" terminal the user watches);
 *   - `chat`, VS Code's Chat view with the line filled in;
 *   - `clipboard`, the line copied for pasting anywhere.
 * An empty setting asks on first use and stores the answer globally. The
 * setting is application-scoped by contribution: a workspace that could set
 * a shell template could run a command on the user's machine.
 *
 * The document is SAVED before the hand-off when dirty. The reference names
 * lines, and an agent reads the file from disk, so the bytes on disk have to
 * be the ones the reference was computed against. That is the one moment
 * this feature touches the document, and it is VS Code's own save.
 *
 * Completion, background mode only: the child's exit is the signal. If the
 * document is clean when the agent writes, VS Code reloads it and the webview
 * takes the change into its undo history (an edit the user asked for at the
 * caret undoes like a paste; see plugins/agentPending.ts). If the user typed
 * meanwhile, VS Code refuses the reload, so the disk text travels with the
 * `done` message and the webview merges it around the user's edits. There is
 * still no conversation: no history, no reply pane, one request per run.
 */

import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import type { ActiveContextResolver } from "./api";
import { buildReference } from "./format";
import { getBirtaConfiguration, readBirtaSetting } from "../config";
import { BIRTA_SETTING_KEYS } from "../../shared/config";
import { reportError, reportErrorWithNotification } from "../errorSink";
import type { AgentRunMessage } from "../../shared/messages";

/** Internal command the webview's `askAgent` message runs (not contributed). */
export const ASK_AGENT_COMMAND = "birta.askAgent";
/** Internal command the webview's `agentCancel` message runs. */
export const CANCEL_AGENT_COMMAND = "birta.cancelAgent";
/** Internal command the webview's `agentMergeResult` message runs. */
export const MERGE_RESULT_COMMAND = "birta.agentMergeResult";

/** Reserved `birta.agent.command` values that are routes rather than shells. */
export const AGENT_ROUTE_CHAT = "chat";
export const AGENT_ROUTE_CLIPBOARD = "clipboard";
/** Substituted with the shell-quoted line in a command template. */
export const PROMPT_PLACEHOLDER = "{prompt}";
/** The Chat view's open command (VS Code core, `workbench.action.chat.open`). */
export const CHAT_OPEN_COMMAND = "workbench.action.chat.open";
/** The one terminal `/ai` reuses in terminal mode, so repeated asks do not litter the panel. */
export const TERMINAL_NAME = "Birta AI";
/** Stderr tail carried into a failure report; stdout tail shown when a run changes nothing. */
const OUTPUT_TAIL = 400;

/**
 * The harness a template runs, for the marker's tooltip and the finish
 * report: the first word of the command (`claude`, `codex`), which is the
 * one thing about it the editor can know. Which MODEL answered is the
 * harness's own business and no CLI reports it in a form worth parsing.
 */
export function harnessName(template: string): string {
    const first = template.trim().split(/\s+/)[0] ?? "";
    return first.replace(/^.*[\\/]/, "") || "agent";
}

/**
 * The one line handed over: the request, whitespace collapsed to keep it a
 * single shell argument, prefixed with where it applies. Every major agent
 * reads `relative/path.md#L12-L20` as a location (buildReference's contract).
 */
export function composeAgentRequest(prompt: string, reference: string): string {
    return `In ${reference}: ${prompt.replace(/\s+/g, " ").trim()}`;
}

/**
 * Quote `text` as one shell argument. POSIX shells get single quotes with the
 * embedded-quote idiom. On Windows the shell this module runs (background)
 * and the terminal VS Code opens by default are both PowerShell, whose
 * single-quoted string is literal, with an embedded quote doubled; nothing
 * inside is expanded, which is the property that matters for prose.
 */
export function shellQuote(text: string, platform: NodeJS.Platform = process.platform): string {
    if (platform === "win32") {
        return `'${text.replace(/'/g, "''")}'`;
    }
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The template with every `{prompt}` replaced by the quoted line. A template
 * without the placeholder gets the line appended, so `claude` alone works.
 */
export function expandCommandTemplate(template: string, quotedPrompt: string): string {
    const trimmed = template.trim();
    return trimmed.includes(PROMPT_PLACEHOLDER)
        ? trimmed.split(PROMPT_PLACEHOLDER).join(quotedPrompt)
        : `${trimmed} ${quotedPrompt}`;
}

export type AgentMode = "background" | "terminal";

/** A settings.json typo (the enum constrains only the Settings UI) → the default. */
export function normalizeAgentMode(value: unknown): AgentMode {
    return value === "terminal" ? "terminal" : "background";
}

interface RoutePick extends vscode.QuickPickItem {
    /** The setting value; null asks for a custom template. */
    value: string | null;
    mode?: AgentMode;
}

/**
 * First-use picker. Deliberately short and made of things that do not rot:
 * two CLIs named by their binary, each in both modes, the host's own Chat
 * view, the clipboard, and a free template. The choice is stored globally so
 * it is asked once. The background templates are the CLIs' own
 * non-interactive forms; a template that would open an interactive session
 * hangs in the background with no terminal to answer it.
 */
async function pickRoute(): Promise<{ command: string; mode: AgentMode } | undefined> {
    const picks: RoutePick[] = [
        { label: "Claude Code, in the background", description: "claude -p {prompt} --permission-mode acceptEdits", detail: vscode.l10n.t("No terminal; a marker in the gutter while it runs, the edit arrives when it finishes"), value: "claude -p {prompt} --permission-mode acceptEdits", mode: "background" },
        { label: "Claude Code, in a terminal", description: "claude {prompt}", detail: vscode.l10n.t("One reused Birta AI terminal you can watch and answer"), value: "claude {prompt}", mode: "terminal" },
        { label: "Codex CLI, in the background", description: "codex exec --full-auto {prompt}", detail: vscode.l10n.t("No terminal; a marker in the gutter while it runs"), value: "codex exec --full-auto {prompt}", mode: "background" },
        { label: "Codex CLI, in a terminal", description: "codex {prompt}", detail: vscode.l10n.t("One reused Birta AI terminal you can watch and answer"), value: "codex {prompt}", mode: "terminal" },
        { label: vscode.l10n.t("VS Code Chat view"), description: AGENT_ROUTE_CHAT, detail: vscode.l10n.t("Copilot Chat or any chat participant, with the request filled in"), value: AGENT_ROUTE_CHAT },
        { label: vscode.l10n.t("Copy to clipboard"), description: AGENT_ROUTE_CLIPBOARD, detail: vscode.l10n.t("Paste the request into any agent yourself"), value: AGENT_ROUTE_CLIPBOARD },
        { label: vscode.l10n.t("Custom command"), description: "{prompt}", detail: vscode.l10n.t("A shell command; {prompt} is replaced by the quoted request; birta.agent.mode says whether it runs in the background or a terminal"), value: null },
    ];
    const pick = await vscode.window.showQuickPick(picks, {
        title: vscode.l10n.t("Where should Birta send your request?"),
        placeHolder: vscode.l10n.t("Stored in birta.agent.command; change it any time in Settings"),
        ignoreFocusOut: true,
    });
    if (!pick) { return undefined; }
    let value: string | undefined = pick.value ?? undefined;
    if (value === undefined) {
        value = await vscode.window.showInputBox({
            title: vscode.l10n.t("Agent command"),
            prompt: vscode.l10n.t("A shell command with {prompt} where the quoted request goes"),
            value: "claude -p {prompt} --permission-mode acceptEdits",
            ignoreFocusOut: true,
        });
        if (!value?.trim()) { return undefined; }
    }
    const config = getBirtaConfiguration();
    await config.update(BIRTA_SETTING_KEYS.agentCommand, value, vscode.ConfigurationTarget.Global);
    const mode = pick.mode ?? normalizeAgentMode(readBirtaSetting("agentMode"));
    if (pick.mode) {
        await config.update(BIRTA_SETTING_KEYS.agentMode, pick.mode, vscode.ConfigurationTarget.Global);
    }
    return { command: value, mode };
}

/** Where run-state reports go: the provider posts them to the document's webview. */
export type AgentRunReporter = (uri: vscode.Uri, message: AgentRunMessage) => void;

interface BackgroundRun {
    readonly requestId: string;
    readonly uri: vscode.Uri;
    /** The file's bytes when the run started; unchanged bytes at exit mean the agent wrote nothing. */
    readonly savedText: string;
    readonly child: ChildProcess;
    cancelled: boolean;
}

const runs = new Map<string, BackgroundRun>();

/** The reused terminal, created on first use and found again by name. */
function agentTerminal(cwd: vscode.Uri | undefined): vscode.Terminal {
    const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME && t.exitStatus === undefined);
    return existing ?? vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
}

/**
 * The child that runs a template in the background: the platform's own
 * shell, so a template reads exactly as it would in a terminal, and the same
 * quoting serves both. Both streams are kept (tail for the reports, whole
 * for the output channel). On POSIX the child leads its own process group,
 * so cancelling kills the agent and not only the shell in front of it: a
 * template with `&&` or a pipe would otherwise keep running after the pill
 * said cancelled, and write the file later.
 */
function spawnBackground(commandLine: string, cwd: string | undefined): ChildProcess {
    if (process.platform === "win32") {
        return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", commandLine], {
            cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
    }
    return spawn(commandLine, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true });
}

/** Stop a run's whole process tree, not just the shell that fronts it. */
function killTree(child: ChildProcess): void {
    if (child.pid === undefined) { child.kill(); return; }
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
        return;
    }
    try {
        process.kill(-child.pid, "SIGTERM");
    } catch {
        child.kill();
    }
}

/** The one output channel every run appends to, created on first use. */
let outputChannel: vscode.OutputChannel | undefined;
function output(): vscode.OutputChannel {
    outputChannel ??= vscode.window.createOutputChannel("Birta AI");
    return outputChannel;
}
/** The channel, for tests and for anything that wants to show it. */
export function agentOutputChannel(): vscode.OutputChannel { return output(); }
/** Whole-run transcript cap for the output channel. */
const OUTPUT_CAP = 64 * 1024;

/**
 * Wait, briefly, for VS Code's own reload of a clean document to land after
 * the agent wrote it, so the webview has the change (and its history entry)
 * before the run is reported done and stops recording. Bounded: a document
 * VS Code will not reload (dirty, closed) is not waited for.
 */
async function waitForReload(uri: vscode.Uri, disk: string): Promise<void> {
    const key = uri.toString();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        if (!document || document.isDirty || document.getText() === disk) { break; }
        await new Promise((r) => setTimeout(r, 50));
    }
    // The provider pushes the reload to the webview after its own settle
    // debounce (src/externalChanges.ts); give that push a moment to be sent
    // before `done`, which the webview handles in message order.
    await new Promise((r) => setTimeout(r, 400));
}

async function readDisk(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
        return undefined;
    }
}

/**
 * Start a background run and report its life to the webview: `running` now,
 * then `done` (with the disk text when the document is dirty, so the webview
 * can merge it around the user's edits) or `failed`. A run cancelled from the
 * gutter reports `cancelled`.
 */
function startBackground(
    requestId: string,
    uri: vscode.Uri,
    savedText: string,
    commandLine: string,
    harness: string,
    cwd: string | undefined,
    report: AgentRunReporter,
): void {
    const child = spawnBackground(commandLine, cwd);
    const run: BackgroundRun = { requestId, uri, savedText, child, cancelled: false };
    runs.set(requestId, run);
    report(uri, { type: "agentRun", requestId, status: "running", harness });
    const relPath = vscode.workspace.asRelativePath(uri, false);
    let stderr = "";
    let stdout = "";
    let transcript = "";
    const record = (chunk: Buffer, isErr: boolean): void => {
        const text = chunk.toString("utf8");
        transcript = (transcript + text).slice(-OUTPUT_CAP);
        if (isErr) { stderr = (stderr + text).slice(-OUTPUT_TAIL); } else { stdout = (stdout + text).slice(-OUTPUT_TAIL); }
    };
    child.stderr?.on("data", (chunk: Buffer) => record(chunk, true));
    child.stdout?.on("data", (chunk: Buffer) => record(chunk, false));
    const showOutput = vscode.l10n.t("Show Output");
    const logRun = (verdict: string): void => {
        const channel = output();
        channel.appendLine(`[${new Date().toISOString()}] ${harness} on ${relPath}: ${verdict}`);
        channel.appendLine(commandLine);
        if (transcript.trim()) { channel.appendLine(transcript.trimEnd()); }
        channel.appendLine("");
    };
    const failed = (message: string): void => {
        logRun(`failed (${message})`);
        report(uri, { type: "agentRun", requestId, status: "failed", message, harness });
        void Promise.resolve(vscode.window.showErrorMessage(
            vscode.l10n.t("{0} could not finish your request on {1}: {2}", harness, relPath, message),
            showOutput,
        )).then((pick) => { if (pick === showOutput) { output().show(true); } });
    };
    child.on("error", (err) => {
        runs.delete(requestId);
        reportError("askAgent background", err);
        failed(String((err as Error).message ?? err));
    });
    child.on("exit", (code) => {
        void (async () => {
            runs.delete(requestId);
            if (run.cancelled) {
                logRun("cancelled");
                report(uri, { type: "agentRun", requestId, status: "cancelled", harness });
                vscode.window.setStatusBarMessage(vscode.l10n.t("{0}: request cancelled", harness), 4000);
                return;
            }
            if (code !== 0) {
                failed(vscode.l10n.t("exit code {0}. {1}", String(code), (stderr.trim() || stdout.trim())));
                return;
            }
            // Every run ends with something the user can see. A run that
            // changed the file: the change itself, and one line in the status
            // bar. A run that changed nothing: its own last words, since the
            // answer to "say hello" was never in the file to begin with.
            const disk = await readDisk(uri);
            const changed = disk !== undefined && disk !== savedText;
            if (!changed) {
                logRun("finished, no change to the file");
                report(uri, { type: "agentRun", requestId, status: "done", harness });
                const said = stdout.trim().split(/\r?\n/).filter((l) => l.trim() !== "").slice(-3).join(" ");
                void Promise.resolve(vscode.window.showInformationMessage(
                    said
                        ? vscode.l10n.t("{0} finished without changing {1}. It said: {2}", harness, relPath, said)
                        : vscode.l10n.t("{0} finished without changing {1}, and said nothing.", harness, relPath),
                    showOutput,
                )).then((pick) => { if (pick === showOutput) { output().show(true); } });
                return;
            }
            logRun("finished, file changed");
            // Clean document: VS Code reloads it and the webview takes the
            // change into history; wait for that to land before the run
            // stops recording. Dirty: the reload is refused, so hand the disk
            // text over for the webview to merge around the user's edits; the
            // webview reports how that went (agentMergeResult).
            let document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
            if (document && !document.isDirty) {
                await waitForReload(uri, disk);
                document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
            }
            if (document?.isDirty && document.getText() !== disk) {
                report(uri, { type: "agentRun", requestId, status: "done", text: disk, harness });
                return;
            }
            report(uri, { type: "agentRun", requestId, status: "done", harness });
            vscode.window.setStatusBarMessage(vscode.l10n.t("{0} finished: {1} updated", harness, relPath), 5000);
        })();
    });
}

/** Cancel a background run from its gutter marker. No-op for an unknown id. */
export function cancelAgentRun(requestId: string): void {
    const run = runs.get(requestId);
    if (!run) { return; }
    run.cancelled = true;
    killTree(run.child);
}

/**
 * The webview's verdict on a dirty-document merge, so the finish line in the
 * status bar says what happened rather than what was hoped.
 */
export function reportAgentMerge(uri: vscode.Uri, outcome: string): void {
    const relPath = vscode.workspace.asRelativePath(uri, false);
    if (outcome === "applied" || outcome === "unchanged") {
        vscode.window.setStatusBarMessage(vscode.l10n.t("Agent finished: {0} updated around your edits", relPath), 5000);
        return;
    }
    void vscode.window.showWarningMessage(outcome === "partial"
        ? vscode.l10n.t("The agent's changes to {0} overlapped yours in places; those were left out. Its full version is on disk: use Compare in the drift badge to see both.", relPath)
        : vscode.l10n.t("The agent's changes to {0} overlap yours and could not be merged. Its version is on disk: use Compare in the drift badge to see both.", relPath));
}

/** Hand the composed line to the configured route. */
async function dispatch(
    setting: string,
    mode: AgentMode,
    line: string,
    active: { uri: vscode.Uri; requestId?: string; savedText: string },
    report: AgentRunReporter,
): Promise<void> {
    if (setting === AGENT_ROUTE_CLIPBOARD) {
        await vscode.env.clipboard.writeText(line);
        vscode.window.setStatusBarMessage(vscode.l10n.t("Copied your request for your agent"), 3000);
        return;
    }
    if (setting === AGENT_ROUTE_CHAT) {
        await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, { query: line });
        return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(active.uri)?.uri;
    const commandLine = expandCommandTemplate(setting, shellQuote(line));
    if (mode === "background" && active.requestId) {
        startBackground(active.requestId, active.uri, active.savedText, commandLine, harnessName(setting), folder?.fsPath, report);
        return;
    }
    // One reused terminal: nothing piles up in the panel, and the user sees
    // exactly what ran. Rooted at the workspace folder on creation so the
    // relative reference in the line resolves where the agent runs.
    const terminal = agentTerminal(folder);
    terminal.show(false);
    terminal.sendText(commandLine, true);
}

/**
 * The command body: resolve the caret, get the request (asking when the
 * caller had none), save so disk matches the reference, route.
 */
export async function askAgent(
    getActive: ActiveContextResolver,
    report: AgentRunReporter,
    prompt: string | undefined,
    requestId: string | undefined,
): Promise<void> {
    const active = await getActive();
    const handedOff = (): void => {
        if (requestId && active) {
            report(active.uri, { type: "agentRun", requestId, status: "handedOff" });
        }
    };
    if (!active) {
        vscode.window.setStatusBarMessage(vscode.l10n.t("Birta: no active editor to ask about."), 3000);
        return;
    }
    let request = prompt?.trim();
    if (!request) {
        request = (await vscode.window.showInputBox({
            title: vscode.l10n.t("Ask Agent"),
            prompt: vscode.l10n.t("What should your agent do here? One request; it runs on this file at the caret."),
            placeHolder: vscode.l10n.t("add a mermaid diagram of the flow described above"),
            ignoreFocusOut: true,
        }))?.trim();
        if (!request) { handedOff(); return; }
    }
    let route = readBirtaSetting("agentCommand").trim();
    let mode = normalizeAgentMode(readBirtaSetting("agentMode"));
    if (!route) {
        const picked = await pickRoute();
        if (!picked) { handedOff(); return; }
        route = picked.command;
        mode = picked.mode;
    }
    const relPath = vscode.workspace.asRelativePath(active.uri, false);
    const line = composeAgentRequest(request, buildReference(relPath, active.context));
    // The reference names lines in the file the agent will read from disk, so
    // disk must hold what the reference was computed against.
    const document = await vscode.workspace.openTextDocument(active.uri);
    if (document.isDirty && !(await document.save())) {
        vscode.window.showWarningMessage(
            vscode.l10n.t("Birta could not save {0}, so the request was not sent.", relPath),
        );
        handedOff();
        return;
    }
    try {
        await dispatch(route, mode, line, { uri: active.uri, requestId, savedText: document.getText() }, report);
        // Only a background run reports its own life; every other route is a
        // hand-off the editor cannot follow, and the webview drops its marker.
        if (!(mode === "background" && route !== AGENT_ROUTE_CHAT && route !== AGENT_ROUTE_CLIPBOARD)) {
            handedOff();
        }
    } catch (err) {
        handedOff();
        reportErrorWithNotification(
            "askAgent",
            err,
            vscode.l10n.t("Birta could not hand your request to {0}. Check birta.agent.command.", route),
            `askAgent:${route}`,
        );
    }
}

/** Register the internal `birta.askAgent` and `birta.cancelAgent` commands. */
export function registerAskAgent(
    context: vscode.ExtensionContext,
    getActive: ActiveContextResolver,
    report: AgentRunReporter,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(ASK_AGENT_COMMAND, (prompt?: unknown, requestId?: unknown) =>
            askAgent(
                getActive,
                report,
                typeof prompt === "string" ? prompt : undefined,
                typeof requestId === "string" ? requestId : undefined,
            ),
        ),
        vscode.commands.registerCommand(CANCEL_AGENT_COMMAND, (requestId?: unknown) => {
            if (typeof requestId === "string") { cancelAgentRun(requestId); }
        }),
        vscode.commands.registerCommand(MERGE_RESULT_COMMAND, (uri?: unknown, outcome?: unknown) => {
            if (uri && typeof (uri as vscode.Uri).fsPath === "string" && typeof outcome === "string") { reportAgentMerge(uri as vscode.Uri, outcome); }
        }),
        { dispose: () => { for (const run of runs.values()) { run.cancelled = true; killTree(run.child); } runs.clear(); outputChannel?.dispose(); } },
    );
}
