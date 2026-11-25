/**
 * components/graph/folderOverview.ts
 *
 * The folder as a whole (MAR-488): the files the reader has been working in
 * here, and under them a drawing of the notes around the one they opened most
 * recently. A row or a dot opens its note. It is opened on demand, by the
 * `showFolderOverview` command, and never by itself: opening a folder still
 * opens a note.
 *
 * Two layers. `createFolderOverview` builds an element and draws into it, asks
 * the host for nothing, and is handed the index and the recent files, so it can
 * be mounted in any surface. `openFolderOverview` is the one surface that
 * mounts it today, a fullscreen surface set in the document's area (under the
 * top bar, beside a docked file list: `inContent`), and is what asks.
 *
 * The lists come before the drawing. They are what the reader came for, a way
 * back into what they were doing; the drawing is a way to wander from there,
 * and drawn first it pushed the lists below the fold of any short window.
 *
 * The drawing centres on the most recently opened note here that links to
 * anything (`overviewCentre`), not on the folder's most connected note. A
 * hub is a fact about the folder's history, and in a vault of any age it is
 * one cluster of old notes that has nothing to do with today's work; the
 * recent list is the one signal of what today's work is. Only a host that
 * keeps no recent files list, or one with nothing opened here yet, falls back
 * to the hub, because it is then the only centre there is. The centre opens
 * like any other dot, unless it is the note already on screen.
 *
 * It is also the START VIEW, on a host that declares `fileLauncher`: the empty
 * state of a window holding no file, and the same buttons and recent files in
 * a folder's overview:
 *
 *     Folder name  (a folder)
 *     [New Note]  [Open…]
 *     In this folder  (a folder) the folder's own recent files
 *     Recent       the reader's recent files, app-wide
 *     Open Recent…
 *     (a folder)   the drawing
 *
 * A window with no folder draws the same view with no folder sections, pinned
 * (`openStartView`): a Mac window holding no file, which New Window and moving
 * the open note to the Trash leave. One view rather than one per kind of
 * window, so the two offer the same ways out in the same places.
 */
import { t } from "@/i18n";
import {
    FOLDER_INDEX_CHANGED,
    FOLDER_RECENTS_CHANGED,
    RECENT_FILES_CHANGED,
    readFolderIndex,
    type FolderIndexState,
    type RecentFile,
} from "@/links/folderIndex";
import { hostHas } from "../../../shared/hostProfile";
import {
    notifyOpenRecentFile,
    notifyRequestFolderRecents,
    notifyRequestRecentFiles,
    notifyStartAction,
} from "@/messaging";
import { bindActivate } from "@/ui/dom";
import { openFullscreenSurface } from "@/ui/fullscreenSurface";
import { wireRoving } from "../sidePanel/keyboardNav";
import { folderHub } from "./folderGraph";
import { buildLocalGraph, layoutRings, type LocalGraph } from "./localGraph";
import type { FolderIndex } from "../../../shared/folderIndex";
import { createRingStage, fill, fillLegend, RING_SIZE } from "./ringStage";
import { ensureLocalGraphStyles } from "./styles";

/** Most recent files the list shows. */
export const OVERVIEW_RECENTS = 8;

/** Most of the reader's recent files the start view lists before Open Recent…. */
export const START_RECENTS = 6;

/** Where the drawing centres, and why, for its caption. */
export interface OverviewCentre {
    graph: LocalGraph;
    /** `recent`: the reader's most recent note here with a link; `hub`: the folder's most connected. */
    reason: "recent" | "hub";
}

/**
 * The note the overview's drawing centres on: the first of `recents` (the
 * folder's recent files, most recent first) that the index holds and that
 * links or is linked to, with its two rings. With no recent files to go on
 * (`recents` null from a host that keeps none, or empty) it is the folder's
 * hub. Null when the recent files are there and none of them links to
 * anything: the hub would be a drawing of somewhere else, which is the one
 * thing this view exists not to show.
 */
