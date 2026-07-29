/**
 * src/agentBridge/claudeIdeEndpoint.ts
 *
 * Lifecycle for the Claude Code IDE endpoint (the Family-B wire adapter,
 * MAR-243): gated behind the opt-in `birta.agentBridge.claudeIde` setting
 * (application-scoped, default off). Disabled costs nothing at runtime — the
 * server module (and its `ws` dependency) is bundled but not EXECUTED until
 * the first enable (esbuild wraps the dynamic import in a lazy CJS shim); no
 * listener runs, no file is written.
 *
 * While enabled, Birta publishes a discovery lockfile alongside the official
 * extension's (distinct port, distinct `ideName`), so the `/ide` picker in a
 * terminal `claude` offers "Birta Writer" as a connectable IDE. Coexistence
 * is by-choice, not automatic: the user opted in, and the picker disambiguates.
 */

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { readBirtaSetting } from "../config";
import { reportError, reportErrorWithNotification } from "../errorSink";
import type { ActiveContextResolver } from "./api";
import type { ClaudeIdeServer } from "./claudeIde/server";
import type { RevealInBirta } from "./claudeIde/vscodeHost";

/** Where the `claude` CLI scans for IDE lockfiles. */
function claudeConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function registerClaudeIdeEndpoint(
    context: vscode.ExtensionContext,
    getActive: ActiveContextResolver,
    revealInBirta: RevealInBirta,
): void {
    let server: ClaudeIdeServer | null = null;
    // Serializes start/stop/restart: every transition chains onto the last, so
    // a fast enable→disable toggle can never leak a server or double-start.
    let transition: Promise<void> = Promise.resolve();

    const start = async (): Promise<void> => {
        if (server) { return; }
        try {
            const [{ startClaudeIdeServer }, { createVsCodeIdeHost }] = await Promise.all([
                import("./claudeIde/server.js"),
                import("./claudeIde/vscodeHost.js"),
            ]);
            server = await startClaudeIdeServer({
                host: createVsCodeIdeHost(getActive, revealInBirta),
                configDir: claudeConfigDir(),
                workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
                    (folder) => folder.uri.fsPath,
                ),
                pid: process.pid,
                serverVersion:
                    (context.extension.packageJSON as { version?: string }).version ?? "0.0.0",
            });
        } catch (err) {
            // The user opted in and got nothing — that is notification-worthy.
            reportErrorWithNotification(
                "claudeIdeEndpoint",
                err,
                "Birta: the Claude Code IDE endpoint failed to start.",
            );
        }
    };

    const stop = async (): Promise<void> => {
        const running = server;
        server = null;
        if (running) { await running.dispose(); }
    };

    // Chain a transition, keeping the chain alive whatever the step did — a
    // rejected link would otherwise skip every later enable/disable silently.
    const chain = (step: () => Promise<void>): void => {
        transition = transition.then(step).catch((err) => reportError("claudeIdeEndpoint", err));
    };

    const apply = (): void => {
        const enabled = readBirtaSetting("claudeIdeEnabled");
        chain(() => (enabled ? start() : stop()));
    };

    apply();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("birta.agentBridge.claudeIde")) { apply(); }
        }),
        // The lockfile names the workspace folders the CLI matches its cwd
        // against — folder changes need a republish, which a restart provides.
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            chain(async () => {
                if (!server) { return; }
                await stop();
                await start();
            });
        }),
        new vscode.Disposable(() => {
            chain(stop);
        }),
    );
}
