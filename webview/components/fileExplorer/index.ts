/**
 * components/fileExplorer/index.ts
 *
 * The file explorer (MAR-460): the folder a directory window is rooted at,
 * as a tree in a left sidebar, on a host that declares `projectFiles`.
 *
 * The drawer, its flyout, the resize sash and the docked/overlay decision are
 * the side-panel shell's (components/sidePanel/shell.ts), composed as the
 * table of contents composes it but for one answer: this drawer holds its
 * dock at every window width (see the policy below). This module fills it
 * with rows and answers the shell's policy questions. What the TOC reads out of the
 * document, this asks the host for: every listing crosses the wire
 * (`listDirectory` / `directoryListing`), because the page cannot read a
 * directory, and every open is a request (`openProjectFile`), because the
 * page cannot open a file.
 *
 * Selection is the host's, never the click's. Activating a file row asks the
 * host to open it and selects nothing; `currentProjectFile` is what selects a
 * row, expanding and listing whatever ancestors it has to. That is one route
 * for two gestures, so a file opened from the Finder lands on the same row a
 * click would, and a click the host declines (a non-document it hands to
 * another application) leaves the selection where the open document is.
 *
 * The tree itself is the pure model in ./treeModel.ts, so what to list and
 * what the rows are can be tested with no DOM; this file owns the wire, the
 * row DOM and the keyboard.
 *
 * The chunk this is in loads on the first non-null `projectRoot`
 * (utils/fileExplorerLoader.ts), and its CSS is injected on the first mount
 * (./styles.ts): a single-file window, and every VS Code launch, pays nothing
 * for it.
 */
import { createSidePanelShell, SIDE_PANEL_INSET } from "../sidePanel/shell";
import { wireRoving } from "../sidePanel/keyboardNav";
import { ensureFileExplorerStyles } from "./styles";
import { createTreeModel, type TreeRow } from "./treeModel";
import { t } from "@/i18n";
import {
    notifyFileExplorerExpanded,
    notifyFileExplorerVisibility,
    notifyFileExplorerWidth,
    notifyListDirectory,
    notifyOpenProjectFile,
    notifyProjectFileMenu,
    notifySetFileExplorerShowHidden,
} from "@/messaging";
import type { EventManager } from "@/eventManager";
import type { EditorView } from "@/pm";
import type { ProjectRoot, ToWebviewMessage } from "../../../shared/messages";

export type DirectoryListingMessage = Extract<ToWebviewMessage, { type: "directoryListing" }>;

// Narrower than the TOC's 260 default and 240 floor: a file name column has
// no tab strip to keep on one row. The ceiling matches the TOC's.
const FILES_DEFAULT_WIDTH = 220;
const FILES_MIN_WIDTH = 160;
const FILES_MAX_WIDTH = 600;
// The explorer holds its dock at every width rather than floating over the
// document on a narrow one (`SidePanelNarrowPolicy`). It is the drawer a
// reader navigates with, so the file they want next is in it; a window that
// took it away for being small is one they have to open it in again, and a
// directory window is often the small kind.
/** How long a `listDirectory` waits before its folder draws an error row. */
export const LISTING_TIMEOUT_MS = 10_000;

export interface FileExplorerHost {
    eventManager: EventManager;
    getEditorView: () => EditorView | null;
    /** Pixels the other docked side panel (the TOC) takes on the viewport. */
    neighborReserve: () => number;
    /** This panel's docked footprint changed; the TOC re-decides its mode. */
    onReserveChange?: () => void;
    root: ProjectRoot;
    showHidden: boolean;
    /** The remembered show/hide choice, when the host has one. */
    visible?: boolean;
    /** Folders to open on arrival: what the last page on this root had open. */
    expanded?: readonly string[];
}

