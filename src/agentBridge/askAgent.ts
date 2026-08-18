/**
 * src/agentBridge/askAgent.ts
 *
 * Ask Agent (MAR-371, MAR-272): a request typed at the caret, handed once to
 * whatever coding agent the user already runs. The webview's `/ai <request>`
 * row and the palette's "Ask Agent" both arrive here; the extension composes
 * ONE line, the request plus the caret's `path.md#L12` reference, and routes
 * it per `birta.agent.command`. Nothing here talks to a model, opens a
 * socket, or keeps a connection: it is the Send Feedback shape (compose,
 * hand off, the user's own tool does the rest), rung 0b of
 * `docs/NETWORK_POSTURE.md`, and `docs/AGENT_BRIDGE.md`'s standing
 * instruction against wire adapters is untouched.
 *
 * Three routes, all in one string setting so it stays greppable and needs no
 * vendor list to rot:
 *   - a shell command template (`claude {prompt}`), run in a fresh terminal
 *     rooted at the file's workspace folder so the relative reference resolves;
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
 * One-shot, never a conversation: there is no waiting state, no history, no
 * reply pane. What the agent writes arrives later as an ordinary external
 * change, and MAR-272's comments record why a waiting state would mislead.
 */

import * as vscode from "vscode";
import type { ActiveContextResolver } from "./api";
import { buildReference } from "./format";
import { getBirtaConfiguration, readBirtaSetting } from "../config";
import { BIRTA_SETTING_KEYS } from "../../shared/config";
import { reportErrorWithNotification } from "../errorSink";

/** Internal command the webview's `askAgent` message runs (not contributed). */
export const ASK_AGENT_COMMAND = "birta.askAgent";

/** Reserved `birta.agent.command` values that are routes rather than shells. */
export const AGENT_ROUTE_CHAT = "chat";
export const AGENT_ROUTE_CLIPBOARD = "clipboard";
/** Substituted with the shell-quoted line in a command template. */
export const PROMPT_PLACEHOLDER = "{prompt}";
/** The Chat view's open command (VS Code core, `workbench.action.chat.open`). */
export const CHAT_OPEN_COMMAND = "workbench.action.chat.open";
export const TERMINAL_NAME = "Birta: Ask Agent";

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
 * embedded-quote idiom; on Windows the terminal VS Code opens by default is
 * PowerShell, whose double-quoted string escapes `"`, `$` and the backtick
 * with a backtick. A user on cmd.exe sets a template that quotes for it.
 */
export function shellQuote(text: string, platform: NodeJS.Platform = process.platform): string {
    if (platform === "win32") {
        return `"${text.replace(/[`"$]/g, (c) => "`" + c)}"`;
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

interface RoutePick extends vscode.QuickPickItem {
    /** The setting value; null asks for a custom template. */
    value: string | null;
}

/**
 * First-use picker. Deliberately short and made of things that do not rot:
 * two CLIs named by their binary, the host's own Chat view, the clipboard,
 * and a free template. The choice is stored globally so it is asked once.
 */
async function pickRoute(): Promise<string | undefined> {
    const picks: RoutePick[] = [
        { label: "Claude Code", description: "claude {prompt}", detail: vscode.l10n.t("Runs in a new terminal"), value: "claude {prompt}" },
        { label: "Codex CLI", description: "codex {prompt}", detail: vscode.l10n.t("Runs in a new terminal"), value: "codex {prompt}" },
        { label: vscode.l10n.t("VS Code Chat view"), description: AGENT_ROUTE_CHAT, detail: vscode.l10n.t("Copilot Chat or any chat participant, with the request filled in"), value: AGENT_ROUTE_CHAT },
        { label: vscode.l10n.t("Copy to clipboard"), description: AGENT_ROUTE_CLIPBOARD, detail: vscode.l10n.t("Paste the request into any agent yourself"), value: AGENT_ROUTE_CLIPBOARD },
        { label: vscode.l10n.t("Custom command"), description: "{prompt}", detail: vscode.l10n.t("A shell command; {prompt} is replaced by the quoted request"), value: null },
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
            value: "claude {prompt}",
            ignoreFocusOut: true,
        });
        if (!value?.trim()) { return undefined; }
    }
    await getBirtaConfiguration().update(
        BIRTA_SETTING_KEYS.agentCommand,
        value,
        vscode.ConfigurationTarget.Global,
    );
    return value;
}

/** Hand the composed line to the configured route. */
async function dispatch(setting: string, line: string, cwd: vscode.Uri | undefined): Promise<void> {
    if (setting === AGENT_ROUTE_CLIPBOARD) {
        await vscode.env.clipboard.writeText(line);
        vscode.window.setStatusBarMessage(
            vscode.l10n.t("Copied your request for your agent"),
            3000,
        );
        return;
    }
    if (setting === AGENT_ROUTE_CHAT) {
        await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, { query: line });
        return;
    }
    // A fresh terminal per request keeps the hand-off one-shot: nothing is
    // typed into a session that may be mid-conversation, and the user sees
    // exactly what ran. Rooted at the workspace folder so the relative
    // reference in the line resolves where the agent runs.
    const terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
    terminal.show(false);
    terminal.sendText(expandCommandTemplate(setting, shellQuote(line)), true);
}

/**
 * The command body: resolve the caret, get the request (asking when the
 * caller had none), save so disk matches the reference, route.
 */
export async function askAgent(
    getActive: ActiveContextResolver,
    prompt: string | undefined,
): Promise<void> {
    const active = await getActive();
    if (!active) {
        vscode.window.setStatusBarMessage(
            vscode.l10n.t("Birta: no active editor to ask about."),
            3000,
        );
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
        if (!request) { return; }
    }
    let route = readBirtaSetting("agentCommand").trim();
    if (!route) {
        route = (await pickRoute()) ?? "";
        if (!route) { return; }
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
        return;
    }
    try {
        await dispatch(route, line, vscode.workspace.getWorkspaceFolder(active.uri)?.uri);
    } catch (err) {
        reportErrorWithNotification(
            "askAgent",
            err,
            vscode.l10n.t("Birta could not hand your request to {0}. Check birta.agent.command.", route),
            `askAgent:${route}`,
        );
    }
}

/** Register the internal `birta.askAgent` command. */
export function registerAskAgent(
    context: vscode.ExtensionContext,
    getActive: ActiveContextResolver,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(ASK_AGENT_COMMAND, (prompt?: unknown) =>
            askAgent(getActive, typeof prompt === "string" ? prompt : undefined),
        ),
    );
}
