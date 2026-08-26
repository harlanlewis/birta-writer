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
 * The template is also where the MODEL lives, as the harness's own flag
 * (`--model haiku`), which is why there is no `birta.agent.model`: a
 * structured setting would need per-harness flag grammar, the vendor list
 * this design exists to avoid. `describeAgentRoute` reads the template back
 * as display facts so the webview can say what a request is about to run
 * before it runs; the raw template never crosses that boundary.
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
import { tmpdir } from "node:os";
import type { ActiveContextResolver } from "./api";
import { buildReference } from "./format";
import { getBirtaConfiguration, readBirtaSetting } from "../config";
import { BIRTA_SETTING_KEYS } from "../../shared/config";
import { reportError, reportErrorWithNotification } from "../errorSink";
import { EFFORT_FLAGS, harnessName, MODEL_FLAGS } from "./harnessCapabilities";
/** Re-exported: the dispatcher is where callers and tests expect to find it. */
export { harnessName };
import { cachedCapabilities } from "./harnessProbe";
import type { AgentRouteSummary, AgentRunMessage } from "../../shared/messages";

/** Internal command the webview's `askAgent` message runs (not contributed). */
export const ASK_AGENT_COMMAND = "birta.askAgent";
/** Internal command the webview's `askAgentAdvanced` message runs. */
export const ASK_AGENT_ADVANCED_COMMAND = "birta.askAgentAdvanced";
/** Internal command the webview's `agentCancel` message runs. */
export const CANCEL_AGENT_COMMAND = "birta.cancelAgent";
/** Internal command the webview's `agentMergeResult` message runs. */
export const MERGE_RESULT_COMMAND = "birta.agentMergeResult";
/** Contributed: stop every background run (also the status bar item's click). */
export const STOP_ALL_COMMAND = "birta.stopAgentRuns";

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
/** Largest attachment written to disk. Mirrors the panel's own pre-read cap. */
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/**
 * The model a template NAMES, or undefined. Only the unambiguous long forms
 * (`--model sonnet`, `--model=sonnet`) count: `-m` is a different flag in
 * enough tools to be a guess, and a guess here would put a wrong model name
 * in front of the user at the moment they are deciding whether to send.
 *
 * This reads the user's OWN template, which is why it is not the vendor list
 * this module refuses to carry: nothing is inferred about a harness, and a
 * template with no `--model` reports nothing rather than a default. What the
 * CLI then resolves an alias to is still its own business.
 */
export function agentModelName(template: string): string | undefined {
    return templateFlagValue(template, MODEL_FLAGS);
}

/**
 * The value a template gives the first of `flags` it carries, or undefined.
 *
 * Reads the same spellings the probe looks for, so a template written for a
 * harness that says `--thinking` is read back correctly rather than reported
 * as having no effort at all. Only the unambiguous long forms count: `-m` is
 * a different flag in enough tools to be a guess, and a guess here would put
 * a wrong name in front of the user at the moment they are deciding whether
 * to send.
 */
