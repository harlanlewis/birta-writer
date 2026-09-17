/**
 * Lazy loader for the file explorer (MAR-460).
 *
 * The panel exists only in a directory window on a host that declares
 * `projectFiles`, which no VS Code page is and most Mac windows are not. So
 * its module, the tree model, the row DOM, the keyboard wiring and its
 * stylesheet sit behind a dynamic `import()` in a chunk of their own
 * (`splitting: true` in esbuild.mjs), fetched on the first `projectRoot`
 * that names a folder. Every other launch evaluates none of it, which is the
 * standing rule for anything a surface may never turn on (AGENTS.md, Launch
 * performance). This module is what the eager graph holds instead, and it
 * imports only types and the one predicate.
 *
 * Messages that arrive while the chunk is on its way are buffered in order
 * and replayed into the panel once it exists: a host sends `projectRoot`,
 * then `currentProjectFile`, then answers the root listing, all inside the
 * chunk's fetch. A `projectRoot` with a null root empties the buffer and
 * takes the panel down, and a later non-null root builds it again.
 */
import { hostHas } from "../../shared/hostProfile";
import type { ProjectRoot } from "../../shared/messages";
import type {
    DirectoryListingMessage,
    FileExplorerController,
    FileExplorerHost,
} from "../components/fileExplorer";

export type FileExplorerDeps = Pick<FileExplorerHost, "eventManager" | "getEditorView" | "neighborReserve" | "onReserveChange">;

export interface FileExplorerGate {
    /** The window's root, or null for a single-file window. Loads the chunk on the first folder. */
    setProjectRoot(root: ProjectRoot | null, showHidden: boolean, expanded?: readonly string[]): void;
    applyDirectoryListing(msg: DirectoryListingMessage): void;
    setCurrentProjectFile(path: string | null): void;
    directoryChanged(paths: string[]): void;
    setShowHidden(showHidden: boolean): void;
    toggle(): void;
    focus(): void;
    toggleHidden(): void;
    /** The bar button that previews and toggles the panel; honoured before or after the chunk lands. */
    setFlyoutTrigger(el: HTMLElement): void;
    /** What the docked-open panel takes off the viewport, for the TOC's own docking decision. */
    dockedReserve(): number;
    /** Re-decide docked against overlay; nothing to decide before the panel exists. */
    checkResponsiveMode(): void;
    /** How many messages wait for the chunk: a test's view of the buffer, which
     *  must stay empty on a host that will never load it. */
    queuedForTesting(): number;
}

export function createFileExplorerGate(deps: FileExplorerDeps): FileExplorerGate {
    let controller: FileExplorerController | null = null;
    let pending: Promise<unknown> | null = null;
    let root: ProjectRoot | null = null;
    let showHidden = false;
    let expanded: readonly string[] | undefined;
    let flyoutTrigger: HTMLElement | null = null;
    /** What arrived before the panel existed, in order. */
    const queue: Array<(c: FileExplorerController) => void> = [];

    /** Run now, or once the panel exists; dropped when no folder is open. */
    const withController = (fn: (c: FileExplorerController) => void): void => {
        if (controller) { fn(controller); return; }
        if (root) { queue.push(fn); }
    };

    const load = (): void => {
        if (controller || pending) { return; }
        const load$ = import("../components/fileExplorer");
        pending = load$;
        // No catch: a chunk that fails to load is a real failure, and the
        // webview's crash boundary (crashReporter.ts) is what reports it.
        load$
            .then((module) => {
                // The root may have gone null while the chunk was in flight.
                if (!root) { return; }
                controller = module.createFileExplorer({
                    ...deps,
                    root,
                    showHidden,
                    expanded,
                    visible: window.__i18n?.fileExplorerVisible,
                });
                if (flyoutTrigger) { controller.setFlyoutTrigger(flyoutTrigger); }
                for (const fn of queue.splice(0)) { fn(controller); }
            })
            .finally(() => {
                if (pending === load$) { pending = null; }
            });
    };

    return {
        setProjectRoot(next, nextShowHidden, nextExpanded) {
            if (!next) {
                root = null;
                queue.length = 0;
                controller?.dispose();
                controller = null;
                return;
            }
            // Before the root is recorded: with no capability nothing will
            // ever load, and a recorded root would make `withController`
            // queue every later message into a queue nothing drains.
            if (!hostHas("projectFiles")) { return; }
            root = next;
            showHidden = nextShowHidden;
            expanded = nextExpanded;
            if (controller) { controller.setRoot(next, nextShowHidden, nextExpanded); } else { load(); }
        },
        applyDirectoryListing: (msg) => withController((c) => c.applyListing(msg)),
        setCurrentProjectFile: (path) => withController((c) => c.setCurrentFile(path)),
        directoryChanged: (paths) => withController((c) => c.directoryChanged(paths)),
        setShowHidden: (next) => {
            showHidden = next;
            withController((c) => c.setShowHidden(next));
        },
        toggle: () => withController((c) => c.toggle()),
        focus: () => withController((c) => c.focus()),
        toggleHidden: () => withController((c) => c.toggleHidden()),
        setFlyoutTrigger(el) {
            flyoutTrigger = el;
            controller?.setFlyoutTrigger(el);
        },
        dockedReserve: () => controller?.dockedReserve() ?? 0,
        checkResponsiveMode: () => controller?.checkResponsiveMode(),
        queuedForTesting: () => queue.length,
    };
}
