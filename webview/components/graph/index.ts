/**
 * components/graph/index.ts
 *
 * The review sidebar's Graph tab body (MAR-481): this note's local graph,
 * drawn from the host's folder index. The chunk this is in loads the first
 * time the tab is shown (utils/localGraphLoader.ts), and its CSS is injected
 * on the first render (./styles.ts), so a sidebar nobody switches to this tab
 * in pays nothing for it.
 *
 * Nodes are buttons laid over an SVG that draws only the lines: a button has
 * focus, a keyboard and a click of its own, and the sidebar's roving helper
 * walks them like any other row (components/sidePanel/keyboardNav.ts). Both
 * layers use one 0 to 100 square, the SVG through its viewBox and the buttons
 * through percentages, so nothing here is measured and the drawing is the
 * same in a docked drawer, the flyout and a test with no layout at all.
 *
 * A node opens its note; this note and a dangling reference open nothing.
 * Direction is a small arrowhead at each line's midpoint, where it cannot be
 * hidden under a dot of any size.
 */
import { t } from "@/i18n";
import type { FolderIndexState } from "@/links/folderIndex";
import { bindActivate } from "@/ui/dom";
import { wireRoving } from "../sidePanel/keyboardNav";
import { buildLocalGraph, hueOf, layoutRings, type GraphDepth, type GraphNode, type LocalGraph } from "./localGraph";
import { ensureLocalGraphStyles } from "./styles";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The layout square: the SVG's viewBox and the buttons' percentages. */
const SIZE = 100;
/** Half the length of a midpoint arrowhead, in layout units. */
const ARROW = 1.3;