export function overviewCentre(index: FolderIndex, recents: readonly string[] | null): OverviewCentre | null {
    const drawable = (path: string): LocalGraph | null => {
        const graph = buildLocalGraph(index, path, 2);
        return graph && graph.nodes.length >= 2 ? graph : null;
    };
    if (recents !== null && recents.length > 0) {
        for (const path of new Set(recents)) {
            const graph = drawable(path);
            if (graph) { return { graph, reason: "recent" }; }
        }
        return null;
    }
    const hub = folderHub(index);
    const graph = hub !== null ? drawable(hub) : null;
    return graph ? { graph, reason: "hub" } : null;
}

/** The host's ways to a document, for the start view's buttons and rows. */
export interface StartLauncher {
    newNote: () => void;
    open: () => void;
    /** Open one of the recent files, by the path the host listed it under. */
    openRecent: (path: string) => void;
    /** Pop the host's Open Recent menu under `anchor`, in viewport coordinates. */
    openRecentMenu: (anchor: DOMRect) => void;
}

/**
 * The host's ways to a document, when it declares them (`fileLauncher`).
 * Here, in the lazy chunk, rather than beside the command that asks for it,
 * because nothing at launch needs it. The menu goes under the row that asked,
 * at its bottom-left corner, which is where a pop-up menu from a control is
 * placed on a Mac.
 */
export function hostLauncher(): StartLauncher | undefined {
    if (!hostHas("fileLauncher")) { return undefined; }
    return {
        newNote: () => notifyStartAction("newNote"),
        open: () => notifyStartAction("open"),
        openRecent: (path) => notifyOpenRecentFile(path),
        openRecentMenu: (anchor) => notifyStartAction("openRecentMenu", { x: anchor.left, y: anchor.bottom }),
    };
}

export interface FolderOverviewHost {
    /** Open a note by its root-relative path. */
    openNote: (path: string) => void;
    /** Where Escape sends focus. */
    onEscape: () => void;
    /**
     * The host's ways to a document. Absent on a host that has none to give
     * (no `fileLauncher`), which draws neither the buttons nor the reader's
     * recent files.
     */
    launcher?: StartLauncher;
    /** Whether the view is of a folder: false draws no graph and no folder list. */
    folder?: boolean;
    /**
     * Whether a `null` recents list means NOT YET rather than never: the
     * drawing then waits for it, because the centre is chosen from it and a
     * drawing made without it would be the hub's, replaced a moment later.
     */
    recentsAwaited?: boolean;
}

export interface FolderOverview {
    element: HTMLElement;
    /**
     * Draw the folder. `state` is the folder index (null while it has not
     * arrived; its `self`, the note on screen, is read only to draw that note
     * current should it be the centre). `recents` are root-relative paths,
     * most recent first, or null from a host that keeps no recent files list,
     * which draws no section for them at all.
     */
    render: (state: FolderIndexState | null, recents: readonly string[] | null,
             files?: readonly RecentFile[] | null) => void;
    /** Move keyboard focus onto the first recent file, else the graph. */
    focusFirst: () => void;
}

