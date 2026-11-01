/**
 * components/graph/folderOverview.ts
 *
 * The folder as a whole (MAR-488): its hub, the most connected note
 * (./folderGraph.ts `folderHub`), with two rings of the notes around it, and
 * under that the folder's recent files. A dot or a row opens its note. It is
 * opened on demand, by the `showFolderOverview` command, and never by itself:
 * opening a folder still opens a note.
 *
 * Two layers. `createFolderOverview` builds an element and draws into it, asks
 * the host for nothing, and is handed the index and the recent files, so it can
 * be mounted in any surface. `openFolderOverview` is the one surface that
 * mounts it today, the fullscreen surface over the page, and is what asks.
 *
 * The recent files must never be pushed below the fold by the drawing. The
 * square is sized against the viewport's height as well as its width
 * (`.fo .lg-stage` in ./styles.ts), which leaves the list its room in any
 * window, and the list is capped rather than scrolled.
 *
 * The centre opens like any other dot. In the Graph tab the centre is the note
 * on screen and opens nothing; here the centre is the folder's hub, which is
 * usually some other note, and it is a note to go to.
 */
import { t } from "@/i18n";
import {
    FOLDER_INDEX_CHANGED,
    FOLDER_RECENTS_CHANGED,
    readFolderIndex,
    type FolderIndexState,
} from "@/links/folderIndex";
import { notifyRequestFolderRecents } from "@/messaging";
import { bindActivate } from "@/ui/dom";
import { openFullscreenSurface } from "@/ui/fullscreenSurface";
import { wireRoving } from "../sidePanel/keyboardNav";
import { folderHub } from "./folderGraph";
import { buildLocalGraph, layoutRings } from "./localGraph";
import { createRingStage, fill, fillLegend, RING_SIZE } from "./ringStage";
import { ensureLocalGraphStyles } from "./styles";

/** Most recent files the list shows. */
export const OVERVIEW_RECENTS = 8;

export interface FolderOverviewHost {
    /** Open a note by its root-relative path. */
    openNote: (path: string) => void;
    /** Where Escape sends focus. */
    onEscape: () => void;
}

export interface FolderOverview {
    element: HTMLElement;
    /**
     * Draw the folder. `state` is the folder index (null while it has not
     * arrived; its `self` is not read, because the overview is of the folder
     * rather than of the note under it). `recents` are root-relative paths,
     * most recent first, or null from a host that keeps no recent files list,
     * which draws no section for them at all.
     */
    render: (state: FolderIndexState | null, recents: readonly string[] | null) => void;
    /** Move keyboard focus onto the first recent file, else the graph. */
    focusFirst: () => void;
}

export function createFolderOverview(host: FolderOverviewHost): FolderOverview {
    ensureLocalGraphStyles();
    const element = document.createElement("div");
    element.className = "fo";

    const stage = createRingStage({ openNote: host.openNote, onEscape: host.onEscape, centreIsCurrent: false });
    const caption = document.createElement("div");
    caption.className = "lg-caption fo-caption";
    const legend = document.createElement("div");
    legend.className = "lg-legend";

    const recentHead = document.createElement("div");
    recentHead.className = "ui-heading ui-menu-heading fo-heading";
    recentHead.textContent = t("Recent files");
    const recentList = document.createElement("div");
    recentList.className = "fo-recents";
    recentList.setAttribute("role", "group");
    recentList.setAttribute("aria-label", t("Recent files"));
    const recentEmpty = document.createElement("div");
    recentEmpty.className = "fo-empty";
    recentEmpty.textContent = t("Nothing in this folder has been opened yet");

    element.append(stage.element, caption, legend, recentHead, recentList, recentEmpty);

    const recentRoving = wireRoving({
        container: recentList,
        items: () => [...recentList.querySelectorAll<HTMLElement>(".fo-row")],
        onEscape: host.onEscape,
    });

    function drawGraph(state: FolderIndexState | null): void {
        stage.clear();
        legend.replaceChildren();
        if (!state) {
            stage.element.hidden = true;
            caption.textContent = t("Reading the folder…");
            return;
        }
        const hub = state.index ? folderHub(state.index) : null;
        const graph = hub !== null ? buildLocalGraph(state.index!, hub, 2) : null;
        if (!graph || graph.nodes.length < 2) {
            stage.element.hidden = true;
            caption.textContent = state.index
                ? t("No note in this folder links to another")
                : t("This folder has no notes to draw");
            return;
        }
        stage.element.hidden = false;
        const laid = layoutRings(graph, RING_SIZE);
        stage.draw(laid);
        const notes = [fill(t("Centred on {0}, the most connected note here"), laid.nodes[0]!.label)];
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
                detail.textContent = parts.join("/");
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

    return {
        element,
        render: (state, recents) => {
            drawGraph(state);
            drawRecents(state, recents);
        },
        focusFirst: () => {
            if (recentList.hidden) { stage.focusFirst(); } else { recentRoving.focusFirst(); }
        },
    };
}

export interface FolderOverviewSurfaceHost {
    /** Open a note by its root-relative path, in this window. */
    openNote: (path: string) => void;
    /** Where focus goes once the overview is dismissed without opening a note. */
    onDismiss: () => void;
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
 * Open the overview over the page, on the fullscreen surface the whole-folder
 * graph uses. Escape, Close or a click on the ground puts the page back as it
 * was; a dot or a row closes it and opens that note. It asks the host for the
 * index (once per page, as every view of it does) and for the recent files
 * (every opening), and redraws as either arrives.
 */
export function openFolderOverview(host: FolderOverviewSurfaceHost): FolderOverviewHandle {
    let openingNote = false;
    let open = true;
    // This opening's answer, null until it comes: a host that keeps no list
    // never answers, and the section is then never drawn.
    let recents: readonly string[] | null = null;
    const titleFor = (state: FolderIndexState | null): string => state?.index
        ? fill(t("Folder: {0}"), state.index.rootName)
        : t("Folder");
    const surface = openFullscreenSurface({
        ground: "canvas",
        title: titleFor(readFolderIndex()),
        className: "fo-surface",
        onClose: () => {
            open = false;
            window.removeEventListener(FOLDER_INDEX_CHANGED, redraw);
            window.removeEventListener(FOLDER_RECENTS_CHANGED, onRecents);
            if (!openingNote) { host.onDismiss(); }
        },
    });
    surface.setCanvasColor("var(--vscode-editor-background)");
    const view = createFolderOverview({
        openNote: (path) => {
            openingNote = true;
            surface.close();
            host.openNote(path);
        },
        onEscape: () => surface.close(),
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
        surface.setTitle(titleFor(state));
        // A redraw rebuilds every row and dot, so the one holding focus is
        // found again by what it names rather than dropped to the body.
        const held = document.activeElement instanceof HTMLElement && view.element.contains(document.activeElement)
            ? document.activeElement : null;
        const heldKey = held ? (held.dataset["path"] !== undefined ? `.fo-row` : `.lg-node`) : null;
        const heldName = held?.dataset["path"] ?? held?.dataset["id"] ?? null;
        view.render(state, recents);
        if (!touched) {
            view.focusFirst();
        } else if (heldKey !== null && heldName !== null) {
            const attr = heldKey === ".fo-row" ? "data-path" : "data-id";
            const again = [...view.element.querySelectorAll<HTMLElement>(heldKey)]
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
    notifyRequestFolderRecents();
    redraw();
    return {
        close: () => surface.close(),
        focus: () => view.focusFirst(),
        isOpen: () => open,
    };
}
