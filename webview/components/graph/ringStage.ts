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
 * Lines carry no direction: who is near whom is the picture, and which note
 * names which is the Backlinks tab's to say. Two notes that name each other
 * are one line. Each line bows a little to one side (`curveThrough`), the
 * side and the bow fixed by the pair, so the drawing reads as grown rather
 * than ruled and is the same every time.
 *
 * The outer ring is a TIER, shown selectively: each first-ring note shows
 * its `TIER_SHOWN` liveliest second-ring notes, and the rest of its arc, the
 * dormant ones among them, comes out while it is hovered or focused, lines
 * and all (`tierFor`). The ring that crowds a drawing is the one that says
 * least, so it says it on request.
 */
import { t } from "@/i18n";
import { bindActivate } from "@/ui/dom";
import { wireRoving } from "../sidePanel/keyboardNav";
import { DORMANT_BELOW } from "./folderSignals";
import { hueOf, nudge, type GraphNode, type LocalGraph } from "./localGraph";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The layout square: the SVG's viewBox and the buttons' percentages. */
export const RING_SIZE = 100;
/** How far a line bows from straight, as a fraction of its length, at most. */
const BOW = 0.16;

/** Second-ring notes each first-ring note shows before it is hovered or focused. */
export const TIER_SHOWN = 2;

/**
 * `template` with every `{n}` replaced by the nth value, as written. One pass
 * with a replacer FUNCTION, for two reasons: a replacement STRING reads `$&`,
 * `$'` and the rest as patterns, and a note's name or a folder's is the
 * reader's own text, which may hold them; and one placeholder at a time
 * would substitute into a value already placed, should a name hold `{1}`.
 */
export function fill(template: string, ...values: string[]): string {
    return template.replace(/\{(\d+)\}/g, (placeholder, i: string) => values[Number(i)] ?? placeholder);
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
    /**
     * Draw a graph already placed by `layoutRings`. `centreIsCurrent`, when
     * given, overrides the host's for this drawing: a view whose centre is
     * chosen per drawing knows only then whether it is the note on screen.
     */
    draw: (laid: LocalGraph, centreIsCurrent?: boolean) => void;
    /** Empty the square. */
    clear: () => void;
    /** Move keyboard focus onto the first node that can be reached. */
    focusFirst: () => void;
}

/** A dot's size step, 1 to 4, by how connected the note is. */
function sizeStep(degree: number): number {
    return degree >= 12 ? 4 : degree >= 6 ? 3 : degree >= 2 ? 2 : 1;
}

/**
 * A path from a to b bowed to one side: a quadratic curve through a control
 * point off the midpoint, perpendicular to the line, by up to `BOW` of its
 * length. Which side and how far are `nudge`s of the pair, ordered, so the
 * same two notes bow the same way whichever is named first.
 */
export function curveThrough(a: { id: string; x: number; y: number }, b: { id: string; x: number; y: number }): string {
    const [p, q] = a.id < b.id ? [a, b] : [b, a];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const key = `${p.id}\u0000${q.id}`;
    const bow = (nudge(key, 3) < 0.5 ? -1 : 1) * BOW * (0.4 + 0.6 * nudge(key, 4));
    const cx = (p.x + q.x) / 2 - dy * bow;
    const cy = (p.y + q.y) / 2 + dx * bow;
    const f = (v: number): string => v.toFixed(2);
    return `M${f(p.x)},${f(p.y)} Q${f(cx)},${f(cy)} ${f(q.x)},${f(q.y)}`;
}

/**
 * Which second-ring notes wait for their parent: past the `TIER_SHOWN`
 * liveliest of each first-ring note's arc (activity, then how connected, then
 * name), and any dormant one. A drawing with no activity at all (the Graph
 * tab) ranks by how connected alone.
 */