export interface FileExplorerController {
    readonly panel: HTMLElement;
    /** A different root for the same window; forgets every listing. */
    setRoot: (root: ProjectRoot, showHidden: boolean, expanded?: readonly string[]) => void;
    applyListing: (msg: DirectoryListingMessage) => void;
    setCurrentFile: (path: string | null) => void;
    directoryChanged: (paths: string[]) => void;
    setShowHidden: (showHidden: boolean) => void;
    /** Show or hide, and tell the host which. */
    toggle: () => void;
    /** Open if hidden, then put the keyboard on the current file's row (or the first). */
    focus: () => void;
    /** Flip the dotfile switch and ask the host to persist it. */
    toggleHidden: () => void;
    setFlyoutTrigger: (el: HTMLElement) => void;
    isOpen: () => boolean;
    /** The width this panel takes off the viewport while docked open, else 0. */
    dockedReserve: () => number;
    /** Re-decide docked against overlay: what the TOC's `onReserveChange` runs. */
    checkResponsiveMode: () => void;
    dispose: () => void;
}

export function createFileExplorer(host: FileExplorerHost): FileExplorerController {
    ensureFileExplorerStyles();
    const model = createTreeModel();
    let showHidden = host.showHidden;
    let selectedPath: string | null = null;
    /** A `currentProjectFile` whose row is not on screen yet: scroll to it when it is. */
    let pendingReveal = false;
    let userCollapsed = host.visible === false;
    let initialLoad = true;

    const shell = createSidePanelShell({
        prefix: "files",
        eventManager: host.eventManager,
        // Always the leading edge: the TOC may dock either side, and its
        // margin math moves over by this panel's reserve when both are left
        // (style.css, `--files-reserve`).
        initialRight: false,
        // Drawn as a surface set into the window rather than a column flush
        // against the frame. The inset comes out of the panel's own box, so
        // `--files-reserve` and the formatting row's margin stay the width
        // and nothing else.
        inset: SIDE_PANEL_INSET,
        width: {
            cssVar: "--files-width",
            default: FILES_DEFAULT_WIDTH,
            min: FILES_MIN_WIDTH,
            max: FILES_MAX_WIDTH,
            onCommit: notifyFileExplorerWidth,
        },
        narrow: { kind: "hold" },
        neighborReserve: host.neighborReserve,
        onReserveChange: host.onReserveChange,
        // The bar carries the button that shows this panel; it registers
        // itself through `setFlyoutTrigger`. No reveal tab of its own.
        trigger: { kind: "external" },
        openOnDock: () => !userCollapsed,
        renderBody: render,
        suppressTransitions: () => initialLoad,
        focusEditor: () => host.getEditorView()?.focus(),
    });
    const { panel } = shell;
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", t("Files"));

    const header = document.createElement("div");
    header.className = "files-header";
    const rootName = document.createElement("span");
    rootName.className = "ui-heading files-header__name";
    rootName.textContent = host.root.name;
    header.append(rootName, shell.controlsSlot);

    const tree = document.createElement("div");
    tree.className = "files-tree";
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", host.root.name);
    tree.tabIndex = -1;
    // The card is the coloured, rounded surface; the panel is its box and
    // holds a strip of page beside it for the resize sash, so the sash's line
    // stands off the card's rounded edge rather than lying on it
    // (`.files-card` in styles.ts).
    const card = document.createElement("div");
    card.className = "files-card";
    card.append(header, tree);
    panel.append(card);

    // ── Listings on the wire ──────────────────────────────────────────────
    let requestSeq = 0;
    /** In-flight requests by id; a folder has at most one, the newest. */
    const inflight = new Map<string, { path: string; timer: ReturnType<typeof setTimeout> }>();
    const inflightByPath = new Map<string, string>();

    /**
     * Ask the host for one folder. A folder already listed keeps its rows
     * while the answer is on its way (a `directoryChanged` re-list must not
     * flash a Loading row over a tree the reader is looking at); one never
     * listed shows Loading until the answer or the timeout.
     */
    function requestListing(path: string): void {
        const superseded = inflightByPath.get(path);
        if (superseded !== undefined) {
            clearTimeout(inflight.get(superseded)!.timer);
            inflight.delete(superseded);
        }
        const id = `files-${++requestSeq}`;
        const timer = setTimeout(() => {
            inflight.delete(id);
            inflightByPath.delete(path);
            model.setError(path, t("No answer from the host"));
            render();
        }, LISTING_TIMEOUT_MS);
        inflight.set(id, { path, timer });
        inflightByPath.set(path, id);
        if (model.listing(path)?.kind !== "ready") {
            model.setLoading(path);
        }
        notifyListDirectory(id, path);
    }

    function requestAll(paths: readonly string[]): void {
        for (const path of paths) { requestListing(path); }
    }

    function applyListing(msg: DirectoryListingMessage): void {
        const req = inflight.get(msg.id);
        // A reply to a request this panel never made, or one a newer request
        // for the same folder superseded: not this tree's to apply.
        if (!req) { return; }
        clearTimeout(req.timer);
        inflight.delete(msg.id);
        inflightByPath.delete(req.path);
        if (msg.entries === null) {
            model.setError(req.path, msg.error ?? t("Could not read this folder"));
        } else {
            model.applyListing(req.path, msg.entries);
        }
        // A reveal in progress may now be able to reach further down.
        if (pendingReveal && selectedPath !== null) {
            requestAll(model.revealPath(selectedPath));
        }
        render();
    }

    // ── Rows ──────────────────────────────────────────────────────────────
    /** Row elements by key, kept across renders so a repaint moves nodes rather than rebuilding them. */
    let rowEls = new Map<string, HTMLElement>();
    const empty = document.createElement("div");
    empty.className = "files-empty";
    empty.textContent = t("This folder is empty");

    function rowKey(row: TreeRow): string {
        return row.kind === "dir" || row.kind === "file" ? row.path : `${row.path}\u0000${row.kind}`;
    }

    function buildRow(row: TreeRow): HTMLElement {
        const el = document.createElement("div");
        el.setAttribute("role", "treeitem");
        const caret = document.createElement("span");
        caret.className = "files-caret";
        const name = document.createElement("span");
        name.className = "files-row__name";
        el.append(caret, name);
        // The caret opens and closes a folder and does nothing else; the row
        // opens a file or toggles a folder. Both keep focus where it is on
        // mousedown, the way the TOC's rows do, and act on click.
        caret.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        caret.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (el.classList.contains("files-row--dir")) { toggleFolder(el.dataset["path"] ?? ""); }
        });
        el.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        // A plain click moves this window to the file; the modifiers every
        // sidebar and browser use for "beside, not instead" ask for a tab:
        // Cmd+click and the middle button (which fires `auxclick`, never
        // `click`).
        el.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            activate(el, { newTab: e.metaKey || e.ctrlKey });
        });
        el.addEventListener("auxclick", (e) => {
            if (e.button !== 1) { return; }
            e.preventDefault();
            e.stopPropagation();
            activate(el, { newTab: true });
        });
        // The row's menu is the host's (a native one, with actions only the
        // host can perform), so the page reports the point and draws
        // nothing; the browser's own text menu over a file name is refused.
        el.addEventListener("contextmenu", (e) => {
            const kind = el.dataset["kind"];
            if (kind !== "dir" && kind !== "file") { return; }
            e.preventDefault();
            e.stopPropagation();
            notifyProjectFileMenu(el.dataset["path"] ?? "", kind, e.clientX, e.clientY);
        });
        return el;
    }

    /** The extension a file name ends in, upper-cased for the chip; "" for none (a dotfile's dot leads, and is not one). */
    function extensionOf(name: string): string {
        const dot = name.lastIndexOf(".");
        if (dot <= 0 || dot === name.length - 1) { return ""; }
        return name.slice(dot + 1).toUpperCase();
    }

    function paintRow(el: HTMLElement, row: TreeRow): void {
        const isDir = row.kind === "dir";
        el.className = [
            "ui-label", "files-row",
            isDir ? "files-row--dir" : "",
            isDir && row.expanded ? "files-row--expanded" : "",
            row.kind === "file" && !row.openable ? "files-row--other" : "",
            row.kind === "loading" ? "files-row--loading" : "",
            row.kind === "error" ? "files-row--error" : "",
            row.path === selectedPath && row.kind === "file" ? "files-row--selected" : "",
        ].filter(Boolean).join(" ");
        el.dataset["path"] = row.path;
        el.dataset["kind"] = row.kind;
        el.setAttribute("aria-level", String(row.level));
        if (isDir) { el.setAttribute("aria-expanded", String(row.expanded)); } else { el.removeAttribute("aria-expanded"); }
        el.setAttribute("aria-selected", String(row.path === selectedPath && row.kind === "file"));
        el.hidden = row.concealed;
        el.style.paddingLeft = `${(row.level - 1) * 12 + 8}px`;
        const name = el.lastElementChild as HTMLElement;
        name.textContent = row.kind === "loading"
            ? t("Loading…")
            : row.kind === "error"
                ? (row.message ?? t("Could not read this folder"))
                : row.name;
        // What a file the host hands elsewhere IS, for the row the name has
        // no room to say it on: its extension, in a chip the row shows while
        // hovered (styles.ts). Written on the row rather than drawn, so the
        // chip exists only for the rows that need one.
        const ext = row.kind === "file" && !row.openable ? extensionOf(row.name) : "";
        if (ext) { el.dataset["ext"] = ext; } else { delete el.dataset["ext"]; }
    }

    /** Repaint the tree from the model. Runs on every visible commit, so it moves nodes rather than rebuilding them. */
    function render(): void {
        const rows = model.visibleRows(showHidden);
        const next = new Map<string, HTMLElement>();
        const children: HTMLElement[] = [];
        for (const row of rows) {
            const key = rowKey(row);
            const el = rowEls.get(key) ?? buildRow(row);
            paintRow(el, row);
            next.set(key, el);
            children.push(el);
        }
        rowEls = next;
        const rootListing = model.listing("");
        if (rootListing?.kind === "ready" && rootListing.entries.length === 0) {
            children.push(empty);
        }
        // Re-parenting is a blur: a focused row taken out of the tree and put
        // back has lost the keyboard, and a listing landing mid-navigation
        // would strand it on the body. So the children are replaced only when
        // their order changed, and the focused row is given focus back.
        const current = [...tree.children];
        const unchanged = current.length === children.length && current.every((el, i) => el === children[i]);
        if (!unchanged) {
            const active = document.activeElement;
            const focused = active instanceof HTMLElement && tree.contains(active) ? active : null;
            tree.replaceChildren(...children);
            if (focused && focused.isConnected && !focused.hidden) { focused.focus(); }
        }
        roving.refresh();
        if (pendingReveal && selectedPath !== null) {
            const el = rowEls.get(selectedPath);
            if (!el || el.hidden) {
                // Nothing more is coming that could draw the row (a dotfile
                // with the switch off, a folder the host could not read): the
                // reveal is given up, or every later render would scroll to
                // the row the moment something else made it visible.
                if (inflight.size === 0) { pendingReveal = false; }
            } else {
                pendingReveal = false;
                el.scrollIntoView?.({ block: "nearest" });
            }
        }
    }

    function toggleFolder(path: string): void {
        requestAll(model.toggle(path));
        render();
        // The host keeps the open set for the next page on this root, so the
        // tree survives the window moving to another file. Reported on the
        // reader's toggles alone: a reveal opens ancestors the reader did
        // not ask for, and a page seeded with those would open them again
        // after the file they led to was long closed.
        notifyFileExplorerExpanded(model.expandedPaths());
    }

    /**
     * Open the folders a previous page on this root had open. Each is asked
     * for on its own, the way a reveal asks for every ancestor at once:
     * the host resolves paths independently, so nothing waits on a parent's
     * listing to ask for a child's.
     */
    function seedExpanded(paths: readonly string[] | undefined): void {
        if (!paths?.length) { return; }
        requestAll(paths.flatMap((path) => model.expand(path)));
    }

    function activate(el: HTMLElement, opts: { newTab: boolean } = { newTab: false }): void {
        const path = el.dataset["path"] ?? "";
        switch (el.dataset["kind"]) {
            case "dir": toggleFolder(path); break;
            // The host opens it and then says which file is current; the row
            // is selected by that answer, never here.
            case "file": notifyOpenProjectFile(path, opts.newTab); break;
            case "error": requestListing(path); render(); break;
            default: break;
        }
    }

    // ── Keyboard: one roving Tab stop, arrows along the tree ─────────────
    const rowItems = (): HTMLElement[] => [...tree.querySelectorAll<HTMLElement>(".files-row:not([hidden])")];
    // Cmd+Return is the keyboard's Cmd+click. Bound before the roving
    // handler, which would otherwise turn the Return into a plain click with
    // the modifier dropped; listeners on one element run in the order they
    // were added, and the immediate stop is what keeps the second from
    // running at all.
    tree.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) { return; }
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !rowItems().includes(active)) { return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        activate(active, { newTab: true });
    });
    const roving = wireRoving({
        container: tree,
        items: rowItems,
        onEscape: () => host.getEditorView()?.focus(),
        onHorizontal: (item, dir) => {
            const path = item.dataset["path"] ?? "";
            const isDir = item.dataset["kind"] === "dir";
            const open = isDir && model.isExpanded(path);
            if (dir === 1) {
                if (!isDir) { return false; }
                if (!open) { toggleFolder(path); focusRow(path); return true; }
                // Open already: the APG tree convention moves to the first child.
                const items = rowItems();
                const next = items[items.indexOf(item) + 1];
                if (next) { next.focus(); }
                return true;
            }
            if (open) { toggleFolder(path); focusRow(path); return true; }
            const parent = model.parentPath(path);
            if (parent === null || parent === "") { return true; }
            focusRow(parent);
            return true;
        },
    });

    function focusRow(path: string): void {
        const el = rowEls.get(path);
        if (el && !el.hidden) { el.focus(); }
    }

    // ── Panel state ───────────────────────────────────────────────────────
    function setVisible(visible: boolean): void {
        shell.hideFlyoutImmediate();
        userCollapsed = !visible;
        shell.setOpen(visible);
        shell.sync();
        notifyFileExplorerVisibility(visible);
    }

    function setCurrentFile(path: string | null): void {
        selectedPath = path;
        pendingReveal = path !== null;
        if (path !== null) { requestAll(model.revealPath(path)); }
        render();
    }

    function directoryChanged(paths: string[]): void {
        for (const path of paths) {
            // Expanded (or the root): listed again, in place. Collapsed: the
            // stale listing is dropped and asked for when next opened.
            if (model.isExpanded(path)) { requestListing(path); } else { model.invalidate(path); }
        }
        render();
    }

    function setShowHidden(next: boolean): void {
        showHidden = next;
        render();
    }

    // The load reveal snaps rather than slides, like the TOC's: the panel is
    // part of the window the reader opened, not a response to anything. The
    // frame is cancelled on dispose, so a root withdrawn in the same frame
    // the chunk landed cannot sync a panel that was already swept.
    const mountFrame = requestAnimationFrame(() => {
        const mode = shell.settleMode();
        shell.setOpen(mode === "docked" && !userCollapsed);
        shell.updatePosition();
        shell.sync();
        initialLoad = false;
    });
    requestListing("");
    seedExpanded(host.expanded);
    document.body.appendChild(panel);

    return {
        panel,
        setRoot(root, nextShowHidden, expanded) {
            for (const { timer } of inflight.values()) { clearTimeout(timer); }
            inflight.clear();
            inflightByPath.clear();
            model.reset();
            rowEls = new Map();
            selectedPath = null;
            pendingReveal = false;
            showHidden = nextShowHidden;
            rootName.textContent = root.name;
            tree.setAttribute("aria-label", root.name);
            requestListing("");
            seedExpanded(expanded);
            render();
        },
        applyListing,
        setCurrentFile,
        directoryChanged,
        setShowHidden,
        toggle: () => setVisible(!shell.isOpen()),
        focus() {
            if (!shell.isOpen()) { setVisible(true); }
            const target = (selectedPath !== null ? rowEls.get(selectedPath) : undefined) ?? rowItems()[0];
            if (target && !target.hidden) { target.focus(); } else { tree.focus(); }
        },
        toggleHidden() {
            setShowHidden(!showHidden);
            notifySetFileExplorerShowHidden(showHidden);
        },
        setFlyoutTrigger: (el) => shell.setFlyoutTrigger(el),
        isOpen: () => shell.isOpen(),
        dockedReserve: shell.dockedReserve,
        checkResponsiveMode: shell.checkResponsiveMode,
        dispose() {
            for (const { timer } of inflight.values()) { clearTimeout(timer); }
            inflight.clear();
            inflightByPath.clear();
            cancelAnimationFrame(mountFrame);
            roving.dispose();
            shell.close();
            shell.dispose();
            panel.remove();
            // The shell writes its state on the body in this panel's
            // vocabulary; a panel that is gone leaves none of it behind, or
            // the editor's margin math would go on making room for it.
            for (const cls of [...document.body.classList]) {
                if (cls.startsWith("files-")) { document.body.classList.remove(cls); }
            }
        },
    };
}
