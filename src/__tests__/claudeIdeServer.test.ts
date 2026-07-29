/**
 * The IDE endpoint's transport, exercised for real: a live loopback server, a
 * live `ws` client, and the exact handshake sequence the `claude` CLI was
 * observed performing against the official IDE server (initialize →
 * notifications/initialized → tools/list → tools/call). Lockfiles land in a
 * throwaway temp dir standing in for `~/.claude`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import {
    publishLockfile,
    startClaudeIdeServer,
    sweepStaleLockfiles,
    type ClaudeIdeServer,
} from "../agentBridge/claudeIde/server";
import { IDE_AUTH_HEADER, type LockfilePayload } from "../agentBridge/claudeIde/protocol";
import type { IdeHost, IdeSelectionPayload } from "../agentBridge/claudeIde/tools";

const SELECTION: IdeSelectionPayload = {
    text: "hello",
    filePath: "/w/doc.md",
    fileUrl: "file:///w/doc.md",
    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 }, isEmpty: false },
};

const host: IdeHost = {
    getSelection: async () => SELECTION,
    listOpenEditors: () => [],
    workspaceFolders: () => ({ folders: [], rootPath: null }),
    openFile: async () => ({ success: true, message: "ok" }),
    documentDirty: () => null,
    saveDocument: async () => ({ success: true, message: "ok" }),
    diagnostics: () => [],
};

let configDir: string;
let server: ClaudeIdeServer | null = null;

function readLockfile(server: ClaudeIdeServer): LockfilePayload {
    return JSON.parse(fs.readFileSync(server.lockfilePath, "utf8")) as LockfilePayload;
}

function connect(server: ClaudeIdeServer, headers: Record<string, string>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers });
        socket.on("open", () => resolve(socket));
        socket.on("error", reject);
    });
}

function rpc(socket: WebSocket, msg: object): Promise<Record<string, unknown>> {
    const id = (msg as { id?: number }).id;
    return new Promise((resolve, reject) => {
        const onMessage = (data: WebSocket.RawData): void => {
            const parsed = JSON.parse(String(data)) as Record<string, unknown>;
            if (parsed.id === id) {
                socket.off("message", onMessage);
                resolve(parsed);
            }
        };
        socket.on("message", onMessage);
        socket.on("error", reject);
        socket.send(JSON.stringify(msg));
    });
}

beforeEach(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "birta-ide-test-"));
    server = await startClaudeIdeServer({
        host,
        configDir,
        workspaceFolders: ["/w"],
        pid: process.pid,
        serverVersion: "0.0.0-test",
    });
});

afterEach(async () => {
    await server?.dispose();
    server = null;
    fs.rmSync(configDir, { recursive: true, force: true });
});

describe("startClaudeIdeServer", () => {
    it("starting should publish a 0600 lockfile naming the bound port inside a 0700 ide dir", () => {
        const payload = readLockfile(server!);
        expect(path.basename(server!.lockfilePath)).toBe(`${server!.port}.lock`);
        expect(payload.ideName).toBe("Birta Writer");
        expect(payload.workspaceFolders).toEqual(["/w"]);
        expect(payload.pid).toBe(process.pid);
        expect(payload.transport).toBe("ws");
        expect(payload.authToken).toMatch(/^[0-9a-f-]{36}$/);
        expect(fs.statSync(server!.lockfilePath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(server!.lockfilePath)).mode & 0o777).toBe(0o700);
    });

    it("the CLI's observed handshake should reach a tool answer end-to-end", async () => {
        const { authToken } = readLockfile(server!);
        const socket = await connect(server!, { [IDE_AUTH_HEADER]: authToken });
        try {
            const init = await rpc(socket, {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
            });
            expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
                "Birta Writer MCP",
            );
            socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
            const list = await rpc(socket, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
            const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
            expect(names).toContain("getCurrentSelection");
            expect(names).toContain("openFile");
            const call = await rpc(socket, {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "getCurrentSelection", arguments: {} },
            });
            const content = (call.result as { content: [{ text: string }] }).content[0];
            expect(JSON.parse(content.text)).toEqual({ success: true, ...SELECTION });
        } finally {
            socket.close();
        }
    });

    it("a wrong token should be refused at the upgrade", async () => {
        await expect(connect(server!, { [IDE_AUTH_HEADER]: "wrong" })).rejects.toThrow(/401/);
    });

    it("a browser-style connection (Origin header) should be refused even with the token", async () => {
        const { authToken } = readLockfile(server!);
        await expect(
            connect(server!, { [IDE_AUTH_HEADER]: authToken, origin: "https://evil.example" }),
        ).rejects.toThrow(/401/);
    });

    it("dispose should remove the lockfile and stop accepting connections", async () => {
        const { authToken } = readLockfile(server!);
        const lockfilePath = server!.lockfilePath;
        const port = server!.port;
        await server!.dispose();
        server = null;
        expect(fs.existsSync(lockfilePath)).toBe(false);
        await expect(
            new Promise((resolve, reject) => {
                const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
                    headers: { [IDE_AUTH_HEADER]: authToken },
                });
                socket.on("open", resolve);
                socket.on("error", reject);
            }),
        ).rejects.toThrow();
    });
});

describe("startClaudeIdeServer hardening", () => {
    it("a pre-existing world-readable ide dir should be tightened to 0700", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "birta-ide-perm-"));
        fs.mkdirSync(path.join(dir, "ide"), { mode: 0o755 });
        const second = await startClaudeIdeServer({
            host,
            configDir: dir,
            workspaceFolders: ["/w"],
            pid: process.pid,
            serverVersion: "0.0.0-test",
        });
        try {
            expect(fs.statSync(path.join(dir, "ide")).mode & 0o777).toBe(0o700);
        } finally {
            await second.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("an unpublishable lockfile should reject the start and close the socket (no leak)", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "birta-ide-fail-"));
        // configDir/ide exists as a FILE → mkdir/publish must throw.
        fs.writeFileSync(path.join(dir, "ide"), "not a dir");
        type Handle = { constructor: { name: string }; listening?: boolean };
        const listeners = (): number =>
            (process as unknown as { _getActiveHandles(): Handle[] })
                ._getActiveHandles()
                .filter((h) => h.constructor.name === "Server" && h.listening === true).length;
        const before = listeners();
        await expect(
            startClaudeIdeServer({
                host,
                configDir: dir,
                workspaceFolders: ["/w"],
                pid: process.pid,
                serverVersion: "0.0.0-test",
            }),
        ).rejects.toThrow();
        expect(listeners()).toBe(before);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("a JSON `null` payload should answer -32600 and leave the connection serving", async () => {
        const { authToken } = readLockfile(server!);
        const socket = await connect(server!, { [IDE_AUTH_HEADER]: authToken });
        try {
            const reply = await new Promise<Record<string, unknown>>((resolve) => {
                socket.once("message", (data) => resolve(JSON.parse(String(data))));
                socket.send("null");
            });
            expect((reply.error as { code: number }).code).toBe(-32600);
            // The session survived: a normal request still answers.
            const ping = await rpc(socket, { jsonrpc: "2.0", id: 9, method: "ping" });
            expect(ping).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
        } finally {
            socket.close();
        }
    });

    it("an over-limit frame should drop that client without killing the server", async () => {
        const { authToken } = readLockfile(server!);
        const offender = await connect(server!, { [IDE_AUTH_HEADER]: authToken });
        await new Promise<void>((resolve) => {
            offender.on("close", () => resolve());
            // 2 MiB > the server's 1 MiB maxPayload → ws emits `error`
            // server-side; our handler terminates the offender only.
            offender.send("x".repeat(2 * 1024 * 1024));
        });
        const survivor = await connect(server!, { [IDE_AUTH_HEADER]: authToken });
        try {
            const ping = await rpc(survivor, { jsonrpc: "2.0", id: 10, method: "ping" });
            expect(ping).toEqual({ jsonrpc: "2.0", id: 10, result: {} });
        } finally {
            survivor.close();
        }
    });
});

describe("publishLockfile", () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "birta-lock-"));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const payload = {
        pid: process.pid,
        workspaceFolders: ["/w"],
        ideName: "Birta Writer" as const,
        transport: "ws" as const,
        runningInWindows: false,
        authToken: "fresh-token",
    };

    it("a dead-owner leftover should be replaced and the 0600 mode restored", () => {
        const file = path.join(dir, "1234.lock");
        const deadPid = spawnSync("true").pid!;
        fs.writeFileSync(file, JSON.stringify({ ideName: "Other IDE", pid: deadPid, authToken: "old" }), {
            mode: 0o644,
        });
        publishLockfile(file, payload);
        expect(JSON.parse(fs.readFileSync(file, "utf8")).authToken).toBe("fresh-token");
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it("an unparseable leftover at our port should be replaced", () => {
        const file = path.join(dir, "1234.lock");
        fs.writeFileSync(file, "{junk", { mode: 0o644 });
        publishLockfile(file, payload);
        expect(JSON.parse(fs.readFileSync(file, "utf8")).authToken).toBe("fresh-token");
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it("a live-owner lockfile should never be overwritten", () => {
        const file = path.join(dir, "1234.lock");
        const original = JSON.stringify({ ideName: "Visual Studio Code", pid: process.pid, authToken: "theirs" });
        fs.writeFileSync(file, original, { mode: 0o644 });
        expect(() => publishLockfile(file, payload)).toThrow(/live process/);
        expect(fs.readFileSync(file, "utf8")).toBe(original);
    });
});

describe("sweepStaleLockfiles", () => {
    it("a dead Birta lockfile should be removed while foreign and live ones survive", async () => {
        const ideDir = path.join(configDir, "ide");
        // A provably dead pid: a child we spawned and already reaped.
        const deadPid = spawnSync("true").pid!;
        fs.writeFileSync(
            path.join(ideDir, "1111.lock"),
            JSON.stringify({ ideName: "Birta Writer", pid: deadPid, authToken: "x" }),
        );
        // The official extension's lockfile: never touched, dead pid or not.
        fs.writeFileSync(
            path.join(ideDir, "2222.lock"),
            JSON.stringify({ ideName: "Visual Studio Code", pid: deadPid, authToken: "y" }),
        );
        // A live Birta lockfile (our own pid): kept.
        fs.writeFileSync(
            path.join(ideDir, "3333.lock"),
            JSON.stringify({ ideName: "Birta Writer", pid: process.pid, authToken: "z" }),
        );
        // Unparseable: left alone.
        fs.writeFileSync(path.join(ideDir, "4444.lock"), "{not json");
        // Alive but not ours (pid 1 → EPERM, not ESRCH): must survive — only
        // proven-dead pids may be swept.
        fs.writeFileSync(
            path.join(ideDir, "5555.lock"),
            JSON.stringify({ ideName: "Birta Writer", pid: 1, authToken: "w" }),
        );

        sweepStaleLockfiles(ideDir);

        expect(fs.existsSync(path.join(ideDir, "1111.lock"))).toBe(false);
        expect(fs.existsSync(path.join(ideDir, "2222.lock"))).toBe(true);
        expect(fs.existsSync(path.join(ideDir, "3333.lock"))).toBe(true);
        expect(fs.existsSync(path.join(ideDir, "4444.lock"))).toBe(true);
        expect(fs.existsSync(path.join(ideDir, "5555.lock"))).toBe(true);
    });
});
