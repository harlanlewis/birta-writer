/**
 * The unread-dot's host half: the memento, and reading the shipped changelog.
 *
 * The predicate itself is pure and tested in `shared/__tests__/whatsNew.test.ts`.
 * What can only be tested here is the part that talks to a host, and one detail
 * of it is a trap that no amount of local running would surface.
 *
 * `vsce` LOWERCASES the well-known root documents when it packages: an
 * installed extension holds `changelog.md`, not `CHANGELOG.md`, exactly as it
 * holds `readme.md`. macOS is case-insensitive by default, so reading the
 * capitalized name works there by luck and fails on a case-sensitive
 * filesystem, with no error anywhere because this feature must fail quiet. It
 * would simply never light. Found by packaging a VSIX and reading its file
 * list, and pinned here so it cannot come back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { computeUnread, markSeen } from "../whatsNew";

const CHANGELOG = `# Changelog

## [Unreleased]

## [2026.814.0] - 2026, August 14

### Security

- A real one.

## [2026.813.0] - 2026, August 13

### Added

- A feature.
`;

const readFile = vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>;

/** A host whose extension directory holds the changelog under `name` only. */
function makeContext(opts: {
    version?: string;
    lastSeen?: string | undefined;
    name?: string;
}): { context: vscode.ExtensionContext; update: ReturnType<typeof vi.fn> } {
    const update = vi.fn(() => Promise.resolve());
    readFile.mockImplementation((uri: vscode.Uri) => {
        if (opts.name && uri.fsPath.endsWith(opts.name)) {
            return Promise.resolve(Buffer.from(CHANGELOG, "utf8"));
        }
        return Promise.reject(new Error("ENOENT"));
    });
    return {
        update,
        context: {
            extensionUri: vscode.Uri.file("/ext"),
            extension: { packageJSON: { version: opts.version ?? "2026.814.0" } },
            globalState: { get: vi.fn(() => opts.lastSeen), update },
        } as unknown as vscode.ExtensionContext,
    };
}

describe("the unread dot's host half", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a changelog packaged as lowercase changelog.md should be read", async () => {
        // THE REGRESSION THIS FILE EXISTS FOR. This is the name an installed
        // extension actually has.
        const { context } = makeContext({ lastSeen: "2026.813.0", name: "changelog.md" });
        expect(await computeUnread(context)).toBe(true);
    });

    it("a changelog under the repository's CHANGELOG.md should be read too", async () => {
        // The Extension Development Host points extensionUri at the repo.
        const { context } = makeContext({ lastSeen: "2026.813.0", name: "CHANGELOG.md" });
        expect(await computeUnread(context)).toBe(true);
    });

    it("no readable changelog should be a dark dot rather than a thrown activation", async () => {
        const { context } = makeContext({ lastSeen: "2026.813.0", name: undefined });
        await expect(computeUnread(context)).resolves.toBe(false);
    });

    it("a fresh install should be silent and stamp the version so the NEXT update signals", async () => {
        const { context, update } = makeContext({ lastSeen: undefined, name: "changelog.md" });
        expect(await computeUnread(context)).toBe(false);
        expect(update).toHaveBeenCalledWith(expect.any(String), "2026.814.0");
    });

    it("an already-seen installed version should not read the changelog at all", async () => {
        // A disabled or answered feature costs nothing: no file read.
        const { context } = makeContext({ lastSeen: "2026.814.0", name: "changelog.md" });
        expect(await computeUnread(context)).toBe(false);
        expect(readFile).not.toHaveBeenCalled();
    });

    it("a host reporting no version should be silent rather than guessing", async () => {
        const { context } = makeContext({ version: "", lastSeen: "2026.813.0", name: "changelog.md" });
        expect(await computeUnread(context)).toBe(false);
    });

    it("a quiet upgrade should stamp the installed version so later activations skip the read", async () => {
        // 2026.813.0 -> 2026.814.0 where nothing between is significant would
        // otherwise re-read and re-parse the changelog on every activation
        // until the user happened to open the gear menu.
        const { context, update } = makeContext({ version: "2026.815.0", lastSeen: "2026.814.0", name: "changelog.md" });
        expect(await computeUnread(context)).toBe(false);
        expect(update).toHaveBeenCalledWith(expect.any(String), "2026.815.0");
    });

    it("an unread significant release should NOT stamp, or the dot would clear itself", async () => {
        const { context, update } = makeContext({ lastSeen: "2026.813.0", name: "changelog.md" });
        expect(await computeUnread(context)).toBe(true);
        expect(update).not.toHaveBeenCalled();
    });

    it("markSeen should never move the high-water mark backwards", async () => {
        // A downgrade, or a 0.0.0 local build sharing the memento with a
        // Marketplace install, would otherwise re-light the dot for releases
        // the user already read once the newer build is back.
        const older = makeContext({ version: "2026.810.0", lastSeen: "2026.814.0", name: "changelog.md" });
        await markSeen(older.context);
        expect(older.update).not.toHaveBeenCalled();
        expect(await computeUnread(older.context)).toBe(false);
        expect(older.update).not.toHaveBeenCalled();

        const local = makeContext({ version: "0.0.0", lastSeen: "2026.814.0", name: "changelog.md" });
        await markSeen(local.context);
        expect(local.update).not.toHaveBeenCalled();
    });

    it("an unstamped 0.0.0 local build should neither light nor stamp, even on first run", async () => {
        // The memento can be shared with a Marketplace install; a 0.0.0 stamp
        // would make that install see every historical Security release as
        // unseen on its next activation.
        const { context, update } = makeContext({ version: "0.0.0", lastSeen: undefined, name: "changelog.md" });
        expect(await computeUnread(context)).toBe(false);
        expect(update).not.toHaveBeenCalled();
        await markSeen(context);
        expect(update).not.toHaveBeenCalled();
    });

    it("markSeen should degrade rather than throw when the host has no globalState", async () => {
        const context = {
            extensionUri: vscode.Uri.file("/ext"),
            extension: { packageJSON: { version: "2026.814.0" } },
        } as unknown as vscode.ExtensionContext;
        await expect(markSeen(context)).resolves.toBeUndefined();
    });
});