export function templateFlagValue(
    template: string,
    flags: readonly string[],
): string | undefined {
    for (const flag of flags) {
        const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m = new RegExp(`(?:^|\\s)${escaped}[=\\s]+("[^"]*"|'[^']*'|\\S+)`).exec(template);
        const raw = m?.[1];
        if (raw === undefined) { continue; }
        const unquoted = /^(["'])(.*)\1$/.exec(raw);
        const value = (unquoted ? unquoted[2] : raw) || undefined;
        if (value !== undefined) { return value; }
    }
    return undefined;
}

/**
 * The effort a template NAMES, or undefined. Same rule as the model: the
 * long form only, and nothing inferred. Unlike the model this IS a closed
 * set, because the flag documents its own values (`claude --help`: low,
 * medium, high, xhigh, max), so an unrecognized value is reported as typed
 * rather than dropped: the user wrote it, and hiding it would be a lie about
 * what is configured.
 */
export function agentEffortName(template: string): string | undefined {
    return templateFlagValue(template, EFFORT_FLAGS);
}

/**
 * The configured route as display facts, for the webview's `/ai` hint. An
 * empty setting is `configured: false`: the first `/ai` will ask, and the
 * hint has to say so rather than name a route nobody chose.
 */
export function describeAgentRoute(command: string, mode: AgentMode): AgentRouteSummary {
    const template = command.trim();
    if (!template) { return { configured: false, kind: "shell" }; }
    if (template === AGENT_ROUTE_CHAT) { return { configured: true, kind: "chat" }; }
    if (template === AGENT_ROUTE_CLIPBOARD) { return { configured: true, kind: "clipboard" }; }
    return {
        configured: true,
        kind: "shell",
        harness: harnessName(template),
        model: agentModelName(template),
        effort: agentEffortName(template),
        mode,
    };
}

/** The current route, read fresh from settings (the config seam's contract). */
export function currentAgentRoute(): AgentRouteSummary {
    return describeAgentRoute(
        readBirtaSetting("agentCommand"),
        normalizeAgentMode(readBirtaSetting("agentMode")),
    );
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

/**
 * Set `flag` to `value` in a command template, replacing the value it
 * already carries or appending the flag when it carries none. `undefined`
 * REMOVES the flag, which is how "let the harness decide" is expressed:
 * there is no value meaning "default", and inventing one would send a
 * literal `default` to the CLI.
 *
 * Appending goes before a trailing `{prompt}` when the template ends with
 * one, so the prompt stays the last argument. A CLI that takes the prompt
 * positionally would otherwise read the flag's value as the prompt.
 *
 * Lives here rather than beside the help parser because it is about the
 * template, which this module owns, and because the parser must stay free of
 * any dependency on this one: it is the piece that has to be testable with
 * nothing spawned.
 */
export function setTemplateFlag(
    template: string,
    flag: string,
    value: string | undefined,
): string {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The same shape agentModelName reads, so what the panel sets is exactly
    // what the hint reads back: `--flag v`, `--flag=v`, and quoted forms.
    const existing = new RegExp(`(^|\\s)${escaped}[=\\s]+("[^"]*"|'[^']*'|\\S+)`);
    const trimmed = template.trim();
    if (existing.test(trimmed)) {
        return value === undefined
            ? trimmed.replace(existing, "").replace(/\s{2,}/g, " ").trim()
            : trimmed.replace(existing, `$1${flag} ${value}`);
    }
    if (value === undefined) {
        return trimmed;
    }
    const addition = `${flag} ${value}`;
    return trimmed.endsWith(PROMPT_PLACEHOLDER)
        ? `${trimmed.slice(0, -PROMPT_PLACEHOLDER.length).trim()} ${addition} ${PROMPT_PLACEHOLDER}`
        : `${trimmed} ${addition}`;
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
        { label: "Codex CLI, in the background", description: "codex exec --sandbox workspace-write --skip-git-repo-check {prompt}", detail: vscode.l10n.t("No terminal; a marker in the gutter while it runs"), value: "codex exec --sandbox workspace-write --skip-git-repo-check {prompt}", mode: "background" },
        { label: "Codex CLI, in a terminal", description: "codex {prompt}", detail: vscode.l10n.t("One reused Birta AI terminal you can watch and answer"), value: "codex {prompt}", mode: "terminal" },
        { label: vscode.l10n.t("VS Code Chat view"), description: AGENT_ROUTE_CHAT, detail: vscode.l10n.t("Copilot Chat or any chat participant, with the request filled in"), value: AGENT_ROUTE_CHAT },
        { label: vscode.l10n.t("Copy to clipboard"), description: AGENT_ROUTE_CLIPBOARD, detail: vscode.l10n.t("Paste the request into any agent yourself"), value: AGENT_ROUTE_CLIPBOARD },
        { label: vscode.l10n.t("Custom command"), description: "{prompt}", detail: vscode.l10n.t("A shell command; {prompt} is replaced by the quoted request; birta.agent.mode says whether it runs in the background or a terminal"), value: null },
    ];
    const pick = await vscode.window.showQuickPick(picks, {
        title: vscode.l10n.t("Where should Birta send your request?"),
        // The placeholder is where the model question gets answered, rather
        // than a second pair of rows per CLI: a route is chosen once, and
        // model aliases rot faster than binary names do.
        placeHolder: vscode.l10n.t("Stored in birta.agent.command; add your harness's own flags there (--model, --effort) to choose what runs"),
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
    readonly harness: string;
    readonly child: ChildProcess;
    cancelled: boolean;
    /**
     * VS Code reloaded the clean document with the agent's write while the
     * run was still going: the webview already has the edit (in history). A
     * landed run ends with a plain done whatever the document looks like at
     * exit, because an edit or an undo made after the landing is the user's,
     * and a merge of the disk text over it would put the agent's version back.
     */
    landed: boolean;
    readonly watch: vscode.Disposable;
}

const runs = new Map<string, BackgroundRun>();

/**
 * One status bar item while any background run is live: the runs are
 * visible outside the document (a closed tab, a rebuilt editor, a hung
 * template have no pill), and clicking it stops them all.
 */
let runsItem: vscode.StatusBarItem | undefined;
/** The item, for tests. Undefined until the first run. */
export function agentRunsStatusItem(): vscode.StatusBarItem | undefined { return runsItem; }
function refreshRunsItem(): void {
    if (runs.size === 0) { runsItem?.hide(); return; }
    runsItem ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    const names = [...new Set([...runs.values()].map((r) => r.harness))].join(", ");
    runsItem.text = `$(sync~spin) ${names}`;
    runsItem.tooltip = runs.size === 1
        ? vscode.l10n.t("{0} is working on your request. Click to stop it.", names)
        : vscode.l10n.t("{0} requests running. Click to stop them all.", String(runs.size));
    runsItem.command = STOP_ALL_COMMAND;
    runsItem.show();
}

/** Terminals with a command still executing under shell integration, so a new request never types into a live session. */
const busyTerminals = new Set<vscode.Terminal>();

/**
 * The reused terminal: found by name, recreated after it exits, and left
 * alone while shell integration says its last command (an interactive
 * `claude` session, say) is still running, because `sendText` into that
 * would type the new request into the old session as a message.
 */
function agentTerminal(cwd: vscode.Uri | undefined): vscode.Terminal {
    const existing = vscode.window.terminals.find((t) =>
        t.name === TERMINAL_NAME && t.exitStatus === undefined && !busyTerminals.has(t));
    return existing ?? vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
}

/** Run a line in the terminal, through shell integration when the shell offers it (so its end is known). */
function runInTerminal(terminal: vscode.Terminal, commandLine: string): void {
    const integration = terminal.shellIntegration;
    if (integration) {
        busyTerminals.add(terminal);
        integration.executeCommand(commandLine);
        return;
    }
    terminal.sendText(commandLine, true);
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
    // A clean document taking a text change that is not the saved text is
    // VS Code's reload of the agent's write: the edit has landed.
    const watch = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== uri.toString() || e.document.isDirty) { return; }
        if (e.document.getText() !== savedText) { run.landed = true; }
    });
    const run: BackgroundRun = { requestId, uri, savedText, harness, child, cancelled: false, landed: false, watch };
    runs.set(requestId, run);
    refreshRunsItem();
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
    const finish = (): void => {
        runs.delete(requestId);
        run.watch.dispose();
        refreshRunsItem();
    };
    child.on("error", (err) => {
        finish();
        reportError("askAgent background", err);
        failed(String((err as Error).message ?? err));
    });
    // `close`, not `exit`: the streams are drained by then, and for a headless
    // agent the last lines of stdout are the answer.
    child.on("close", (code) => {
        void (async () => {
            finish();
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
            if (document && !document.isDirty && !run.landed) {
                await waitForReload(uri, disk);
                document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
            }
            if (!run.landed && document?.isDirty && document.getText() !== disk) {
                // Before the report, never after: see `rescueAgentVersion`.
                await rescueAgentVersion(requestId, uri, disk);
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
 * The agent's own version, kept beside the document while the webview decides
 * what to do with it. Keyed by request.
 */
const agentRescues = new Map<string, vscode.Uri>();

/**
 * The first name nothing occupies: `stem.ext`, then `stem 2.ext`, and so on.
 *
 * BOUNDED, and the bound is not decoration. The loop's exit condition is a
 * `stat` that throws, so a filesystem layer that answers every stat, real or
 * mocked, turns an unbounded version into a spin that never returns and never
 * writes. The fallback name collides only with itself.
 */
const RESCUE_NAME_TRIES = 200;

async function unusedUri(directory: vscode.Uri, stem: string, ext: string): Promise<vscode.Uri> {
    for (let n = 1; n <= RESCUE_NAME_TRIES; n++) {
        const candidate = vscode.Uri.joinPath(directory, n === 1 ? `${stem}.${ext}` : `${stem} ${n}.${ext}`);
        try {
            await vscode.workspace.fs.stat(candidate);
        } catch {
            return candidate;
        }
    }
    return vscode.Uri.joinPath(directory, `${stem} ${Date.now().toString(36)}.${ext}`);
}

/**
 * Keep the agent's version beside the document while the webview merges.
 *
 * Written BEFORE the webview is told, not after it answers, and that ordering
 * is the whole point. The merge dispatches a transaction, the sync writes the
 * merged buffer back, and with `files.autoSave` set to `afterDelay` that
 * reaches disk about a second later, over the file the agent wrote. Waiting
 * for `agentMergeResult` to decide whether a copy is wanted would be racing
 * that write with an IPC round trip. So the copy is made unconditionally here
 * and removed again when the webview reports that nothing was left out.
 *
 * A failure is not worth interrupting the run for: what it costs is the copy,
 * and the merge still happens.
 *
 * A copy nobody settles OUTLIVES the session, and that is the deliberate side
 * to err on. `agentMergeResult` is sent whenever the webview merges, but a
 * webview disposed mid-flight (a switch to the raw editor) never reports, and
 * the choice there is between leaving a file the user did not ask for and
 * deleting the only remaining copy of the agent's work. The file stays.
 */
async function rescueAgentVersion(requestId: string, uri: vscode.Uri, text: string): Promise<void> {
    try {
        const directory = vscode.Uri.joinPath(uri, "..");
        const name = uri.path.split("/").pop() ?? "document.md";
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot + 1) : "md";
        const target = await unusedUri(directory, `${stem} (agent)`, ext);
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, "utf8"));
        agentRescues.set(requestId, target);
    } catch (err) {
        reportError("agent rescue", err);
    }
}

/**
 * The webview has said what its merge did, so the copy is either unnecessary
 * or is the only place the agent's work still exists.
 *
 * Returns the path to name in the message, or undefined when there is nothing
 * to keep.
 */
async function settleAgentRescue(requestId: string | undefined, outcome: string): Promise<string | undefined> {
    const target = requestId === undefined ? undefined : agentRescues.get(requestId);
    if (!target || requestId === undefined) { return undefined; }
    agentRescues.delete(requestId);
    if (outcome === "applied" || outcome === "unchanged") {
        try {
            await vscode.workspace.fs.delete(target);
        } catch (err) {
            reportError("agent rescue cleanup", err);
        }
        return undefined;
    }
    return vscode.workspace.asRelativePath(target, false);
}

/**
 * The webview's verdict on a dirty-document merge, so the finish line in the
 * status bar says what happened rather than what was hoped.
 */
export async function reportAgentMerge(uri: vscode.Uri, outcome: string, requestId?: string): Promise<void> {
    const relPath = vscode.workspace.asRelativePath(uri, false);
    const kept = await settleAgentRescue(requestId, outcome);
    if (outcome === "applied" || outcome === "unchanged") {
        vscode.window.setStatusBarMessage(vscode.l10n.t("Agent finished: {0} updated around your edits", relPath), 5000);
        return;
    }
    // The kept copy is named, because the file the agent wrote is NOT a
    // durable place to point at: the merged buffer is written back over it,
    // within about a second when `files.autoSave` is `afterDelay`. Without a
    // copy there is nothing honest to say, so the message says the part that is
    // still true and stops promising a comparison.
    const left = outcome === "partial"
        ? vscode.l10n.t("The agent's changes to {0} overlapped yours in places; those were left out.", relPath)
        : vscode.l10n.t("The agent's changes to {0} overlap yours and could not be merged.", relPath);
    void vscode.window.showWarningMessage(kept
        ? vscode.l10n.t("{0} Its full version is kept in {1}.", left, kept)
        : left);
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
    runInTerminal(terminal, commandLine);
}

/** Stop every live background run (the status bar item, the palette command, deactivation). */
export function cancelAllAgentRuns(): void {
    for (const run of runs.values()) { run.cancelled = true; killTree(run.child); }
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
    /**
     * The command to run instead of `birta.agent.command`, for one request.
     * The advanced panel passes the setting with its model and effort
     * written in. An override never reaches settings and never triggers the
     * first-use picker, because a caller with a template has a route.
     */
    templateOverride?: string,
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
    let route = (templateOverride ?? readBirtaSetting("agentCommand")).trim();
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

/**
 * Write one attachment's bytes somewhere the agent can read them, and return
 * the path.
 *
 * A session temp directory, never the document's own image folder: an
 * attachment is context for one request, and a screenshot dropped to ask a
 * question about it has no business becoming a file in the user's repository
 * that they then have to notice and delete.
 *
 * The name is reduced to its basename and stripped of anything that is not a
 * plain filename character, so a name arriving from the webview cannot walk
 * out of the directory it is being written into.
 */
export async function saveAgentAttachment(name: string, bytes: Uint8Array): Promise<vscode.Uri> {
    // The panel refuses an oversized file before reading it, which is the
    // bound that matters. This one is the floor under that: it is the side
    // that touches the user's disk, and it should not depend on the caller
    // having checked. Cheap, because by here the bytes are already decoded.
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    const base = (name.split(/[\\/]/).pop() ?? "file").replace(/[^\w.\-]/g, "_").slice(-64);
    const safe = base.replace(/^\.+/, "") || "file";
    const dir = vscode.Uri.joinPath(
        vscode.Uri.file(tmpdir()),
        `birta-ai-${process.pid}`,
    );
    await vscode.workspace.fs.createDirectory(dir);
    // Prefixed with a counter so two files of the same name in one request
    // do not overwrite each other.
    const target = vscode.Uri.joinPath(dir, `${attachmentSeq++}-${safe}`);
    await vscode.workspace.fs.writeFile(target, bytes);
    return target;
}
let attachmentSeq = 0;

/**
 * The advanced panel's send: the same hand-off, with the model and effort it
 * chose written into the template for this one request.
 *
 * The setting is NOT updated. A model picked for one edit is a choice about
 * that edit, and silently rewriting `birta.agent.command` would turn it into
 * a preference the user never asked to change.
 */
export async function askAgentAdvanced(
    getActive: ActiveContextResolver,
    report: AgentRunReporter,
    request: {
        prompt: string;
        requestId?: string;
        model?: string;
        effort?: string;
        attachments?: readonly string[];
    },
): Promise<void> {
    const base = readBirtaSetting("agentCommand").trim();
    // Composed BEFORE the route branch. The Chat view and the clipboard have
    // no flags to write, but they still carry the request, and dropping the
    // attachments there would send someone's "describe this screenshot" with
    // no screenshot in it and no sign that anything went missing.
    //
    // The paths ride IN the prompt, because there is no attachment channel to
    // a shell command and a path is the one thing every agent reads. Each is
    // double-quoted and they are joined with spaces rather than newlines,
    // because composeAgentRequest collapses every run of whitespace to keep
    // the hand-off a single line: newlines would not survive it, and an
    // unquoted path would stop being one token the moment a temp directory
    // had a space in it, which is the normal shape of `%TEMP%` under a
    // Windows user name. The quotes are literal inside the shell-quoted
    // argument, so the agent sees them and reads one path.
    const files = request.attachments ?? [];
    const prompt = files.length > 0
        ? `${request.prompt} Attached files: ${files.map((f) => `"${f}"`).join(" ")}`
        : request.prompt;
    if (!base || base === AGENT_ROUTE_CHAT || base === AGENT_ROUTE_CLIPBOARD) {
        // Nothing to write a model or effort into. The plain path still
        // works, and asks for a route when there is none.
        await askAgent(getActive, report, prompt, request.requestId);
        return;
    }
    // The flag SPELLINGS come from the probe, not from here: the panel offered
    // whatever this harness documents, and the command has to be written in
    // that harness's own words. Falling back to the commonest spelling only
    // when the probe never ran, which is also the only case where the panel
    // could not have offered the control in the first place.
    const caps = cachedCapabilities(base);
    // A probe that ran is the authority, including when it says a harness has
    // no such flag: undefined there means "documents none", and writing one
    // anyway is a command that fails. Only an absent probe falls back, and
    // that is also the case where the panel showed no control to use.
    const modelFlag = caps ? caps.modelFlag : "--model";
    const effortFlag = caps ? caps.effortFlag : "--effort";
    let template = base;
    if (request.model !== undefined && modelFlag) {
        template = setTemplateFlag(template, modelFlag, request.model || undefined);
    }
    if (request.effort !== undefined && effortFlag) {
        template = setTemplateFlag(template, effortFlag, request.effort || undefined);
    }
    await askAgent(getActive, report, prompt, request.requestId, template);
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
        vscode.commands.registerCommand(ASK_AGENT_ADVANCED_COMMAND, (req?: unknown) => {
            const r = (req ?? {}) as Record<string, unknown>;
            return askAgentAdvanced(getActive, report, {
                prompt: typeof r.prompt === "string" ? r.prompt : "",
                requestId: typeof r.requestId === "string" ? r.requestId : undefined,
                model: typeof r.model === "string" ? r.model : undefined,
                effort: typeof r.effort === "string" ? r.effort : undefined,
                attachments: Array.isArray(r.attachments)
                    ? r.attachments.filter((a): a is string => typeof a === "string")
                    : undefined,
            });
        }),
        vscode.commands.registerCommand(CANCEL_AGENT_COMMAND, (requestId?: unknown) => {
            if (typeof requestId === "string") { cancelAgentRun(requestId); }
        }),
        vscode.commands.registerCommand(MERGE_RESULT_COMMAND, (uri?: unknown, outcome?: unknown, requestId?: unknown) => {
            if (uri && typeof (uri as vscode.Uri).fsPath === "string" && typeof outcome === "string") {
                void reportAgentMerge(uri as vscode.Uri, outcome,
                    typeof requestId === "string" ? requestId : undefined);
            }
        }),
        vscode.commands.registerCommand(STOP_ALL_COMMAND, () => cancelAllAgentRuns()),
        vscode.window.onDidEndTerminalShellExecution((e) => { busyTerminals.delete(e.terminal); }),
        vscode.window.onDidCloseTerminal((t) => { busyTerminals.delete(t); }),
        // Deactivation (a window reload, an extension update) stops every run:
        // a process the extension can no longer report on must not keep
        // writing the file. The transcript channel goes with it.
        { dispose: () => { cancelAllAgentRuns(); for (const run of runs.values()) { run.watch.dispose(); } runs.clear(); runsItem?.dispose(); outputChannel?.dispose(); } },
    );
}
