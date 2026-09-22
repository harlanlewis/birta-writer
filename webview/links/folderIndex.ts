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
 */
import { hostHas } from "../../shared/hostProfile";
import { backlinksOf, relativeNotePath, type FolderEdge, type FolderIndex } from "../../shared/folderIndex";
import { notifyOpenFile, notifyOpenProjectFile, notifyRequestFolderIndex } from "../messaging";

/** Dispatched on `window` whenever a new index arrives. */
export const FOLDER_INDEX_CHANGED = "birta:folder-index-changed";

export interface FolderIndexState {
    index: FolderIndex | null;
    /** This document's path in `index`, or null when the index does not hold it. */
    self: string | null;
}

let requested = false;
let current: FolderIndexState | null = null;

/**
 * The latest index the host sent, or null before the first answer (and
 * always, on a host that has none to give). The first call asks for it.
 */
export function readFolderIndex(): FolderIndexState | null {
    if (!requested && hostHas("folderIndex")) {
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
 * `self`; `%` and `#` are escaped so a file name holding either is not read
 * as a fragment, since the host's resolver tries the decoded form after the
 * literal one.
 *
 * A host with a file explorer (`projectFiles`, the Mac app's directory
 * windows) opens a root-relative path directly and parses no `openFile`,
 * because it has no text editor to open one into; its index is of the same
 * root, so the path goes as the index names it. `openProjectFile` carries no
 * line, so there the note opens where it was last left rather than at the
 * reference (MAR-480).
 */
export function openIndexedNote(self: string, path: string, line?: number): void {
    if (hostHas("projectFiles")) {
        notifyOpenProjectFile(path, false);
        return;
    }
    const rel = relativeNotePath(self, path).replace(/%/g, "%25").replace(/#/g, "%23");
    notifyOpenFile(line === undefined ? rel : `${rel}#${line}`);
}

/** Test seam: forget the index and the request, as a fresh page would. */
export function resetFolderIndexForTests(): void {
    requested = false;
    current = null;
}
