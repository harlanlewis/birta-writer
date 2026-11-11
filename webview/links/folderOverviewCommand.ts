/**
 * webview/links/folderOverviewCommand.ts — what running `showFolderOverview`
 * does (MAR-488): load the graph's lazy chunk and open the folder overview
 * over the page, once.
 *
 * Once, because the command is reached from outside the page as well as from
 * inside it: a host palette and the Mac app's View menu are not under the
 * overview's modal surface, so a second run while one is open is an ordinary
 * gesture. It focuses the open one rather than stacking a second, and two runs
 * that both start before the chunk has loaded open one between them.
 *
 * A chunk that fails to load is tolerated and the next run retries, as every
 * lazy loader here does. A failure while OPENING is not swallowed: it rejects,
 * and the caller's `void` leaves it to the crash reporter's unhandled-rejection
 * handler (webview/crashReporter.ts), which is where a broken view belongs.
 *
 * `showStartView` is the same view as a window's empty state: pinned, with no
 * folder sections, opened when the host says the window holds no file.
 */
import { loadLocalGraph } from "../utils/localGraphLoader";
import type { FolderOverviewHandle } from "../components/graph/folderOverview";
import { openIndexedNote, readFolderIndex } from "./folderIndex";

export interface FolderOverviewCommandDeps {
    /** Where focus goes when the overview is dismissed without opening a note. */
    focusEditor: () => void;
    /** The chunk loader; a seam for tests. */
    load?: typeof loadLocalGraph;
}

let current: FolderOverviewHandle | null = null;
let opening: Promise<void> | null = null;

export function showFolderOverview(deps: FolderOverviewCommandDeps): Promise<void> {
    if (current?.isOpen()) {
        current.focus();
        return Promise.resolve();
    }
    if (opening) { return opening; }
    const run = (deps.load ?? loadLocalGraph)().then(
        (mod) => {
            const launcher = mod.hostLauncher();
            current = mod.openFolderOverview({
                openNote: (path) => openIndexedNote(readFolderIndex()?.self ?? null, path),
                onDismiss: deps.focusEditor,
                ...(launcher ? { launcher } : {}),
            });
        },
        () => { /* the chunk did not load: not cached, so the next run retries */ },
    ).finally(() => { opening = null; });
    opening = run;
    return run;
}

/**
 * The window holds no file: the start view, pinned, with no folder in it.
 * Once per page, like the overview; a second call while it is up focuses it.
 * A dismissible overview already up is closed first, because the window it was
 * a view over no longer holds a file.
 */
export function showStartView(deps: Pick<FolderOverviewCommandDeps, "load"> = {}): Promise<void> {
    if (startView?.isOpen()) {
        startView.focus();
        return Promise.resolve();
    }
    return (deps.load ?? loadLocalGraph)().then(
        (mod) => {
            if (startView?.isOpen()) { return; }
            current?.close();
            const launcher = mod.hostLauncher();
            startView = mod.openFolderOverview({
                openNote: () => {},
                onDismiss: () => {},
                empty: true,
                ...(launcher ? { launcher } : {}),
            });
        },
        () => { /* the chunk did not load: not cached, so the next run retries */ },
    );
}

let startView: FolderOverviewHandle | null = null;

/** Test seam: forget any overview, as a fresh page would. */
export function _resetFolderOverviewForTests(): void {
    current?.close();
    current = null;
    opening = null;
    startView?.close();
    startView = null;
}