export function createFolderOverview(host: FolderOverviewHost): FolderOverview {
    ensureLocalGraphStyles();
    const element = document.createElement("div");
    element.className = "fo";
    const folder = host.folder !== false;
    const launcher = host.launcher;

    const stage = createRingStage({ openNote: host.openNote, onEscape: host.onEscape, centreIsCurrent: false });
    // The folder's name, in the column rather than in a pill over it: the
    // pill floated in the corner the Mac app's titlebar controls sit in.
    const title = document.createElement("h2");
    title.className = "fo-title";
    const caption = document.createElement("div");
    caption.className = "lg-caption fo-caption";
    const legend = document.createElement("div");
    legend.className = "lg-legend";

    const recentHead = document.createElement("div");
    recentHead.className = "ui-heading ui-menu-heading fo-heading";
    // Beside the reader's own recent files, the folder's list is named for
    // where it is rather than for when.
    recentHead.textContent = launcher ? t("In this folder") : t("Recent files");
    const recentList = document.createElement("div");
    recentList.className = "fo-recents";
    recentList.setAttribute("role", "group");
    recentList.setAttribute("aria-label", t("Recent files"));
    const recentEmpty = document.createElement("div");
    recentEmpty.className = "fo-empty";
    recentEmpty.textContent = t("Nothing in this folder has been opened yet");

    // The start view's: the two buttons above everything, and the reader's
    // recent files, closed by Open Recent…, below everything.
    const actions = document.createElement("div");
    actions.className = "fo-actions";
    const newButton = launchButton(t("New Note"), "ui-btn--primary", () => launcher?.newNote());
    const openButton = launchButton(t("Open…"), "ui-btn--secondary", () => launcher?.open());
    actions.append(newButton, openButton);
    const filesHead = document.createElement("div");
    filesHead.className = "ui-heading ui-menu-heading fo-heading";
    filesHead.textContent = t("Recent");
    const filesList = document.createElement("div");
    filesList.className = "fo-recents fo-files";
    filesList.setAttribute("role", "group");
    filesList.setAttribute("aria-label", t("Recent"));
    const moreRow = document.createElement("button");
    moreRow.className = "ui-menu-row fg-row fo-more";
    moreRow.tabIndex = -1;
    moreRow.textContent = t("Open Recent…");
    bindActivate(moreRow, () => launcher?.openRecentMenu(moreRow.getBoundingClientRect()));

    if (folder) { element.append(title); }
    if (launcher) { element.append(actions); }
    if (folder) { element.append(recentHead, recentList, recentEmpty); }
    if (launcher) { element.append(filesHead, filesList); }
    if (folder) { element.append(stage.element, caption, legend); }

    const recentRoving = wireRoving({
        container: recentList,
        items: () => [...recentList.querySelectorAll<HTMLElement>(".fo-row")],
        onEscape: host.onEscape,
    });
    const filesRoving = wireRoving({
        container: filesList,
        items: () => [...filesList.querySelectorAll<HTMLElement>(".fo-file, .fo-more")],
        onEscape: host.onEscape,
    });

    /** A row's place, as the run its cell elides from the start (./styles.ts). */
    function where(text: string): HTMLSpanElement {
        const span = document.createElement("span");
        span.textContent = text;
        return span;
    }

    function launchButton(label: string, kind: string, run: () => void): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `ui-btn ${kind} fo-action`;
        btn.textContent = label;
        bindActivate(btn, run);
        return btn;
    }

    function drawGraph(state: FolderIndexState | null, recents: readonly string[] | null): void {
        stage.clear();
        legend.replaceChildren();
        title.textContent = state?.index?.rootName ?? "";
        title.hidden = !state?.index;
        if (!state) {
            stage.element.hidden = true;
            caption.textContent = t("Reading the folder…");
            return;
        }
        if (recents === null && host.recentsAwaited) {
            stage.element.hidden = true;
            caption.textContent = "";
            return;
        }
        const centre = state.index ? overviewCentre(state.index, recents) : null;
        if (!centre) {
            stage.element.hidden = true;
            caption.textContent = !state.index
                ? t("This folder has no notes to draw")
                : recents !== null && recents.length > 0
                    ? t("None of the notes you opened here links to another")
                    : t("No note in this folder links to another");
            return;
        }
        stage.element.hidden = false;
        const laid = layoutRings(centre.graph, RING_SIZE);
        stage.draw(laid, laid.nodes[0]!.id === state.self);
        const notes = [fill(centre.reason === "recent"
            ? t("Around {0}, the note you opened here most recently")
            : t("Centred on {0}, the most connected note here"), laid.nodes[0]!.label)];
        if (laid.omitted > 0) {
            notes.push(fill(t("{0} more not shown"), String(laid.omitted)));
        }
        if (state.index!.truncated) {
            notes.push(t("This folder has more notes than its index reads"));
        }
        caption.textContent = notes.join(". ");
        fillLegend(legend, laid);
    }

    function drawRecents(state: FolderIndexState | null, recents: readonly string[] | null): void {
        recentHead.hidden = recents === null;
        if (recents === null) {
            recentList.replaceChildren();
            recentList.hidden = true;
            recentEmpty.hidden = true;
            recentRoving.refresh();
            return;
        }
        const names = new Map(state?.index?.nodes.map((n) => [n.path, n.name]) ?? []);
        const rows = [...new Set(recents)].slice(0, OVERVIEW_RECENTS).map((path) => {
            const parts = path.split("/");
            const file = parts.pop()!;
            const btn = document.createElement("button");
            btn.className = "ui-menu-row fg-row fo-row";
            btn.tabIndex = -1;
            btn.title = path;
            btn.dataset["path"] = path;
            const label = document.createElement("span");
            label.className = "fg-row-label";
            label.textContent = names.get(path) ?? file;
            btn.append(label);
            // Where it is, when it is not at the root: two notes called
            // "index" in two folders are otherwise one row twice.
            if (parts.length > 0) {
                const detail = document.createElement("span");
                detail.className = "fg-row-detail fo-row-where";
                detail.append(where(parts.join("/")));
                btn.append(detail);
            }
            bindActivate(btn, () => host.openNote(path));
            return btn;
        });
        recentList.replaceChildren(...rows);
        recentList.hidden = rows.length === 0;
        recentEmpty.hidden = rows.length > 0;
        recentRoving.refresh();
    }

    /**
     * The reader's recent files, at most `START_RECENTS`, then Open Recent…,
     * which is drawn even before the list arrives and with nothing in it: it
     * is the way to everything past the six, and to the host's own menu.
     */
    function drawFiles(files: readonly RecentFile[] | null): void {
        const rows = (files ?? []).slice(0, START_RECENTS).map((file) => {
            const btn = document.createElement("button");
            btn.className = "ui-menu-row fg-row fo-file";
            btn.tabIndex = -1;
            btn.title = file.path;
            btn.dataset["file"] = file.path;
            const label = document.createElement("span");
            label.className = "fg-row-label";
            label.textContent = file.name;
            btn.append(label);
            if (file.detail) {
                const detail = document.createElement("span");
                detail.className = "fg-row-detail fo-row-where";
                detail.append(where(file.detail));
                btn.append(detail);
            }
            bindActivate(btn, () => launcher?.openRecent(file.path));
            return btn;
        });
        filesList.replaceChildren(...rows, moreRow);
        filesRoving.refresh();
    }

    return {
        element,
        render: (state, recents, files = null) => {
            if (folder) {
                drawGraph(state, recents);
                drawRecents(state, recents);
            }
            if (launcher) { drawFiles(files); }
        },
        focusFirst: () => {
            if (folder && !recentList.hidden) { recentRoving.focusFirst(); return; }
            if (folder && !stage.element.hidden) { stage.focusFirst(); return; }
            if (launcher) { newButton.focus(); return; }
            stage.focusFirst();
        },
    };
}

