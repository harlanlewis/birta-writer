/**
 * components/graph/folderView.ts
 *
 * The whole folder as a graph (MAR-482), opened deliberately from the Graph
 * tab and shown on the fullscreen surface (ui/fullscreenSurface.ts). A
 * diagnostic, not a resident panel: it is opened to find the notes nothing
 * connects, the notes everything does, and the references that name no note,
 * and those three are LISTS beside the drawing, computed exactly
 * (./folderGraph.ts). The lists are also the keyboard's way in, because a
 * canvas has none.
 *
 * The drawing is a canvas, because a folder at the index's cap is thousands
 * of dots and lines, which is past where SVG stays smooth. It is laid out by a
 * force model stepped inside animation frames, a few milliseconds each, so
 * the picture settles visibly and the thread is never held for the folder.
 * Colours are the theme's, resolved from the page when the view opens.
 *
 * Filtering fades rather than removes: a note a filter leaves out stays where
 * the layout put it, faint, so what is kept is still seen in its context.
 */
import { t } from "@/i18n";
import { openFullscreenSurface } from "@/ui/fullscreenSurface";
import type { FolderIndexState } from "@/links/folderIndex";
import { analyzeFolder, createForceLayout, filterNotes, type FolderFilter } from "./folderGraph";
import { hueOf, TYPE_HUES } from "./localGraph";
import { ensureLocalGraphStyles } from "./styles";

export interface FolderGraphHost {
    /** Open a note by its root-relative path. */
    openNote: (path: string) => void;
}

/** Milliseconds of layout each animation frame may spend. */
const FRAME_BUDGET_MS = 6;
/** The fitted drawing's margin, in CSS pixels. */
const FIT_MARGIN = 32;
/** Above this zoom, every note is labelled; below it only the ones in focus. */
const LABEL_ZOOM = 1.6;

const HUE_TOKENS = ["--vscode-charts-blue", "--vscode-charts-purple", "--vscode-charts-green",
    "--vscode-charts-orange", "--vscode-charts-yellow", "--vscode-charts-red"] as const;

/** A theme token as a colour a canvas can paint, whatever it is spelled as. */
function resolveColor(probe: HTMLElement, token: string): string {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
}

