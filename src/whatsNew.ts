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
import { compareVersions, hasUnseenSignificantRelease } from "../shared/whatsNew";
import { readBirtaSetting } from "./config";

/**
 * Versioned so a future change to what is stored (a timestamp, a digest) does
 * not have to interpret this shape.
 */
const LAST_SEEN_KEY = "birta.whatsNew.lastSeenVersion.v1";

/**
 * The installed build, or undefined if the host does not report one.
 *
 * `0.0.0` counts as no version: it is the unstamped local build (`package.json`
 * stays at `0.0.0`; CI stamps a CalVer only at release). A local build must
 * neither light the dot nor STAMP, because the memento is per install and can
 * be shared with a Marketplace copy; a first run that stamped `0.0.0` would
 * make the next real activation see every historical Security release as
 * unseen.
 */
function installedVersion(context: vscode.ExtensionContext): string | undefined {
    const version: unknown = context.extension?.packageJSON?.version;
    if (typeof version !== "string" || version.length === 0 || version === "0.0.0") { return undefined; }
    return version;
}

function lastSeen(context: vscode.ExtensionContext): string | undefined {
    const stored: unknown = context.globalState?.get?.(LAST_SEEN_KEY);
    return typeof stored === "string" ? stored : undefined;
}

/**
 * Record the installed build as seen. Called when the settings dropdown OPENS,
 * not when the What's-new row is clicked: the dot's contract is "there is
 * something you have not looked at", and opening the menu is the looking.
 *
 * The stamp never moves BACKWARDS. "Seen" is a high-water mark: a build the
 * user has already looked past stays looked past, so a downgrade, or a
 * `0.0.0` local install sharing this memento with a Marketplace one, cannot
 * lower it and re-light the dot for releases they have already read on the
 * way back up.
 */
export async function markSeen(context: vscode.ExtensionContext): Promise<void> {
    const installed = installedVersion(context);
    if (!installed || !context.globalState?.update) { return; }
    const seen = lastSeen(context);
    if (seen !== undefined && compareVersions(installed, seen) < 0) { return; }
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

    const changelog = await readChangelog(context);
    if (changelog === null) { return false; }
    if (hasUnseenSignificantRelease(changelog, seen, installed)) { return true; }
    // Nothing worth a dot between seen and installed. Stamp installed so the
    // next activation short-circuits above instead of re-reading and
    // re-parsing the changelog for a verdict that cannot change until the
    // build does. Safe because a later release falls in the new window either
    // way; the user has not looked at anything, and had nothing to look at.
    await markSeen(context);
    return false;
}

/**
 * The shipped changelog's names, in the order they are tried.
 *
 * `vsce` LOWERCASES the well-known root documents when it packages: the VSIX
 * holds `changelog.md` and `readme.md`, whatever the repository calls them. On
 * a case-insensitive filesystem, which macOS is by default, reading
 * `CHANGELOG.md` out of an installed extension therefore works by luck; on a
 * case-sensitive one it does not, and the dot would simply never light, with no
 * error anywhere because this feature is required to fail quiet.
 *
 * The capitalized name is second because it is what the repository holds, which
 * is what `extensionUri` points at under an Extension Development Host.
 *
 * Verified by packaging and reading the file list, not by assuming either.
 */
const CHANGELOG_NAMES = ["changelog.md", "CHANGELOG.md"] as const;

/** The shipped changelog's text, or null if none of its names is readable. */
async function readChangelog(context: vscode.ExtensionContext): Promise<string | null> {
    for (const name of CHANGELOG_NAMES) {
        try {
            const uri = vscode.Uri.joinPath(context.extensionUri, name);
            return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
            // Try the next spelling. An extension with no readable changelog at
            // all is a dark dot, never an error the user sees.
        }
    }
    return null;
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
