/**
 * src/agentBridge/languageModelTool.ts
 *
 * The Copilot-ecosystem adapter: a Language Model Tool so agent mode (and any
 * LM-tool client) can PULL the Birta editor's file + selection on demand — the
 * one path that reaches an in-VS-Code agent without the user copy-pasting, since
 * `window.activeTextEditor` is empty for a custom editor.
 *
 * Requires VS Code ≥ 1.95 (the `languageModelTools` contribution point). The
 * registration is guarded so an older host — or a fork that lacks the API — no-ops
 * at activation instead of throwing.
 */

import * as vscode from "vscode";
import type { ActiveContextResolver } from "./api";
import { describeForModel } from "./format";

/** Tool name; must match the `languageModelTools` contribution in package.json. */
const TOOL_NAME = "birta_getEditorContext";

/** Register the editor-context Language Model Tool, if the host supports it. */
export function registerEditorContextTool(
    context: vscode.ExtensionContext,
    getActive: ActiveContextResolver,
): void {
    if (typeof vscode.lm?.registerTool !== "function") { return; }

    const tool: vscode.LanguageModelTool<void> = {
        async invoke() {
            const active = await getActive();
            const text = active
                ? describeForModel(
                      vscode.workspace.asRelativePath(active.uri, false),
                      active.context,
                  )
                : "No Birta markdown editor is currently active.";
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
        },
    };

    context.subscriptions.push(vscode.lm.registerTool(TOOL_NAME, tool));
}