export function tierFor(laid: LocalGraph): Set<string> {
    const byParent = new Map<string, GraphNode[]>();
    for (const n of laid.nodes) {
        if (n.ring !== 2 || n.parent === undefined) { continue; }
        if (!byParent.has(n.parent)) { byParent.set(n.parent, []); }
        byParent.get(n.parent)!.push(n);
    }
    const waiting = new Set<string>();
    for (const children of byParent.values()) {
        children
            .sort((a, b) => (b.activity ?? -1) - (a.activity ?? -1) || b.degree - a.degree || a.label.localeCompare(b.label))
            .forEach((n, i) => {
                const dormant = typeof n.activity === "number" && n.activity < DORMANT_BELOW;
                if (i >= TIER_SHOWN || dormant) { waiting.add(n.id); }
            });
    }
    return waiting;
}

export function createRingStage(host: RingStageHost): RingStage {
    const stage = document.createElement("div");
    stage.className = "lg-stage";
    const nodeRoving = wireRoving({
        container: stage,
        // A waiting tier note is reachable once its parent has opened it.
        items: () => [...stage.querySelectorAll<HTMLElement>(".lg-node:not(:disabled):not(.lg-node--tier:not(.lg-tier-open))")],
        onEscape: host.onEscape,
    });

    /**
     * Lines are not drawn at rest: where a note sits already says how bound
     * and how related it is (./localGraph.ts `layoutRings`), and a web of
     * lines over that says it again, louder, and buries the names. A note
     * pointed at or focused shows its place in the tree the rings draw: the
     * way back to the centre (for an outer-ring note, the centre to the note
     * it hangs from, and that note to it), and the way out to its own first
     * layer of children (for the centre, its ring; for a first-ring note, the
     * outer notes that hang from it). Ties between neighbours are left out:
     * that two notes sit side by side already says it.
     */
    function lightFor(id: string | null): void {
        stage.classList.toggle("lg-stage--lit", id !== null);
        const nodes = [...stage.querySelectorAll<HTMLElement>(".lg-node")];
        const up = new Map<string, string>();
        const centre = nodes.find((n) => n.classList.contains("lg-node--self"))?.dataset["id"];
        for (const n of nodes) {
            const nid = n.dataset["id"]!;
            if (n.dataset["parent"] !== undefined) { up.set(nid, n.dataset["parent"]); }
            else if (n.dataset["ring"] === "1" && centre !== undefined) { up.set(nid, centre); }
        }
        // The tree's edges to light: each step from `id` back to the centre,
        // and each from `id` out to a note one layer further.
        const lit = new Set<string>();
        const key = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
        if (id !== null) {
            for (let at = id, next = up.get(at); next !== undefined; at = next, next = up.get(at)) { lit.add(key(at, next)); }
            for (const [child, parent] of up) { if (parent === id) { lit.add(key(child, id)); } }
        }
        for (const el of stage.querySelectorAll<SVGElement>("[data-from]")) {
            el.classList.toggle("lg-lit", lit.has(key(el.dataset["from"]!, el.dataset["to"]!)));
        }
        const parent = id === null ? undefined : nodes.find((n) => n.dataset["id"] === id)?.dataset["parent"];
        // The tier a node opens: its own arc, or, for a tier note, the arc it
        // is in, so moving from a parent onto one of its notes keeps it open.
        const open = parent ?? id;
        for (const el of stage.querySelectorAll<HTMLElement | SVGElement>("[data-tier]")) {
            el.classList.toggle("lg-tier-open", open !== null && el.dataset["tier"] === open);
        }
    }

    let centreIsCurrent = host.centreIsCurrent;

    function nodeButton(node: GraphNode, graph: LocalGraph): HTMLButtonElement {
        const btn = document.createElement("button");
        const hue = hueOf(graph.types, node.type);
        const current = node.ring === 0 && centreIsCurrent;
        btn.className = [
            "lg-node",
            `lg-size-${sizeStep(node.degree)}`,
            node.ring === 0 ? "lg-node--self" : "",
            node.ring === 0 && !current ? "lg-node--opens" : "",
            node.dangling ? "lg-node--dangling" : "",
            // Known and low: a note nothing has touched in a long while. An
            // unknown activity draws as it always has, since it claims nothing.
            typeof node.activity === "number" && node.activity < DORMANT_BELOW ? "lg-node--dormant" : "",
            hue !== null ? `lg-hue-${hue}` : "",
        ].filter(Boolean).join(" ");
        btn.style.left = `${node.x}%`;
        btn.style.top = `${node.y}%`;
        btn.tabIndex = -1;
        btn.dataset["id"] = node.id;
        btn.dataset["ring"] = String(node.ring);
        // The name is the mark; the dot is what a note falls back to where
        // the drawing has no room for its name (`declutterLabels`).
        const dot = document.createElement("span");
        dot.className = "lg-dot";
        // The chip and the words in it are two boxes so the words can fade
        // (dormant) while the chip stays opaque over the lines behind it.
        const label = document.createElement("span");
        label.className = "lg-label";
        const words = document.createElement("span");
        words.className = "lg-label-text";
        words.textContent = node.label;
        label.append(words);
        btn.append(dot, label);
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
     * Fall back to a dot for every note whose name the drawing has no room
     * for, so no two names overlap and none runs out of the square, at
     * whatever width the square has. Measured rather than predicted: a name's
     * width is the font's, and a layout tuned to one width collides at the
     * next. Names are kept in the order the nodes come in (the centre, then
     * the first ring, most connected first, then the outer ring), so a name
     * that gives way is always the less central one. A compact note is named
     * on hover and focus. With no layout (a test with no engine) every rect
     * is empty and every name stays.
     */
    function declutterLabels(): void {
        const buttons = [...stage.querySelectorAll<HTMLElement>(".lg-node")];
        buttons.forEach((b) => b.classList.remove("lg-node--compact"));
        const box = stage.getBoundingClientRect();
        const kept: DOMRect[] = [];
        const hits = (a: DOMRect, b: DOMRect): boolean =>
            a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        // Measured all at once, before any note gives way, so one note going
        // compact cannot change what the next is measured against.
        const rects = buttons.map((b) => b.querySelector<HTMLElement>(".lg-label")!.getBoundingClientRect());
        buttons.forEach((btn, i) => {
            const r = rects[i]!;
            if (r.width === 0) { return; }
            // A note waiting in the outer tier is not on the drawing, and
            // claims no room until it is.
            if (btn.classList.contains("lg-node--tier")) { btn.classList.add("lg-node--compact"); return; }
            const clash = kept.some((k) => hits(k, r))
                || r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1;
            if (clash) { btn.classList.add("lg-node--compact"); } else { kept.push(r); }
        });
    }

    function draw(laid: LocalGraph, current?: boolean): void {
        centreIsCurrent = current ?? host.centreIsCurrent;
        const at = new Map(laid.nodes.map((n) => [n.id, n]));
        const waiting = tierFor(laid);
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "lg-lines");
        svg.setAttribute("viewBox", `0 0 ${RING_SIZE} ${RING_SIZE}`);
        svg.setAttribute("aria-hidden", "true");
        const drawn = new Set<string>();
        for (const line of laid.lines) {
            const a = at.get(line.from)!;
            const b = at.get(line.to)!;
            // One line a pair: a note naming the other back is the same tie.
            const pair = a.id < b.id ? `${a.id}\u0000${b.id}` : `${b.id}\u0000${a.id}`;
            if (drawn.has(pair)) { continue; }
            drawn.add(pair);
            const el = document.createElementNS(SVG_NS, "path");
            el.setAttribute("class", "lg-line");
            el.setAttribute("d", curveThrough(a, b));
            el.dataset["from"] = line.from;
            el.dataset["to"] = line.to;
            // A line to a waiting note waits with it, and opens with its tier.
            const tierNote = waiting.has(a.id) ? a : waiting.has(b.id) ? b : null;
            if (tierNote?.parent !== undefined) {
                el.classList.add("lg-line--tier");
                el.dataset["tier"] = tierNote.parent;
            }
            svg.append(el);
        }
        stage.replaceChildren(svg, ...laid.nodes.map((n) => {
            const btn = nodeButton(n, laid);
            if (n.parent !== undefined) { btn.dataset["parent"] = n.parent; }
            if (waiting.has(n.id) && n.parent !== undefined) {
                btn.classList.add("lg-node--tier");
                btn.dataset["tier"] = n.parent;
            }
            return btn;
        }));
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
