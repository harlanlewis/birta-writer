/**
 * src/agentBridge/claudeIde/server.ts
 *
 * The Claude Code IDE endpoint's transport: a loopback-only WebSocket server
 * plus the discovery lockfile the `claude` CLI scans (`<configDir>/ide/
 * <port>.lock`). Security posture, all non-negotiable (MAR-243):
 *
 * - binds 127.0.0.1 only, ephemeral port;
 * - fresh random token per start, checked on every upgrade via the
 *   `x-claude-code-ide-authorization` header;
 * - any `Origin` header rejects the upgrade (see authorizesUpgrade);
 * - lockfile written 0600 inside a 0700 dir, removed on dispose.
 *
 * No `vscode` import — the editor half arrives as an injected `IdeHost`, so
 * tests drive a real server + real client over loopback with a fake host.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { McpCore, authorizesUpgrade, buildLockfilePayload, type LockfilePayload } from "./protocol";
import { buildIdeTools, type IdeHost } from "./tools";

export interface ClaudeIdeServerOptions {
    host: IdeHost;
    /** The Claude config dir (`~/.claude` or `$CLAUDE_CONFIG_DIR`); `ide/` is created inside. */
    configDir: string;
    workspaceFolders: string[];
    pid: number;
    serverVersion: string;
}

export interface ClaudeIdeServer {
    port: number;
    lockfilePath: string;
    dispose(): Promise<void>;
}

/**
 * Remove lockfiles a dead Birta process left behind (a killed extension host
 * never runs dispose). Scoped hard to our own corpses: only files whose
 * payload names our `ideName` AND whose pid no longer runs — the official
 * extension's lockfiles (different ideName) are never touched, and neither is
 * anything unparseable.
 */
export function sweepStaleLockfiles(ideDir: string): void {
    let entries: string[];
    try {
        entries = fs.readdirSync(ideDir);
    } catch {
        return; // No dir yet — nothing to sweep.
    }
    for (const entry of entries) {
        if (!entry.endsWith(".lock")) { continue; }
        const file = path.join(ideDir, entry);
        try {
            const payload = JSON.parse(fs.readFileSync(file, "utf8")) as {
                ideName?: string;
                pid?: number;
            };
            if (payload.ideName !== "Birta Writer" || typeof payload.pid !== "number") {
                continue;
            }
            if (!pidIsAlive(payload.pid)) {
                fs.unlinkSync(file);
            }
        } catch {
            // Unreadable/unparseable: not provably ours — leave it alone.
        }
    }
}

/**
 * Start the endpoint: listen on loopback, then publish the lockfile. Order
 * matters — the lockfile names the port, so it can only be written after the
 * ephemeral port is known, and it must be gone again before the socket dies
 * (dispose unlinks first, then closes) so the CLI never discovers a corpse.
 */
export async function startClaudeIdeServer(
    opts: ClaudeIdeServerOptions,
): Promise<ClaudeIdeServer> {
    const authToken = crypto.randomUUID();
    const core = new McpCore("Birta Writer MCP", opts.serverVersion, buildIdeTools(opts.host));

    const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        // MCP requests are small; the ws default (100 MiB) only widens the
        // memory a token-holding client can pin.
        maxPayload: 1024 * 1024,
        verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) =>
            authorizesUpgrade(info.req.headers, authToken),
    });

    await new Promise<void>((resolve, reject) => {
        wss.once("listening", resolve);
        wss.once("error", reject);
    });
    const address = wss.address();
    if (address === null || typeof address === "string") {
        wss.close();
        throw new Error("Claude IDE endpoint: no bound address");
    }
    const port = address.port;

    wss.on("connection", (socket) => {
        // A protocol-violating frame (bad opcode, unmasked, over maxPayload)
        // emits `error` on the socket; without a listener that is an uncaught
        // exception in the host. Drop the offender, keep serving.
        socket.on("error", () => socket.terminate());
        socket.on("message", (data: Buffer | string) => {
            core.handle(String(data))
                .then((reply) => {
                    if (reply !== null && socket.readyState === socket.OPEN) {
                        socket.send(reply);
                    }
                })
                .catch(() => socket.terminate());
        });
    });

    const closeAll = (): Promise<void> => {
        for (const client of wss.clients) { client.terminate(); }
        return new Promise<void>((resolve) => wss.close(() => resolve()));
    };

    // The socket is bound; everything from here on must not leak it — a
    // failed publish (unwritable config dir, live lockfile collision) closes
    // the server and rejects, so the caller never holds a half-started state.
    const ideDir = path.join(opts.configDir, "ide");
    const lockfilePath = path.join(ideDir, `${port}.lock`);
    try {
        sweepStaleLockfiles(ideDir);
        fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });
        // mkdirSync's mode only applies to dirs it creates; enforce the 0700
        // claim on a pre-existing dir too — it holds secret-bearing files.
        fs.chmodSync(ideDir, 0o700);
        publishLockfile(
            lockfilePath,
            buildLockfilePayload({
                pid: opts.pid,
                workspaceFolders: opts.workspaceFolders,
                authToken,
                runningInWindows: process.platform === "win32",
            }),
        );
    } catch (err) {
        await closeAll();
        throw err;
    }

    return {
        port,
        lockfilePath,
        dispose: async () => {
            try {
                fs.unlinkSync(lockfilePath);
            } catch {
                // Already gone (manual cleanup, config-dir wipe) — fine.
            }
            await closeAll();
        },
    };
}

/** Alive unless the kernel says ESRCH — EPERM means alive-but-not-ours. */
function pidIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

/**
 * Write the lockfile exclusively (`wx`, 0600) so a pre-existing file at our
 * port — some other IDE's leftover; a live server can't own the port we just
 * bound — is never silently clobbered mode-and-all. A leftover is replaced
 * only when provably dead (unparseable, or its pid no longer runs); a
 * live-pid collision fails the start instead, keeping "never overwrite the
 * official lockfile" true.
 */
export function publishLockfile(lockfilePath: string, payload: LockfilePayload): void {
    const body = JSON.stringify(payload);
    try {
        fs.writeFileSync(lockfilePath, body, { mode: 0o600, flag: "wx" });
        return;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") { throw err; }
    }
    let ownerAlive = false;
    try {
        const existing = JSON.parse(fs.readFileSync(lockfilePath, "utf8")) as { pid?: number };
        ownerAlive = typeof existing.pid === "number" && pidIsAlive(existing.pid);
    } catch {
        // Unparseable at OUR port number: junk that breaks CLI discovery — replace it.
    }
    if (ownerAlive) {
        throw new Error(`lockfile ${lockfilePath} belongs to a live process`);
    }
    fs.unlinkSync(lockfilePath);
    fs.writeFileSync(lockfilePath, body, { mode: 0o600, flag: "wx" });
}
