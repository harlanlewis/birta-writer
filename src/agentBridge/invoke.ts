/**
 * src/agentBridge/invoke.ts
 *
 * The `/ai` adapter: hand ONE prompt to the coding agent the user already
 * runs, with the caret's file and line span named for it (MAR-371, MAR-272).
 *
 * ## Why a terminal, and why a template
 *
 * This is a one-way INVOKE, not a wire adapter: Birta composes a command line
 * and runs it in a terminal the user can see. No socket, no server, no
 * lockfile, no discovery entry, no auth, nothing to maintain — the boundary
 * `docs/AGENT_BRIDGE.md` draws around the pruned Family-B endpoint (MAR-243),
 * whose standing instruction is not to reintroduce one. It is the same shape
 * as the Send Feedback command: compose text, hand it off, the user watches it
 * run.
 *
 * The target is a `birta.ai.command` TEMPLATE rather than a roster of known
 * harnesses, for the reason the adapter layer already gives: the agent
 * ecosystem is young and churning, and a shipped vendor list rots. Claude
 * Code is the default because it is what the maintainer runs; Codex, Copilot
 * CLI, or a shell function are one setting away, with no code change here.
 *
 * ## What this deliberately does NOT do
 *
 * It does not wait, and it does not report completion. A one-way invoke cannot
 * know when the agent finished, and promising otherwise would be a UI cheque
 * the architecture does not honour: the result reaches the editor (or does
 * not) through the ordinary external-change path, exactly like any other edit
 * made to the file on disk. The known consequence is written down on MAR-272 —
 * an agent's write is applied only while the document is CLEAN, so typing
 * during the wait turns the result into a disk-drift advisory instead. Saving
 * first (below) closes the window at T0; it cannot close the one after.
 */

import * as vscode from "vscode";
import type { ActiveContextResolver } from "./api";
import { buildReference } from "./format";
import { readBirtaConfig } from "../config";
import { reportErrorWithNotification } from "../errorSink";

/** The one terminal `/ai` reuses, so repeated asks do not litter the panel. */
const TERMINAL_NAME = "Birta AI";

/**
 * Quote a value so the shell passes it through as ONE literal argument.
 *
 * The prompt is the user's own prose, so this is a correctness guard rather
 * than a trust boundary: an apostrophe in "don't" or a `$` in a price would
 * otherwise break the command apart or be expanded by the shell before the
 * agent ever saw it. Both quoting styles are total — every byte survives —
 * which is the property that matters.
 */
export function shellQuote(value: string, windows: boolean): string {
    if (windows) {
        // PowerShell (the VS Code default shell on Windows): single quotes are
        // literal, and an embedded single quote is escaped by doubling it.
        return `'${value.replace(/'/g, "''")}'`;
    }
    // POSIX: single quotes are literal and cannot contain themselves, so a
    // quote is closed, an escaped quote emitted, and the quoting resumed.
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The placeholders `birta.ai.command` may carry. */
export interface InvokeSubstitutions {
    /** What the user typed after `/ai`. */
    prompt: string;
    /** `notes.md#L12-L20` — the reference every major coding agent accepts. */
    reference: string;
    /** The workspace-relative path alone. */
    file: string;
    /** The prompt with the reference named — the default template's value. */
    instruction: string;
}

/**
 * Substitute `${…}` placeholders in a command template, shell-quoting every
 * value. Unknown placeholders are left untouched: a template is user-authored
 * config, and silently blanking a name they meant literally would be worse
 * than passing it through for the shell to answer for.
 *
 * Pure and exported for tests.
 */
export function renderCommand(
    template: string,
    subs: InvokeSubstitutions,
    windows: boolean,
): string {
    return template.replace(/\$\{(\w+)\}/g, (whole, name: string) => {
        const value = (subs as unknown as Record<string, string | undefined>)[name];
        return value === undefined ? whole : shellQuote(value, windows);
    });
}

/** The instruction the default template sends: the ask, and where it applies. */
export function buildInstruction(prompt: string, reference: string): string {
    return `In ${reference}: ${prompt}`;
}

/**
 * Register `birta.editor.aiPrompt`'s extension half. The webview command posts
 * `invokeAgent`; the provider routes it here.
 */
export function registerAgentInvoke(
    context: vscode.ExtensionContext,
    getActive: ActiveContextResolver,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "birta._invokeAgent",
            async (prompt: unknown): Promise<void> => {
                if (typeof prompt !== "string" || !prompt.trim()) {
                    return;
                }
                await invokeAgent(prompt.trim(), getActive);
            },
        ),
    );
}

/** Compose and run one agent invocation. Exported for the provider's route. */
export async function invokeAgent(
    prompt: string,
    getActive: ActiveContextResolver,
): Promise<void> {
    const config = readBirtaConfig();
    if (!config.aiEnabled) {
        // Reachable only if the setting flipped off between the menu opening
        // and the pick; the row itself is gone when off.
        return;
    }
    const template = config.aiCommand.trim();
    if (!template) {
        vscode.window.showWarningMessage(
            vscode.l10n.t("Birta: set birta.ai.command to the agent you want /ai to run."),
        );
        return;
    }

    const active = await getActive();
    if (!active) {
        vscode.window.setStatusBarMessage(
            vscode.l10n.t("Birta: no active editor to send."),
            3000,
        );
        return;
    }

    const relPath = vscode.workspace.asRelativePath(active.uri, false);
    const reference = buildReference(relPath, active.context);

    // Save first. The agent reads the file from DISK and cannot see unsaved
    // edits, so an unsaved buffer would have it working from stale bytes and
    // answering about text the user has already changed. It also leaves the
    // document clean, which is the state VS Code requires before it will apply
    // the agent's own write back into the editor (src/externalChanges.ts).
    const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === active.uri.toString(),
    );
    if (doc?.isDirty) {
        try {
            await doc.save();
        } catch (err) {
            reportErrorWithNotification(
                "agentInvoke.save",
                err,
                vscode.l10n.t("Birta: could not save the document, so /ai was not sent."),
            );
            return;
        }
    }

    const windows = process.platform === "win32";
    const command = renderCommand(
        template,
        {
            prompt,
            reference,
            file: relPath,
            instruction: buildInstruction(prompt, reference),
        },
        windows,
    );

    // Reuse one terminal so a day of asks does not fill the panel, and SHOW it:
    // the agent's own output is the only progress the user gets, because a
    // one-way invoke has nothing to report back.
    const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
    const terminal =
        existing ??
        vscode.window.createTerminal({
            name: TERMINAL_NAME,
            cwd: vscode.workspace.getWorkspaceFolder(active.uri)?.uri,
        });
    terminal.show(true);
    terminal.sendText(command, true);
}
