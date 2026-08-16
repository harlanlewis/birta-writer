/**
 * The unread-release indicator's host half: what the user last saw, and what
 * the shipped CHANGELOG says landed since.
 *
 * The predicate itself is pure and lives in `shared/whatsNew.ts`, with the
 * reasoning for the significance bar. This file owns only the two things that
 * need a host: the per-install memento and reading the CHANGELOG out of the
 * installed extension.
 *
 * `globalState`, not `workspaceState`: "have I seen this release" is a property
 * of the install, not of a folder. It is the first `globalState` use here, and
 * it follows the `workspaceState` conventions already documented on
 * `MarkdownEditorProvider` — a versioned key, optional-chained access, and
 * degrading rather than throwing when a host hands us a context without one.
 *
 * Nothing in here may run on the mount path. The read is async and fires once
 * per activation, off the critical path; the dot is advisory chrome that
 * appears, waits, and does nothing on its own, so arriving a beat late costs
 * nothing. A user who has turned the indicator off pays no read at all.
 */
import * as vscode from "vscode";
import { hasUnseenSignificantRelease } from "../shared/whatsNew";
import { readBirtaSetting } from "./config";

/**
 * Versioned so a future change to what is stored (a timestamp, a digest) does
 * not have to interpret this shape.
 */
const LAST_SEEN_KEY = "birta.whatsNew.lastSeenVersion.v1";

/** The installed build, or undefined if the host does not report one. */
function installedVersion(context: vscode.ExtensionContext): string | undefined {
    const version: unknown = context.extension?.packageJSON?.version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
}

function lastSeen(context: vscode.ExtensionContext): string | undefined {
    const stored: unknown = context.globalState?.get?.(LAST_SEEN_KEY);
    return typeof stored === "string" ? stored : undefined;
}

/**
 * Record the installed build as seen. Called when the settings dropdown OPENS,
 * not when the What's-new row is clicked: the dot's contract is "there is
 * something you have not looked at", and opening the menu is the looking.
 */
export async function markSeen(context: vscode.ExtensionContext): Promise<void> {
    const installed = installedVersion(context);
    if (!installed || !context.globalState?.update) { return; }
    await context.globalState.update(LAST_SEEN_KEY, installed);
}

/**
 * Whether the gear should carry a dot.
 *
 * A fresh install is never unread, and it stamps the installed version on the
 * way past so the NEXT update is the first signal the user ever gets. That
 * write is why this returns a promise the caller should await before posting.
 */
export async function computeUnread(context: vscode.ExtensionContext): Promise<boolean> {
    const installed = installedVersion(context);
    if (!installed) { return false; }

    const seen = lastSeen(context);
    if (seen === undefined) {
        // First run on this install: silent, and the clock starts here.
        await markSeen(context);
        return false;
    }
    if (seen === installed) { return false; }

    let changelog: string;
    try {
        const uri = vscode.Uri.joinPath(context.extensionUri, "CHANGELOG.md");
        changelog = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
        // A VSIX without a readable CHANGELOG is a dark dot, never an error the
        // user sees: this feature is advisory and must not fail an activation.
        return false;
    }
    return hasUnseenSignificantRelease(changelog, seen, installed);
}

/**
 * The last computed answer, so a webview opening later can be told without
 * re-reading anything. A webview is created and destroyed on every switch to
 * and from the raw editor, and the answer cannot change in between.
 */
let cachedUnread = false;

export function unreadNow(): boolean {
    return cachedUnread;
}

/**
 * Recompute and cache. A user who has turned the indicator off pays no
 * memento read and no file read: a disabled feature costs nothing.
 */
export async function refreshUnread(context: vscode.ExtensionContext): Promise<boolean> {
    cachedUnread = readBirtaSetting("whatsNewIndicator") ? await computeUnread(context) : false;
    return cachedUnread;
}

/** The menu was opened: stamp the version and drop the dot. */
export async function acknowledgeSeen(context: vscode.ExtensionContext): Promise<void> {
    cachedUnread = false;
    await markSeen(context);
}