export interface FolderOverviewSurfaceHost {
    /** Open a note by its root-relative path, in this window. */
    openNote: (path: string) => void;
    /** Where focus goes once the overview is dismissed without opening a note. */
    onDismiss: () => void;
    /** The host's ways to a document; see `FolderOverviewHost.launcher`. */
    launcher?: StartLauncher;
    /**
     * The start view of a window with no file: no folder sections, no way to
     * dismiss it, and the title says the window holds nothing.
     */
    empty?: boolean;
}

export interface FolderOverviewHandle {
    /** Close it, as Escape does. */
    close: () => void;
    /** Bring keyboard focus back into it, to the first recent file or dot. */
    focus: () => void;
    /** Whether it is still up: false from the first moment of its close. */
    isOpen: () => boolean;
}

/**
 * Open the overview in place of the document, on the fullscreen surface the
 * whole-folder graph uses, set in the document's area (`inContent`) so the top
 * bar and a docked file list stay usable beside it. Escape, Close or a click
 * on the ground puts the page back as it was; a dot or a row closes it and opens that note. It asks the host for the
 * index (once per page, as every view of it does) and for the recent files
 * (every opening), and redraws as either arrives.
 */
export function openFolderOverview(host: FolderOverviewSurfaceHost): FolderOverviewHandle {
    let openingNote = false;
    let open = true;
    // This opening's answer, null until it comes: a host that keeps no list
    // never answers, and the section is then never drawn.
    let recents: readonly string[] | null = null;
    // The reader's recent files, likewise this opening's answer.
    let files: readonly RecentFile[] | null = null;
    const empty = host.empty === true;
    // What the region is called, for a screen reader: the folder's own name
    // is drawn in the column, and the window's title already says a window
    // holding nothing is Birta Writer.
    const labelFor = (state: FolderIndexState | null): string => empty
        ? t("No File Open")
        : state?.index
            ? fill(t("Folder: {0}"), state.index.rootName)
            : t("Folder");
    const surface = openFullscreenSurface({
        ground: "canvas",
        className: "fo-surface",
        pinned: empty,
        inContent: true,
        onClose: () => {
            open = false;
            window.removeEventListener(FOLDER_INDEX_CHANGED, redraw);
            window.removeEventListener(FOLDER_RECENTS_CHANGED, onRecents);
            window.removeEventListener(RECENT_FILES_CHANGED, onFiles);
            if (!openingNote) { host.onDismiss(); }
        },
    });
    surface.overlay.setAttribute("aria-label", labelFor(readFolderIndex()));
    surface.setCanvasColor("var(--vscode-editor-background)");
    // A button that goes somewhere else leaves the view as a row does: a new
    // note or an opened file is the next thing on screen, and the view would
    // only be in its way. The Open panel and the Open Recent menu can be
    // cancelled, so the view stays under them. Pinned, nothing closes it:
    // the window is rebound, which reloads the page.
    const leaving = (run: () => void) => () => {
        if (!empty) { surface.close(); }
        run();
    };
    const launcher: StartLauncher | undefined = host.launcher && {
        newNote: leaving(host.launcher.newNote),
        open: host.launcher.open,
        openRecent: (path) => leaving(() => host.launcher!.openRecent(path))(),
        openRecentMenu: host.launcher.openRecentMenu,
    };
    const view = createFolderOverview({
        openNote: (path) => {
            openingNote = true;
            surface.close();
            host.openNote(path);
        },
        onEscape: () => { if (!empty) { surface.close(); } },
        ...(launcher ? { launcher } : {}),
        folder: !empty,
        // A host with a launcher keeps the reader's recent files, so it
        // answers this opening's request; one without may never answer.
        recentsAwaited: !empty && launcher !== undefined,
    });
    surface.content.append(view.element);

    // Focus follows what has arrived (the first recent file, else the first
    // dot) until the reader touches the overview, and then is never moved
    // again. The index and the recent files arrive in either order, so a rule
    // that placed focus once would land on the graph whenever the index won.
    let touched = false;
    const touch = (): void => { touched = true; };
    surface.overlay.addEventListener("keydown", touch, true);
    surface.overlay.addEventListener("mousedown", touch, true);
    function redraw(): void {
        const state = readFolderIndex();
        surface.overlay.setAttribute("aria-label", labelFor(state));
        // A redraw rebuilds every row and dot, so the one holding focus is
        // found again by what it names rather than dropped to the body.
        const held = document.activeElement instanceof HTMLElement && view.element.contains(document.activeElement)
            ? document.activeElement : null;
        // Each kind of row names itself by its own attribute; a control that
        // is never rebuilt (a button, Open Recent…) keeps focus by itself.
        const attr = held ? ["data-path", "data-id", "data-file"].find((a) => held.hasAttribute(a)) ?? null : null;
        const heldName = attr ? held!.getAttribute(attr) : null;
        view.render(state, recents, files);
        if (!touched) {
            view.focusFirst();
        } else if (attr !== null && heldName !== null) {
            const again = [...view.element.querySelectorAll<HTMLElement>(`[${attr}]`)]
                .find((el) => el.getAttribute(attr) === heldName);
            if (again) { again.focus(); } else { view.focusFirst(); }
        }
    }
    window.addEventListener(FOLDER_INDEX_CHANGED, redraw);
    function onRecents(e: Event): void {
        recents = (e as CustomEvent<string[]>).detail;
        redraw();
    }
    window.addEventListener(FOLDER_RECENTS_CHANGED, onRecents);
    function onFiles(e: Event): void {
        files = (e as CustomEvent<RecentFile[]>).detail;
        redraw();
    }
    window.addEventListener(RECENT_FILES_CHANGED, onFiles);
    if (!empty) { notifyRequestFolderRecents(); }
    if (launcher) { notifyRequestRecentFiles(); }
    redraw();
    return {
        close: () => surface.close(),
        focus: () => view.focusFirst(),
        isOpen: () => open,
    };
}
