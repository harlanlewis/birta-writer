/**
 * src/agentBridge/
 *
 * Bridges the Birta WYSIWYG editor to coding agents (Copilot, Cursor, the
 * Claude/Codex sidebars, open-source in-editor agents). VS Code deliberately
 * leaves `window.activeTextEditor` undefined for a custom editor
 * (microsoft/vscode#102110, as-designed), so an agent reading that API sees
 * nothing while the user is in Birta.
 *
 * The architecture is one neutral context source (the `ActiveContextResolver`,
 * backed by the provider's pull) and many thin adapters, each projecting that
 * source onto one agent-ingestion surface:
 *
 *   - referenceCommand — universal clipboard reference (every agent, explicit)
 *   - askAgent         - one-shot hand-off of a caret request to the user's
 *                        agent (terminal, Chat view, or clipboard; MAR-371)
 *   - languageModelTool — Copilot agent mode can pull it (VS Code ≥ 1.95)
 *   - publicApi        — any cooperating extension can read it
 *
 * Reaching a new agent means adding an adapter here; the core never changes.
 * Family-B wire adapters (Claude/Codex IDE sockets, ACP) plug into the same
 * resolver and are a separate, verification-gated increment.
 */

import type * as vscode from "vscode";
import type { ActiveContextResolver, BirtaApi } from "./api";
import { registerReferenceCommands } from "./referenceCommand";
import { registerAskAgent, type AgentRunReporter } from "./askAgent";
import { registerEditorContextTool } from "./languageModelTool";
import { createBirtaApi } from "./publicApi";

export type { BirtaApi, BirtaEditorContext, BirtaPosition } from "./api";

/**
 * Wire every agent-bridge adapter to the neutral resolver and return the
 * extension's public API. Called once from activate().
 */
export function registerAgentBridge(
    context: vscode.ExtensionContext,
    getActive: ActiveContextResolver,
    reportAgentRun: AgentRunReporter,
): BirtaApi {
    registerReferenceCommands(context, getActive);
    registerAskAgent(context, getActive, reportAgentRun);
    registerEditorContextTool(context, getActive);
    return createBirtaApi(getActive);
}
