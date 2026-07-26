/**
 * src/agentBridge/referenceCommand.ts
 *
 * The universal, agent-agnostic adapter: two commands that put a precise
 * reference to the current file + selection on the clipboard, ready to paste
 * into any coding agent's chat or @-mention box. Works with every agent today,
 * with no protocol and no per-agent coupling — the highest-compatibility way to
 * kill the "tell it where to look" friction while the user stays in the WYSIWYG
 * editor.
 */

import * as vscode from "vscode";
import type { ActiveContextResolver } from "./api";
import { buildReference, buildContextBlock } from "./format";

/** Register `birta.copyAgentReference` and `birta.copyAgentContext`. */
export function registerReferenceCommands(
    context: vscode.ExtensionContext,
    getActive: ActiveContextResolver,
): void {
    const copy = async (mode: "reference" | "context"): Promise<void> => {
        const active = await getActive();
        if (!active) {
            vscode.window.setStatusBarMessage(
                vscode.l10n.t("Birta: no active editor to reference."),
                3000,
            );
            return;
        }
        const relPath = vscode.workspace.asRelativePath(active.uri, false);
        const payload =
            mode === "reference"
                ? buildReference(relPath, active.context)
                : buildContextBlock(relPath, active.context);
        await vscode.env.clipboard.writeText(payload);
        vscode.window.setStatusBarMessage(
            vscode.l10n.t("Copied {0} — paste it into your AI agent", relPath),
            3000,
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("birta.copyAgentReference", () => copy("reference")),
        vscode.commands.registerCommand("birta.copyAgentContext", () => copy("context")),
    );
}
