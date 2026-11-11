/**
 * webview/links/folderIndex.ts — the page's copy of the host's folder index.
 *
 * The page cannot read another file, so everything it knows about the notes
 * around this one arrives as the host's `folderIndex` message
 * (shared/folderIndex.ts). This holds the latest one and says when it
 * changed. One webview hosts one document, so a module-level slot is the
 * right size, as in links/scan.ts.
 *
 * Nothing is asked for until something reads: the first read sends the one
 * `requestFolderIndex` that subscribes this page, and a host that does not
 * declare `folderIndex` is never asked at all. The review sidebar reads on its
 * idle visibility pass, which it skips while closed, so a sidebar nobody opens
 * costs the host no walk of the folder.
 *
 * Two gates, one question each. The capability says the host CAN answer; the
 * `folderGraph` setting says the editor asks (off by default in VS Code, on
 * in the Mac app's folder windows). With the setting off nothing is asked, so
 * the host walks no folder and reads no note, whatever it declared.
 */
import { setCommandsIdle } from "../../shared/commandAvailability";
import { hostHas } from "../../shared/hostProfile";
import { backlinksOf, relativeNotePath, type FolderEdge, type FolderIndex } from "../../shared/folderIndex";
import { notifyOpenFile, notifyOpenProjectFile, notifyRequestFolderIndex } from "../messaging";

/** Dispatched on `window` whenever a new index arrives. */
export const FOLDER_INDEX_CHANGED = "birta:folder-index-changed";
/**
 * Dispatched on `window` whenever the host answers `requestFolderRecents`,
 * the paths as its `detail`. Nothing keeps them: the one reader is an open
 * overview, which asks on opening and so is always open when they arrive.
 */
export const FOLDER_RECENTS_CHANGED = "birta:folder-recents-changed";

/**
 * Dispatched on `window` whenever the host answers `requestRecentFiles`, the
 * files as its `detail`. Kept by nobody, for the reason the folder's own
 * recent files are not: the one reader asks on opening.
 */
export const RECENT_FILES_CHANGED = "birta:recent-files-changed";

/** One of the reader's recent files, as the host words it. */
export interface RecentFile {
    path: string;
    name: string;
    detail: string;
}

/** The host's answer: the `recentFiles` message handler calls this. */
export function receiveRecentFiles(files: RecentFile[]): void {
    window.dispatchEvent(new CustomEvent(RECENT_FILES_CHANGED, { detail: files }));
}

/** The command that opens the folder overview (components/graph/folderOverview.ts). */
export const FOLDER_OVERVIEW_COMMAND = "showFolderOverview";

export interface FolderIndexState {
    index: FolderIndex | null;
    /** This document's path in `index`, or null when the index does not hold it. */
    self: string | null;
}

let requested = false;
let current: FolderIndexState | null = null;

/**
 * Mark the folder overview's command as having nothing to act on whenever
 * this page will never be sent an index: the setting is off, or the host has
 * no folder for this document. Returns whether that changed, so the caller
 * re-offers its command lists only when it must.
 *
 * The capability alone already withdraws the command (`hostHasCommand`), and
 * the second half is still asked, because a host menu that runs page commands
 * dims a row by the idle list and never sees the profile: the Mac app's View
 * menu row on a window with no folder (whose profile leaves `folderIndex` out)
 * would otherwise stay live and run nothing.
 */
export function syncFolderOverviewAvailability(): boolean {
    return setCommandsIdle([FOLDER_OVERVIEW_COMMAND], !(folderGraphEnabled() && hostHas("folderIndex")));
}

/** The host's answer: the `folderRecents` message handler calls this. */
export function receiveFolderRecents(paths: string[]): void {
    window.dispatchEvent(new CustomEvent(FOLDER_RECENTS_CHANGED, { detail: paths }));
}

/** Is the folder graph switched on for this page (birta.folderGraph)? */
export function folderGraphEnabled(): boolean {
    return window.__i18n?.folderGraph === true;
}

/**
 * The setting moved under this page (`setFolderGraph`). Off forgets the
 * index, so the tabs go on the next visibility pass and nothing asks again;
 * on lets the next read ask, as a fresh page would.
 */
export function setFolderGraphEnabled(enabled: boolean): boolean {
    // Every real page boots with a blob; the default is for a test page.
    const blob = (window.__i18n ??= { translations: {}, isMac: false });
    blob.folderGraph = enabled;
    requested = false;
    if (!enabled) { current = null; }
    window.dispatchEvent(new CustomEvent(FOLDER_INDEX_CHANGED));
    return syncFolderOverviewAvailability();
}

/**
 * The latest index the host sent, or null before the first answer (and
 * always, on a host that has none to give). The first call asks for it.
 */
export function readFolderIndex(): FolderIndexState | null {
    if (!requested && folderGraphEnabled() && hostHas("folderIndex")) {
        requested = true;
        notifyRequestFolderIndex();
    }
    return current;
}

/** The host's answer: the `folderIndex` message handler calls this. */
export function receiveFolderIndex(index: FolderIndex | null, self: string | null): void {
    current = { index, self };
    window.dispatchEvent(new CustomEvent(FOLDER_INDEX_CHANGED));
}

/** The references that point at this document, as far as the index knows. */
export function currentBacklinks(): FolderEdge[] {
    const state = readFolderIndex();
    if (!state?.index || state.self === null) { return []; }
    return backlinksOf(state.index, state.self);
}

/** Does the index hold any reference to or from this document, dangling ones included? */
export function selfHasReferences(): boolean {
    const state = readFolderIndex();
    if (!state?.index || state.self === null) { return false; }
    const self = state.self;
    return state.index.edges.some((e) => (e.from === self || e.to === self) && e.from !== e.to);
}

/**
 * Open the note at `path` (root-relative), at `line` when one is given: the
 * one route every view of the index opens a note by. `openFile` resolves a
 * path relative to the open document first, so the path is made relative to
 * `self`. A `#` in a file name would be read as the fragment, so a name
 * holding one is escaped (`%` too, then, so the escape is unambiguous), and
 * only smart link resolution decodes it back; a name without one goes
 * literally, which both resolution modes open.
 *
 * A host with a file explorer (`projectFiles`, the Mac app's directory
 * windows) opens a root-relative path directly: its index is of the same
 * root, so the path goes as the index names it, with nothing to resolve, and
 * the line rides beside it as the message's own optional field rather than
 * as a fragment, because its file names may hold `#`.
 *
 * A null `self` is a document the index does not hold (past its cap, or a
 * file the walk does not read), which a view of the whole folder can still be
 * opened from. There is nothing to be relative to, so the path goes
 * root-relative, with a leading `/`, which `openFile` resolves against the
 * workspace folder: the same folder the VS Code host indexes.
 */
export function openIndexedNote(self: string | null, path: string, line?: number): void {
    if (hostHas("projectFiles")) {
        notifyOpenProjectFile(path, false, line);
        return;
    }
    const plain = self === null ? `/${path}` : relativeNotePath(self, path);
    const rel = plain.includes("#") ? plain.replace(/%/g, "%25").replace(/#/g, "%23") : plain;
    notifyOpenFile(line === undefined ? rel : `${rel}#${line}`);
}

/** Test seam: forget the index and the request, as a fresh page would. */
export function resetFolderIndexForTests(): void {
    requested = false;
    current = null;
}
