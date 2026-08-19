/**
 * src/agentBridge/referenceCommand.ts
 *
 * The universal, agent-agnostic adapter: commands that put a precise reference
 * to the current file + selection on the clipboard, ready to paste into any
 * coding agent's chat or @-mention box. Works with every agent today, with no
 * protocol and no per-agent coupling — the highest-compatibility way to kill
 * the "tell it where to look" friction while the user stays in the WYSIWYG
 * editor.
 */

import * as vscode from "vscode";
import type { ActiveContextResolver } from "./api";
import { buildReference, buildContextBlock } from "./format";

/**
 * What goes on the clipboard.
 *
 * `auto` is the selection palette's, and it is the only one that reads the
 * selection to decide: a pointer alone is what a tool working IN the project
 * wants, and a tool that cannot open the file needs the lines too, so the
 * useful payload is both when there is something to quote and just the pointer
 * when there is not. The other two are the palette commands, which mean
 * exactly what they say and do not change under the user.
 */
export type CopyMode = "reference" | "context" | "auto";

/** Register `birta.copyAgentReference`, `birta.copyAgentContext` and the
 * webview button's `birta._copyForAgent`. */
export function registerReferenceCommands(
    context: vscode.ExtensionContext,
    getActive: ActiveContextResolver,
): void {
    const copy = async (mode: CopyMode): Promise<void> => {
        const active = await getActive();
        if (!active) {
            vscode.window.setStatusBarMessage(
                vscode.l10n.t("Birta: no active editor to reference."),
                3000,
            );
            return;
        }
        const relPath = vscode.workspace.asRelativePath(active.uri, false);

        // The reference names LINES IN A FILE, so the file has to hold them.
        // A document with unsaved edits sends an agent to a line number
        // computed against bytes that are not on disk, which is worse than
        // refusing: it looks like it worked. Same rule and same failure mode
        // as the `/ai` hand-off, which saves for the same reason.
        const document = await vscode.workspace.openTextDocument(active.uri);
        if (document.isDirty && !(await document.save())) {
            vscode.window.showWarningMessage(
                vscode.l10n.t("Birta could not save {0}, so nothing was copied.", relPath),
            );
            return;
        }

        const quoting = mode === "context" || (mode === "auto" && !active.context.isEmpty);
        // The quoted content is the span's REAL source lines, read from the
        // backing document (already open — this is the custom editor's own
        // TextDocument), so structure survives where the webview's plain text
        // would not.
        const payload = quoting
            ? buildContextBlock(relPath, active.context, document.getText())
            : buildReference(relPath, active.context);
        await vscode.env.clipboard.writeText(payload);

        // A notification rather than the status bar. The question this answers
        // is "did it copy", asked in the half-second before pasting somewhere
        // else, and the status bar's bottom corner is the one place a person
        // editing prose in the middle of the window is not looking. It names
        // the reference rather than saying "Copied", because the reference is
        // the part worth checking before it goes into an agent.
        const reference = buildReference(relPath, active.context);
        vscode.window.showInformationMessage(
            quoting
                ? vscode.l10n.t("Copied {0} and the selected lines", reference)
                : vscode.l10n.t("Copied {0}", reference),
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("birta.copyAgentReference", () => copy("reference")),
        vscode.commands.registerCommand("birta.copyAgentContext", () => copy("context")),
        // The selection palette's button. Uncontributed and underscored, like
        // `birta._test.insertText`: it is reached from the webview and has no
        // business in the command palette, where the two named commands above
        // already say what they do. A palette row called "Copy for AI Agent"
        // beside them would be a third answer to a question that has two.
        vscode.commands.registerCommand("birta._copyForAgent", () => copy("auto")),
    );
}