export interface LocalGraphHost {
    /** Open a note by its root-relative path. */
    openNote: (path: string) => void;
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

/** A dot's size step, 1 to 4, by how connected the note is. */
function sizeStep(degree: number): number {
    return degree >= 12 ? 4 : degree >= 6 ? 3 : degree >= 2 ? 2 : 1;
}

function arrowPoints(ax: number, ay: number, bx: number, by: number): string | null {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < ARROW * 4) { return null; }
    const ux = dx / len;
    const uy = dy / len;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const tip = [mx + ux * ARROW, my + uy * ARROW];
    const left = [mx - ux * ARROW - uy * ARROW * 0.8, my - uy * ARROW + ux * ARROW * 0.8];
    const right = [mx - ux * ARROW + uy * ARROW * 0.8, my - uy * ARROW - ux * ARROW * 0.8];
    return [tip, left, right].map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" ");
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
    toolbar.append(segs);

    const stage = document.createElement("div");
    stage.className = "lg-stage";
    const caption = document.createElement("div");
    caption.className = "lg-caption";
    const legend = document.createElement("div");
    legend.className = "lg-legend";
    element.append(toolbar, stage, caption, legend);

    wireRoving({ container: toolbar, items: () => [segNear, segFar], orientation: "horizontal", onEscape: host.onEscape });
    const nodeRoving = wireRoving({
        container: stage,
        items: () => [...stage.querySelectorAll<HTMLElement>(".lg-node:not(:disabled)")],
        onEscape: host.onEscape,
    });

    function syncSegs(): void {
        for (const [btn, value] of [[segNear, 1], [segFar, 2]] as const) {
            btn.classList.toggle("review-seg--active", depth === value);
            btn.setAttribute("aria-pressed", String(depth === value));
        }
    }

    function lightFor(id: string | null): void {
        stage.classList.toggle("lg-stage--lit", id !== null);
        for (const el of stage.querySelectorAll<SVGElement>("[data-from]")) {
            el.classList.toggle("lg-lit", id !== null && (el.dataset["from"] === id || el.dataset["to"] === id));
        }
    }

    function nodeButton(node: GraphNode, graph: LocalGraph): HTMLButtonElement {
        const btn = document.createElement("button");
        const hue = hueOf(graph.types, node.type);
        btn.className = [
            "lg-node",
            `lg-size-${sizeStep(node.degree)}`,
            node.ring === 0 ? "lg-node--self" : "",
            node.dangling ? "lg-node--dangling" : "",
            hue !== null ? `lg-hue-${hue}` : "",
        ].filter(Boolean).join(" ");
        btn.style.left = `${node.x}%`;
        btn.style.top = `${node.y}%`;
        btn.tabIndex = -1;
        btn.dataset["id"] = node.id;
        const dot = document.createElement("span");
        dot.className = "lg-dot";
        btn.append(dot);
        // The outer ring is where the crowding is, so its names are on hover
        // and in the accessible name rather than on the drawing.
        if (node.ring < 2) {
            const label = document.createElement("span");
            label.className = "lg-label";
            label.textContent = node.label;
            btn.append(label);
        }
        const described = node.dangling
            ? t("{0} (not a note in this folder)").replace("{0}", node.label)
            : node.type !== null ? `${node.label} (${node.type})` : node.label;
        btn.title = node.dangling || node.ring === 0 ? described : node.id;
        btn.setAttribute("aria-label", described);
        if (node.dangling) { btn.disabled = true; }
        else if (node.ring === 0) { btn.setAttribute("aria-current", "page"); }
        else { bindActivate(btn, () => host.openNote(node.id)); }
        btn.addEventListener("mouseenter", () => lightFor(node.id));
        btn.addEventListener("mouseleave", () => lightFor(null));
        btn.addEventListener("focus", () => lightFor(node.id));
        btn.addEventListener("blur", () => lightFor(null));
        return btn;
    }

    /**
     * Hide every label the drawing has no room for, so none overlaps another
     * label or covers another node's dot, at whatever width the drawer has.
     * Measured rather than predicted: a label's width is the font's, and a
     * layout tuned to one width collides at the next. Labels are kept in the
     * order the nodes come in (this note, then the most connected first), and
     * a hidden one is named on hover and focus instead. With no layout (a test
     * with no engine) every rect is empty and every label stays.
     */
    function declutterLabels(): void {
        const buttons = [...stage.querySelectorAll<HTMLElement>(".lg-node")];
        const dots = new Map(buttons.map((b) => [b, b.querySelector(".lg-dot")!.getBoundingClientRect()]));
        const box = stage.getBoundingClientRect();
        const kept: DOMRect[] = [];
        const hits = (a: DOMRect, b: DOMRect): boolean =>
            a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        for (const btn of buttons) {
            const label = btn.querySelector<HTMLElement>(".lg-label");
            if (!label) { continue; }
            label.classList.remove("lg-label--crowded");
            const r = label.getBoundingClientRect();
            if (r.width === 0) { continue; }
            const clash = kept.some((k) => hits(k, r))
                || buttons.some((other) => other !== btn && hits(dots.get(other)!, r))
                || r.left < box.left - 1 || r.right > box.right + 1;
            if (clash) { label.classList.add("lg-label--crowded"); } else { kept.push(r); }
        }
    }

    function render(state: FolderIndexState | null): void {
        last = state;
        syncSegs();
        stage.replaceChildren();
        legend.replaceChildren();
        caption.textContent = "";
        const graph = state?.index && state.self !== null ? buildLocalGraph(state.index, state.self, depth) : null;
        if (!graph || graph.nodes.length < 2) {
            caption.textContent = t("No links to or from this note in its folder");
            return;
        }
        const laid = layoutRings(graph, SIZE);
        const at = new Map(laid.nodes.map((n) => [n.id, n]));

        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "lg-lines");
        svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
        svg.setAttribute("aria-hidden", "true");
        for (const line of laid.lines) {
            const a = at.get(line.from)!;
            const b = at.get(line.to)!;
            const el = document.createElementNS(SVG_NS, "line");
            el.setAttribute("class", "lg-line");
            el.setAttribute("x1", a.x.toFixed(2));
            el.setAttribute("y1", a.y.toFixed(2));
            el.setAttribute("x2", b.x.toFixed(2));
            el.setAttribute("y2", b.y.toFixed(2));
            el.dataset["from"] = line.from;
            el.dataset["to"] = line.to;
            svg.append(el);
            const points = arrowPoints(a.x, a.y, b.x, b.y);
            if (points) {
                const arrow = document.createElementNS(SVG_NS, "polygon");
                arrow.setAttribute("class", "lg-arrow");
                arrow.setAttribute("points", points);
                arrow.dataset["from"] = line.from;
                arrow.dataset["to"] = line.to;
                svg.append(arrow);
            }
        }
        stage.append(svg, ...laid.nodes.map((n) => nodeButton(n, laid)));
        declutterLabels();
        nodeRoving.refresh();

        const notes: string[] = [];
        if (laid.omitted > 0) {
            notes.push(t("{0} more not shown").replace("{0}", String(laid.omitted)));
        }
        if (state!.index!.truncated) {
            notes.push(t("This folder has more notes than its index reads"));
        }
        caption.textContent = notes.join(". ");

        // One row per hued type; types past the palette share the neutral dot
        // and one "Other types" row.
        const legendItem = (hueClass: string, text: string): HTMLElement => {
            const item = document.createElement("span");
            item.className = `lg-legend-item ${hueClass}`.trim();
            const dot = document.createElement("span");
            dot.className = "lg-dot";
            const name = document.createElement("span");
            name.textContent = text;
            item.append(dot, name);
            return item;
        };
        const hued = laid.types.filter((type) => hueOf(laid.types, type) !== null);
        for (const type of hued) { legend.append(legendItem(`lg-hue-${hueOf(laid.types, type)}`, type)); }
        if (hued.length < laid.types.length) { legend.append(legendItem("", t("Other types"))); }
    }

    return {
        element,
        render,
        focusFirst: () => nodeRoving.focusFirst(),
    };
}
