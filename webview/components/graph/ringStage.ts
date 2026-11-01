/**
 * components/graph/ringStage.ts
 *
 * The drawing of a ring-laid graph (./localGraph.ts), shared by the review
 * sidebar's Graph tab (./index.ts) and the folder overview
 * (./folderOverview.ts): the lines, the dots, their labels, and the legend.
 * What differs between the two is only what the centre is. In the Graph tab
 * it is the note on screen, which opens nothing; in the overview it is the
 * folder's hub, which is a note like any other and opens.
 *
 * Nodes are buttons laid over an SVG that draws only the lines: a button has
 * focus, a keyboard and a click of its own, and the roving helper walks them
 * like any other row (components/sidePanel/keyboardNav.ts). Both layers use
 * one 0 to 100 square, the SVG through its viewBox and the buttons through
 * percentages, so nothing here is measured and the drawing is the same in a
 * docked drawer, the flyout, the overview and a test with no layout at all.
 *
 * Direction is a small arrowhead at each line's midpoint, where it cannot be
 * hidden under a dot of any size.
 */
import { t } from "@/i18n";
import { bindActivate } from "@/ui/dom";
import { wireRoving } from "../sidePanel/keyboardNav";
import { hueOf, type GraphNode, type LocalGraph } from "./localGraph";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The layout square: the SVG's viewBox and the buttons' percentages. */
export const RING_SIZE = 100;
/** Half the length of a midpoint arrowhead, in layout units. */
const ARROW = 1.3;

/**
 * `template` with every `{0}` replaced by `value`, as written. Never
 * `String.replace` with a string: it reads `$&`, `$'` and the rest in the
 * replacement as patterns, and a note's name or a folder's is the reader's
 * own text, which may hold them.
 */
export function fill(template: string, value: string): string {
    return template.split("{0}").join(value);
}

export interface RingStageHost {
    /** Open a note by its root-relative path. */
    openNote: (path: string) => void;
    /** Where Escape sends focus. */
    onEscape: () => void;
    /**
     * Whether the centre is the note already on screen (drawn current, opens
     * nothing) or a note to go to like any other.
     */
    centreIsCurrent: boolean;
}

export interface RingStage {
    /** The square the drawing is laid out in. */
    element: HTMLElement;
    /** Draw a graph already placed by `layoutRings`. */
    draw: (laid: LocalGraph) => void;
    /** Empty the square. */
    clear: () => void;
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

export function createRingStage(host: RingStageHost): RingStage {
    const stage = document.createElement("div");
    stage.className = "lg-stage";
    const nodeRoving = wireRoving({
        container: stage,
        items: () => [...stage.querySelectorAll<HTMLElement>(".lg-node:not(:disabled)")],
        onEscape: host.onEscape,
    });

    function lightFor(id: string | null): void {
        stage.classList.toggle("lg-stage--lit", id !== null);
        for (const el of stage.querySelectorAll<SVGElement>("[data-from]")) {
            el.classList.toggle("lg-lit", id !== null && (el.dataset["from"] === id || el.dataset["to"] === id));
        }
    }

    function nodeButton(node: GraphNode, graph: LocalGraph): HTMLButtonElement {
        const btn = document.createElement("button");
        const hue = hueOf(graph.types, node.type);
        const current = node.ring === 0 && host.centreIsCurrent;
        btn.className = [
            "lg-node",
            `lg-size-${sizeStep(node.degree)}`,
            node.ring === 0 ? "lg-node--self" : "",
            node.ring === 0 && !current ? "lg-node--opens" : "",
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
            ? fill(t("{0} (not a note in this folder)"), node.label)
            : node.type !== null ? `${node.label} (${node.type})` : node.label;
        btn.title = node.dangling || current ? described : node.id;
        btn.setAttribute("aria-label", described);
        if (node.dangling) { btn.disabled = true; }
        else if (current) { btn.setAttribute("aria-current", "page"); }
        else { bindActivate(btn, () => host.openNote(node.id)); }
        btn.addEventListener("mouseenter", () => lightFor(node.id));
        btn.addEventListener("mouseleave", () => lightFor(null));
        btn.addEventListener("focus", () => lightFor(node.id));
        btn.addEventListener("blur", () => lightFor(null));
        return btn;
    }

    /**
     * Hide every label the drawing has no room for, so none overlaps another
     * label or covers another node's dot, at whatever width the square has.
     * Measured rather than predicted: a label's width is the font's, and a
     * layout tuned to one width collides at the next. Labels are kept in the
     * order the nodes come in (the centre, then the most connected first), and
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

    function draw(laid: LocalGraph): void {
        const at = new Map(laid.nodes.map((n) => [n.id, n]));
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "lg-lines");
        svg.setAttribute("viewBox", `0 0 ${RING_SIZE} ${RING_SIZE}`);
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
        stage.replaceChildren(svg, ...laid.nodes.map((n) => nodeButton(n, laid)));
        declutterLabels();
        nodeRoving.refresh();
    }

    return {
        element: stage,
        draw,
        clear: () => stage.replaceChildren(),
        focusFirst: () => nodeRoving.focusFirst(),
    };
}

/**
 * Fill `legend` with one row per hued type; types past the palette share the
 * neutral dot and one "Other types" row.
 */
export function fillLegend(legend: HTMLElement, laid: LocalGraph): void {
    legend.replaceChildren();
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