/** Open the whole-folder graph over the page. Returns the close function. */
export function openFolderGraph(state: FolderIndexState, host: FolderGraphHost): () => void {
    ensureLocalGraphStyles();
    const index = state.index!;
    const analysis = analyzeFolder(index);
    const layout = createForceLayout(index);
    const nodeByPath = new Map(index.nodes.map((n) => [n.path, n]));
    const types = [...new Set(index.nodes.map((n) => n.type).filter((x): x is string => x !== null))].sort();
    let filter: FolderFilter = { types: null, statuses: null, query: "" };
    let kept = filterNotes(index, filter);
    let focus: Set<string> | null = null;
    let raf = 0;
    let closed = false;

    const surface = openFullscreenSurface({
        ground: "canvas",
        title: t("Folder graph: {0}").replace("{0}", index.rootName),
        className: "fg-surface",
        onClose: () => {
            closed = true;
            cancelAnimationFrame(raf);
            resize.disconnect();
        },
    });
    surface.setCanvasColor("var(--vscode-editor-background)");

    const root = document.createElement("div");
    root.className = "fg";
    const stage = document.createElement("div");
    stage.className = "fg-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "fg-canvas";
    canvas.setAttribute("aria-hidden", "true");
    const hoverLabel = document.createElement("div");
    hoverLabel.className = "fg-hover";
    hoverLabel.hidden = true;
    stage.append(canvas, hoverLabel);
    const side = document.createElement("div");
    side.className = "fg-side";
    root.append(stage, side);
    surface.content.append(root);

    const fitBtn = document.createElement("button");
    fitBtn.className = "ui-btn fg-fit";
    fitBtn.textContent = t("Fit");
    fitBtn.addEventListener("click", () => { fit(); draw(); });
    surface.nav.append(fitBtn);

    // ── Colours, resolved once from the theme ────────────────────────────
    const probe = document.createElement("span");
    root.append(probe);
    const colour = {
        line: resolveColor(probe, "--vscode-editorWidget-border"),
        node: resolveColor(probe, "--vscode-descriptionForeground"),
        focus: resolveColor(probe, "--vscode-focusBorder"),
        text: resolveColor(probe, "--vscode-foreground"),
        hues: HUE_TOKENS.map((tok) => resolveColor(probe, tok)),
    };
    probe.remove();
    const font = `${getComputedStyle(root).fontSize} ${getComputedStyle(root).fontFamily}`;

    // ── The lists ────────────────────────────────────────────────────────
    const search = document.createElement("input");
    search.type = "search";
    search.className = "fg-search";
    search.placeholder = t("Filter by name, path or tag");
    search.setAttribute("aria-label", t("Filter by name, path or tag"));
    search.addEventListener("input", () => { setFilter({ ...filter, query: search.value }); });
    side.append(search);

    /**
     * A row of toggle chips over one OKF field. No chip pressed means every
     * value; pressing some keeps only those. `""` is the chip for a note that
     * declares none, and a row appears only when some note declares one.
     */
    function chipRow(
        label: string,
        values: readonly string[],
        noneLabel: string,
        field: "types" | "statuses",
        hue: (value: string) => number | null,
    ): void {
        if (values.length === 0) { return; }
        const chips = document.createElement("div");
        chips.className = "fg-types";
        chips.setAttribute("role", "group");
        chips.setAttribute("aria-label", label);
        for (const value of [...values, ""]) {
            const chip = document.createElement("button");
            const h = value === "" ? null : hue(value);
            chip.className = `ui-btn review-seg fg-type ${h !== null ? `lg-hue-${h}` : ""}`.trim();
            if (field === "types") {
                const dot = document.createElement("span");
                dot.className = "lg-dot";
                chip.append(dot);
            }
            const text = document.createElement("span");
            text.textContent = value === "" ? noneLabel : value;
            chip.append(text);
            chip.setAttribute("aria-pressed", "false");
            chip.addEventListener("click", () => {
                const next = new Set(filter[field] ?? []);
                if (next.has(value)) { next.delete(value); } else { next.add(value); }
                chip.setAttribute("aria-pressed", String(next.has(value)));
                chip.classList.toggle("review-seg--active", next.has(value));
                setFilter({ ...filter, [field]: next.size === 0 ? null : next });
            });
            chips.append(chip);
        }
        side.append(chips);
    }
    chipRow(t("Types"), types, t("No type"), "types", (value) => hueOf(types, value));
    const statuses = [...new Set(index.nodes.map((n) => n.status).filter((x): x is NonNullable<typeof x> => x !== null))].sort();
    chipRow(t("Statuses"), statuses, t("No status"), "statuses", () => null);

    const summary = document.createElement("div");
    summary.className = "fg-summary";
    side.append(summary);

    function section(title: string, rows: Array<{ label: string; detail?: string; path?: string; focus: string[] }>, empty: string): void {
        const head = document.createElement("div");
        head.className = "ui-heading ui-menu-heading fg-heading";
        head.textContent = `${title} (${rows.length})`;
        side.append(head);
        if (rows.length === 0) {
            const none = document.createElement("div");
            none.className = "fg-empty";
            none.textContent = empty;
            side.append(none);
            return;
        }
        const list = document.createElement("div");
        list.className = "fg-list";
        for (const row of rows) {
            const btn = document.createElement("button");
            btn.className = "ui-menu-row fg-row";
            const label = document.createElement("span");
            label.className = "fg-row-label";
            label.textContent = row.label;
            btn.append(label);
            if (row.detail) {
                const detail = document.createElement("span");
                detail.className = "fg-row-detail";
                detail.textContent = row.detail;
                btn.append(detail);
            }
            btn.title = row.path ?? row.label;
            const lit = (): void => { focus = new Set(row.focus); draw(); };
            btn.addEventListener("mouseenter", lit);
            btn.addEventListener("focus", lit);
            btn.addEventListener("mouseleave", () => { focus = null; draw(); });
            btn.addEventListener("blur", () => { focus = null; draw(); });
            if (row.path) {
                const path = row.path;
                btn.addEventListener("click", () => { surface.close(); host.openNote(path); });
            } else {
                btn.setAttribute("aria-disabled", "true");
            }
            list.append(btn);
        }
        side.append(list);
    }

    const nameOf = (p: string): string => nodeByPath.get(p)?.name ?? p;
    section(t("Most connected"), analysis.hubs.map((p) => ({
        label: nameOf(p), detail: String(analysis.degree.get(p) ?? 0), path: p, focus: [p],
    })), t("No note links to another"));
    section(t("Unconnected"), analysis.orphans.map((p) => ({
        label: nameOf(p), path: p, focus: [p],
    })), t("Every note is linked"));
    section(t("Links to no note"), analysis.dangling.map((d) => ({
        label: d.target, detail: String(d.from.length), focus: d.from,
    })), t("Every link finds its note"));
    if (index.truncated) {
        const notice = document.createElement("div");
        notice.className = "fg-empty";
        notice.textContent = t("This folder has more notes than its index reads, so some are missing here");
        side.append(notice);
    }

    // ── Drawing ──────────────────────────────────────────────────────────
    const view = { scale: 1, tx: 0, ty: 0 };
    let fitted = false;

    function setFilter(next: FolderFilter): void {
        filter = next;
        kept = filterNotes(index, filter);
        summary.textContent = kept.size === index.nodes.length
            ? t("{0} notes").replace("{0}", String(index.nodes.length))
            : t("{0} of {1} notes").replace("{0}", String(kept.size)).replace("{1}", String(index.nodes.length));
        draw();
    }

    function fit(): void {
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0) { return; }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [, p] of layout.positions()) {
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
        const w = Math.max(maxX - minX, 1);
        const h = Math.max(maxY - minY, 1);
        view.scale = Math.min((rect.width - FIT_MARGIN * 2) / w, (rect.height - FIT_MARGIN * 2) / h);
        view.tx = rect.width / 2 - ((minX + maxX) / 2) * view.scale;
        view.ty = rect.height / 2 - ((minY + maxY) / 2) * view.scale;
        fitted = true;
    }

    const radius = (p: string): number => 2.5 + Math.min(6, Math.sqrt(analysis.degree.get(p) ?? 0));

    function draw(): void {
        if (closed) { return; }
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0) { return; }
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
            canvas.width = Math.round(rect.width * dpr);
            canvas.height = Math.round(rect.height * dpr);
        }
        if (!fitted) { fit(); }
        const ctx = canvas.getContext("2d");
        if (!ctx) { return; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);
        const pos = layout.positions();
        const sx = (x: number): number => x * view.scale + view.tx;
        const sy = (y: number): number => y * view.scale + view.ty;
        const lit = (p: string): boolean => focus === null || focus.has(p);

        ctx.lineWidth = 1;
        for (const e of index.edges) {
            if (e.to === null || e.to === e.from) { continue; }
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) { continue; }
            const on = kept.has(e.from) && kept.has(e.to) && (focus === null || focus.has(e.from) || focus.has(e.to));
            ctx.globalAlpha = on ? (focus === null ? 0.5 : 0.9) : 0.07;
            ctx.strokeStyle = focus !== null && on ? colour.focus : colour.line;
            ctx.beginPath();
            ctx.moveTo(sx(a.x), sy(a.y));
            ctx.lineTo(sx(b.x), sy(b.y));
            ctx.stroke();
        }
        for (const n of index.nodes) {
            const p = pos.get(n.path);
            if (!p) { continue; }
            const on = kept.has(n.path) && lit(n.path);
            const hue = hueOf(types, n.type);
            ctx.globalAlpha = on ? 1 : 0.15;
            ctx.fillStyle = hue !== null && hue < TYPE_HUES ? colour.hues[hue]! : colour.node;
            ctx.beginPath();
            ctx.arc(sx(p.x), sy(p.y), radius(n.path), 0, Math.PI * 2);
            ctx.fill();
        }
        // Labels only where they can be read: every note once zoomed in, else
        // only the ones in focus.
        ctx.globalAlpha = 1;
        ctx.fillStyle = colour.text;
        ctx.font = font;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (const n of index.nodes) {
            if (!kept.has(n.path)) { continue; }
            const labelled = view.scale >= LABEL_ZOOM || (focus !== null && focus.has(n.path));
            if (!labelled) { continue; }
            const p = pos.get(n.path)!;
            ctx.fillText(n.name, sx(p.x), sy(p.y) + radius(n.path) + 2);
        }
    }

    function frame(): void {
        if (closed) { return; }
        const settled = layout.step(FRAME_BUDGET_MS, () => performance.now());
        // Refit while it settles, so the drawing grows into the view rather
        // than out of it; a reader who has panned or zoomed keeps their view.
        if (!interacted) { fitted = false; }
        draw();
        if (!settled) { raf = requestAnimationFrame(frame); }
        else { root.dataset["settled"] = "true"; }
    }

    // ── Pointer: pan, zoom, hover, open ──────────────────────────────────
    let interacted = false;
    let drag: { x: number; y: number; moved: boolean } | null = null;

    function hit(clientX: number, clientY: number): string | null {
        const rect = canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        let best: string | null = null;
        let bestD = Infinity;
        for (const [path, p] of layout.positions()) {
            if (!kept.has(path)) { continue; }
            const d = Math.hypot(p.x * view.scale + view.tx - x, p.y * view.scale + view.ty - y);
            if (d <= radius(path) + 4 && d < bestD) { best = path; bestD = d; }
        }
        return best;
    }

    canvas.addEventListener("pointerdown", (e) => {
        drag = { x: e.clientX, y: e.clientY, moved: false };
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
        if (drag) {
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; }
            if (drag.moved) {
                interacted = true;
                view.tx += dx;
                view.ty += dy;
                drag.x = e.clientX;
                drag.y = e.clientY;
                draw();
            }
            return;
        }
        const over = hit(e.clientX, e.clientY);
        canvas.style.cursor = over ? "pointer" : "grab";
        if (over) {
            const rect = stage.getBoundingClientRect();
            hoverLabel.hidden = false;
            hoverLabel.textContent = nameOf(over);
            hoverLabel.style.left = `${e.clientX - rect.left + 12}px`;
            hoverLabel.style.top = `${e.clientY - rect.top + 12}px`;
            const next = new Set([over]);
            for (const edge of index.edges) {
                if (edge.from === over && edge.to) { next.add(edge.to); }
                if (edge.to === over) { next.add(edge.from); }
            }
            focus = next;
        } else {
            hoverLabel.hidden = true;
            focus = null;
        }
        draw();
    });
    canvas.addEventListener("pointerup", (e) => {
        const wasDrag = drag?.moved ?? false;
        drag = null;
        if (wasDrag) { return; }
        const over = hit(e.clientX, e.clientY);
        if (over) {
            surface.close();
            host.openNote(over);
        }
    });
    canvas.addEventListener("pointerleave", () => {
        hoverLabel.hidden = true;
        if (!drag) { focus = null; draw(); }
    });
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        interacted = true;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const k = Math.exp(-e.deltaY * 0.0015);
        view.tx = x - (x - view.tx) * k;
        view.ty = y - (y - view.ty) * k;
        view.scale *= k;
        draw();
    }, { passive: false });

    const resize = new ResizeObserver(() => { if (!interacted) { fitted = false; } draw(); });
    resize.observe(stage);

    setFilter(filter);
    raf = requestAnimationFrame(frame);
    return () => surface.close();
}
