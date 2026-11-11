/**
 * components/graph/index.ts
 *
 * The review sidebar's Graph tab body (MAR-481): this note's local graph,
 * drawn from the host's folder index. The chunk this is in loads the first
 * time the tab is shown (utils/localGraphLoader.ts), and its CSS is injected
 * on the first render (./styles.ts), so a sidebar nobody switches to this tab
 * in pays nothing for it.
 *
 * The drawing itself is ./ringStage.ts, which the folder overview draws with
 * too. Here the centre is this note, so it opens nothing; every other node
 * opens its note, and a dangling reference opens nothing.
 */
import { t } from "@/i18n";
import type { FolderIndexState } from "@/links/folderIndex";
import { bindActivate } from "@/ui/dom";
import { wireRoving } from "../sidePanel/keyboardNav";
import { buildLocalGraph, layoutRings, type GraphDepth } from "./localGraph";
import { createRingStage, fillLegend, RING_SIZE } from "./ringStage";
import { ensureLocalGraphStyles } from "./styles";

export { openFolderGraph } from "./folderView";
export { createFolderOverview, hostLauncher, openFolderOverview } from "./folderOverview";

export interface LocalGraphHost {
    /** Open a note by its root-relative path. */
    openNote: (path: string) => void;
    /** Open the whole folder's graph over the page (./folderView.ts). */
    openFolder: () => void;
    /** Where Escape sends focus: the editor. */
    onEscape: () => void;
}

export interface LocalGraphView {
    element: HTMLElement;
    /** Draw the graph of the latest index, or say why there is none. */
    render: (state: FolderIndexState | null) => void;
    /** Move keyboard focus onto the first node that can be reached. */
    focusFirst: () => void;
}

export function createLocalGraphView(host: LocalGraphHost): LocalGraphView {
    ensureLocalGraphStyles();
    let depth: GraphDepth = 1;
    let last: FolderIndexState | null = null;

    const element = document.createElement("div");
    element.className = "lg";

    // The depth switch composes the review lists' own toolbar and segments,
    // so the two tabs' controls read as one sidebar's.
    const toolbar = document.createElement("div");
    toolbar.className = "review-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-orientation", "horizontal");
    toolbar.setAttribute("aria-label", t("Graph options"));
    const segs = document.createElement("div");
    segs.className = "review-segmented";
    segs.setAttribute("role", "group");
    segs.setAttribute("aria-label", t("Depth"));
    const makeSeg = (label: string, value: GraphDepth): HTMLButtonElement => {
        const btn = document.createElement("button");
        btn.className = "ui-btn review-seg";
        btn.textContent = label;
        btn.tabIndex = -1;
        btn.dataset["depth"] = String(value);
        bindActivate(btn, () => {
            if (depth === value) { return; }
            depth = value;
            render(last);
        });
        return btn;
    };
    const segNear = makeSeg(t("Neighbours"), 1);
    const segFar = makeSeg(t("Two steps"), 2);
    segs.append(segNear, segFar);
    // The way out to the whole folder, at the trailing edge where the Notes
    // tab keeps its own switch.
    const wholeFolder = document.createElement("button");
    wholeFolder.className = "ui-btn review-seg review-trailing lg-whole-folder";
    wholeFolder.textContent = t("Whole folder");
    wholeFolder.tabIndex = -1;
    bindActivate(wholeFolder, () => host.openFolder());
    toolbar.append(segs, wholeFolder);

    const stage = createRingStage({ openNote: host.openNote, onEscape: host.onEscape, centreIsCurrent: true });
    const caption = document.createElement("div");
    caption.className = "lg-caption";
    const legend = document.createElement("div");
    legend.className = "lg-legend";
    element.append(toolbar, stage.element, caption, legend);

    wireRoving({ container: toolbar, items: () => [segNear, segFar, wholeFolder], orientation: "horizontal", onEscape: host.onEscape });

    function syncSegs(): void {
        for (const [btn, value] of [[segNear, 1], [segFar, 2]] as const) {
            btn.classList.toggle("review-seg--active", depth === value);
            btn.setAttribute("aria-pressed", String(depth === value));
        }
    }

    function render(state: FolderIndexState | null): void {
        last = state;
        syncSegs();
        stage.clear();
        legend.replaceChildren();
        caption.textContent = "";
        const graph = state?.index && state.self !== null ? buildLocalGraph(state.index, state.self, depth) : null;
        if (!graph || graph.nodes.length < 2) {
            caption.textContent = t("No links to or from this note in its folder");
            return;
        }
        const laid = layoutRings(graph, RING_SIZE);
        stage.draw(laid);

        const notes: string[] = [];
        if (laid.omitted > 0) {
            notes.push(t("{0} more not shown").replace("{0}", String(laid.omitted)));
        }
        if (state!.index!.truncated) {
            notes.push(t("This folder has more notes than its index reads"));
        }
        caption.textContent = notes.join(". ");
        fillLegend(legend, laid);
    }

    return {
        element,
        render,
        focusFirst: () => stage.focusFirst(),
    };
}
