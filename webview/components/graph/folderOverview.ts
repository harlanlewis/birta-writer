/**
 * components/graph/folderOverview.ts
 *
 * A folder seen before any note in it is (MAR-488): the folder's hub, its
 * most connected note (./folderGraph.ts `folderHub`), with two rings of the
 * notes around it, and under that the folder's recent files. A dot or a row
 * opens its note.
 *
 * A component and not a surface: it builds an element and draws into it, and
 * whoever mounts it decides where it sits and when it goes. Nothing here asks
 * the host for anything; the index and the recent files are handed in.
 *
 * The recent files are the reason somebody opening a folder came, more often
 * than not, so they must never be pushed below the fold by the drawing. The
 * square is sized against the viewport's height as well as its width
 * (`.fo .lg-stage` in ./styles.ts), which leaves the list its room in any
 * window, and the list is capped rather than scrolled.
 *
 * The centre opens like any other dot. In the Graph tab the centre is the note
 * on screen and opens nothing; here nothing is on screen yet, so the hub is a
 * note to go to.
 */
import { t } from "@/i18n";
import type { FolderIndexState } from "@/links/folderIndex";
import { bindActivate } from "@/ui/dom";
import { wireRoving } from "../sidePanel/keyboardNav";
import { folderHub } from "./folderGraph";
import { buildLocalGraph, layoutRings } from "./localGraph";
import { createRingStage, fillLegend, RING_SIZE } from "./ringStage";
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
     * arrived; its `self` is not read, because nothing is open). `recents`
     * are root-relative paths, most recent first.
     */
    render: (state: FolderIndexState | null, recents: readonly string[]) => void;
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
        const notes = [t("Centred on {0}, the most connected note here").replace("{0}", laid.nodes[0]!.label)];
        if (laid.omitted > 0) {
            notes.push(t("{0} more not shown").replace("{0}", String(laid.omitted)));
        }
        if (state.index!.truncated) {
            notes.push(t("This folder has more notes than its index reads"));
        }
        caption.textContent = notes.join(". ");
        fillLegend(legend, laid);
    }

    function drawRecents(state: FolderIndexState | null, recents: readonly string[]): void {
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
