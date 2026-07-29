/**
 * The pure protocol half of the Claude Code IDE endpoint: upgrade
 * authorization, the lockfile payload, and the MCP dispatcher — everything a
 * misbehaving or malicious local client could send, without a socket.
 */
import { describe, it, expect } from "vitest";
import {
    IDE_AUTH_HEADER,
    MCP_PROTOCOL_VERSION,
    McpCore,
    authorizesUpgrade,
    buildLockfilePayload,
    type McpTool,
} from "../agentBridge/claudeIde/protocol";

const TOKEN = "test-token-abc";

describe("authorizesUpgrade", () => {
    it("the exact token with no Origin should authorize", () => {
        expect(authorizesUpgrade({ [IDE_AUTH_HEADER]: TOKEN }, TOKEN)).toBe(true);
    });

    it("a wrong token should reject", () => {
        expect(authorizesUpgrade({ [IDE_AUTH_HEADER]: "nope" }, TOKEN)).toBe(false);
    });

    it("a missing header should reject", () => {
        expect(authorizesUpgrade({}, TOKEN)).toBe(false);
    });

    it("an array-valued header should reject", () => {
        expect(authorizesUpgrade({ [IDE_AUTH_HEADER]: [TOKEN, TOKEN] }, TOKEN)).toBe(false);
    });

    it("an empty token should reject even when both sides agree", () => {
        expect(authorizesUpgrade({ [IDE_AUTH_HEADER]: "" }, "")).toBe(false);
    });

    it("any Origin header should reject even with the right token (browser exclusion)", () => {
        expect(
            authorizesUpgrade({ [IDE_AUTH_HEADER]: TOKEN, origin: "https://evil.example" }, TOKEN),
        ).toBe(false);
        // An empty Origin is still a browser fingerprint (e.g. sandboxed iframes).
        expect(authorizesUpgrade({ [IDE_AUTH_HEADER]: TOKEN, origin: "" }, TOKEN)).toBe(false);
        // The legacy origin header counts too.
        expect(
            authorizesUpgrade(
                { [IDE_AUTH_HEADER]: TOKEN, "sec-websocket-origin": "https://evil.example" },
                TOKEN,
            ),
        ).toBe(false);
    });
});

describe("buildLockfilePayload", () => {
    it("the payload should carry the CLI's observed field set with our ideName", () => {
        const payload = buildLockfilePayload({
            pid: 123,
            workspaceFolders: ["/w"],
            authToken: "t",
            runningInWindows: false,
        });
        expect(payload).toEqual({
            pid: 123,
            workspaceFolders: ["/w"],
            ideName: "Birta Writer",
            transport: "ws",
            runningInWindows: false,
            authToken: "t",
        });
    });
});

function makeCore(tools: McpTool[] = []): McpCore {
    return new McpCore("Birta Writer MCP", "1.2.3", tools);
}

const echoTool: McpTool = {
    name: "echo",
    description: "echo",
    inputSchema: { type: "object", properties: {} },
    run: async (args) => ({ success: true, got: args }),
};

async function roundTrip(core: McpCore, msg: object): Promise<Record<string, unknown>> {
    const reply = await core.handle(JSON.stringify(msg));
    expect(reply).not.toBeNull();
    return JSON.parse(reply!) as Record<string, unknown>;
}

describe("McpCore", () => {
    it("initialize should answer the observed protocol version and server info", async () => {
        const reply = await roundTrip(makeCore(), {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: {} },
        });
        expect(reply.result).toEqual({
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "Birta Writer MCP", version: "1.2.3" },
        });
    });

    it("notifications (no id) should get no reply", async () => {
        const core = makeCore();
        expect(await core.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    });

    it("ping should answer an empty result", async () => {
        const reply = await roundTrip(makeCore(), { jsonrpc: "2.0", id: 7, method: "ping" });
        expect(reply).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    });

    it("tools/list should surface name/description/inputSchema and omit the handler", async () => {
        const reply = await roundTrip(makeCore([echoTool]), {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
        });
        expect(reply.result).toEqual({
            tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }],
        });
    });

    it("tools/call should wrap the payload as pretty-printed JSON text content", async () => {
        const reply = await roundTrip(makeCore([echoTool]), {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "echo", arguments: { a: 1 } },
        });
        const result = reply.result as { content: [{ type: string; text: string }] };
        expect(result.content[0].type).toBe("text");
        expect(JSON.parse(result.content[0].text)).toEqual({ success: true, got: { a: 1 } });
    });

    it("an unknown tool should answer -32602", async () => {
        const reply = await roundTrip(makeCore([echoTool]), {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "nope", arguments: {} },
        });
        expect((reply.error as { code: number }).code).toBe(-32602);
    });

    it("a throwing handler should answer an isError tool result, not kill the session", async () => {
        const bad: McpTool = { ...echoTool, name: "bad", run: async () => { throw new Error("boom"); } };
        const reply = await roundTrip(makeCore([bad]), {
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "bad", arguments: {} },
        });
        const result = reply.result as { isError: boolean; content: [{ text: string }] };
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual({ success: false, message: "boom" });
    });

    it("an unknown method should answer -32601", async () => {
        const reply = await roundTrip(makeCore(), { jsonrpc: "2.0", id: 6, method: "resources/list" });
        expect((reply.error as { code: number }).code).toBe(-32601);
    });

    it("unparseable input should answer -32700 with a null id", async () => {
        const reply = JSON.parse((await makeCore().handle("{not json"))!) as Record<string, unknown>;
        expect(reply.id).toBeNull();
        expect((reply.error as { code: number }).code).toBe(-32700);
    });

    it("valid JSON that is not a request object should answer -32600, never throw or hang", async () => {
        const core = makeCore([echoTool]);
        for (const raw of ["null", "42", '"hi"', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]']) {
            const reply = JSON.parse((await core.handle(raw))!) as Record<string, unknown>;
            expect((reply.error as { code: number }).code, raw).toBe(-32600);
        }
    });

    it("an id of 0 should be treated as a request, not a notification", async () => {
        const reply = await roundTrip(makeCore(), { jsonrpc: "2.0", id: 0, method: "ping" });
        expect(reply).toEqual({ jsonrpc: "2.0", id: 0, result: {} });
    });
});
