/**
 * src/agentBridge/claudeIde/protocol.ts
 *
 * The pure protocol half of the Claude Code IDE endpoint: the MCP (JSON-RPC
 * 2.0) request dispatcher, the upgrade-authorization predicate, and the
 * discovery lockfile payload. No `vscode`, no sockets, no filesystem — every
 * behavior here is unit-testable with plain strings.
 *
 * The wire contract is OBSERVED, not inferred: captured live from the official
 * Anthropic VS Code extension's IDE server (v2.1.220) by speaking the same
 * handshake the `claude` CLI uses — initialize → notifications/initialized →
 * tools/list → tools/call, results wrapped as `content: [{type: "text", text:
 * <pretty-printed JSON>}]`.
 */

import * as crypto from "node:crypto";

/** The auth header the `claude` CLI sends on the WebSocket upgrade request. */
export const IDE_AUTH_HEADER = "x-claude-code-ide-authorization";

/** The MCP protocol revision the official IDE server speaks today. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Whether a WebSocket upgrade request may connect.
 *
 * Two gates, both required:
 * - The auth header must equal the per-activation token published in the
 *   0600 lockfile — only local processes that can read the user's own
 *   `~/.claude/ide` directory hold it.
 * - The request must carry NO `Origin` header. Browsers always attach one to
 *   WebSocket handshakes (and cannot attach custom headers like the token),
 *   while the CLI attaches neither; rejecting any Origin shuts out the
 *   browser-initiated cross-origin class behind the Claude IDE CVE
 *   (GHSA-9f65-56v6-gxw7) outright instead of allowlisting origins.
 */
export function authorizesUpgrade(
    headers: Record<string, string | string[] | undefined>,
    token: string,
): boolean {
    // Node lowercases incoming header names before we see them, so these
    // lookups are case-immune (verified with raw mixed-case handshakes).
    if (headers["origin"] !== undefined) { return false; }
    if (headers["sec-websocket-origin"] !== undefined) { return false; } // legacy origin header
    const presented = headers[IDE_AUTH_HEADER];
    if (typeof presented !== "string" || presented.length === 0) { return false; }
    // Constant-time comparison via digests (equal lengths by construction).
    const digest = (value: string): Buffer => crypto.createHash("sha256").update(value).digest();
    return crypto.timingSafeEqual(digest(presented), digest(token));
}

/** The discovery lockfile's JSON payload (`~/.claude/ide/<port>.lock`). */
export interface LockfilePayload {
    pid: number;
    workspaceFolders: string[];
    ideName: string;
    transport: "ws";
    runningInWindows: boolean;
    authToken: string;
}

/**
 * The lockfile body the `claude` CLI discovers IDE endpoints by. Field set
 * mirrors the official extension's lockfile byte-for-byte in shape; `ideName`
 * is what the `/ide` picker displays, so it names Birta rather than
 * impersonating VS Code.
 */
export function buildLockfilePayload(opts: {
    pid: number;
    workspaceFolders: string[];
    authToken: string;
    runningInWindows: boolean;
}): LockfilePayload {
    return {
        pid: opts.pid,
        workspaceFolders: opts.workspaceFolders,
        ideName: "Birta Writer",
        transport: "ws",
        runningInWindows: opts.runningInWindows,
        authToken: opts.authToken,
    };
}

/** One MCP tool: observed-schema metadata plus its (host-bound) handler. */
export interface McpTool {
    name: string;
    description: string;
    inputSchema: object;
    /** Returns the JSON payload to pretty-print into the text content block. */
    run(args: Record<string, unknown>): Promise<unknown>;
}

interface JsonRpcRequest {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
}

/**
 * A minimal MCP server core: one method turns an inbound JSON-RPC message
 * into the JSON string to send back (or null for notifications/no reply).
 * Deliberately not the MCP SDK — the endpoint needs exactly four methods over
 * one transport, and a dependency-free dispatcher keeps the surface auditable.
 */
export class McpCore {
    constructor(
        private readonly serverName: string,
        private readonly serverVersion: string,
        private readonly tools: readonly McpTool[],
    ) {}

    async handle(raw: string): Promise<string | null> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return this._error(null, -32700, "Parse error");
        }
        // Valid JSON that isn't a request object (`null`, a number, a batch
        // array — none of which the CLI sends) answers -32600 rather than
        // being dereferenced or silently dropped. Batches are deliberately
        // unsupported: an error reply beats a hang.
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return this._error(null, -32600, "Invalid request");
        }
        const msg = parsed as JsonRpcRequest;
        const id = msg.id;
        // Notifications (no id) expect no response, whatever the method.
        if (id === undefined || id === null) { return null; }
        switch (msg.method) {
            case "initialize":
                return this._result(id, {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: this.serverName, version: this.serverVersion },
                });
            case "ping":
                return this._result(id, {});
            case "tools/list":
                return this._result(id, {
                    tools: this.tools.map(({ name, description, inputSchema }) => ({
                        name,
                        description,
                        inputSchema,
                    })),
                });
            case "tools/call":
                return this._callTool(id, msg.params);
            default:
                return this._error(id, -32601, `Method not found: ${msg.method ?? "(none)"}`);
        }
    }

    private async _callTool(
        id: number | string,
        params: Record<string, unknown> | undefined,
    ): Promise<string> {
        const name = typeof params?.name === "string" ? params.name : undefined;
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) {
            return this._error(id, -32602, `Unknown tool: ${name ?? "(none)"}`);
        }
        const args =
            params?.arguments && typeof params.arguments === "object"
                ? (params.arguments as Record<string, unknown>)
                : {};
        try {
            const payload = await tool.run(args);
            return this._result(id, {
                content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            });
        } catch (err) {
            // A thrown handler (as opposed to a returned {success: false}
            // payload) is unexpected; surface it as a tool-level error result
            // so the client's session survives.
            const message = err instanceof Error ? err.message : String(err);
            return this._result(id, {
                content: [{ type: "text", text: JSON.stringify({ success: false, message }, null, 2) }],
                isError: true,
            });
        }
    }

    private _result(id: number | string, result: unknown): string {
        return JSON.stringify({ jsonrpc: "2.0", id, result });
    }

    private _error(id: number | string | null, code: number, message: string): string {
        return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
    }
}
