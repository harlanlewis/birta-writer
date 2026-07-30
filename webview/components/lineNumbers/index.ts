/**
 * components/lineNumbers/index.ts
 *
 * The optional source line-number gutter (`birta.lineNumbers`, default OFF): a
 * quiet column of document line numbers along the viewport's start edge, so a
 * diff, a compiler error, or a review comment that cites "line 214" can be
 * found without leaving the rendered document.
 *
 * ## Why this is not a ProseMirror decoration
 *
 * Widget decorations sit in the document flow: ProseMirror position-maps the
 * whole set on every keystroke and diffs it against the DOM on every redraw.
 * Measured on the 300 KB typing fixture, the block gutter's decorations cost
 * ~10 ms of `DecorationSet.map` plus roughly twice that again in redraw, out of
 * a 65 ms dispatch (MAR-215; see `plugins/visibleRange.ts`). A number per source
 * line is a denser set than that one. Decorations also cannot escape their
 * block's box to reach the viewport edge.
 *
 * So this is an external layer, and ProseMirror never learns it exists — no
 * decoration mapping, no redraw diffing, and no contenteditable surface to
 * corrupt.
 *
 * ## Why the tops are in document coordinates
 *
 * The layer is `position: absolute` with tops measured into DOCUMENT space, so
 * the numbers are glued to the content they label and **scrolling costs nothing
 * at all**. A viewport-fixed layer would have to re-measure every visible line
 * on every scroll frame. The x edge is still the viewport's because the page
 * never scrolls horizontally (the content column is width-capped and wide tables
 * scroll inside their own boxes).
 *
 * ## What is windowed, and what that buys
 *
 * Only the visible slice (plus two screens of margin) is measured or present in
 * the DOM, via `observeVisibleWindow` — the same observer the block gutter uses,
 * with the same half-screen scroll hysteresis and document-height detection
 * (which is what catches a Mermaid diagram or an image finishing and pushing
 * content down). Reusing it rather than inventing a second windowing policy is
 * deliberate: there is one place to get this wrong, not two.
 *
 * ## Two costs this is careful never to pay
 *
 * - **Nothing on the mount path.** The first paint is deferred to an idle
 *   callback, and the observer is only `start()`ed there — its own header
 *   explains that a window arriving before first paint drags the whole layer's
 *   DOM insertion, layout and paint in FRONT of the paint mark.
 * - **Nothing on the keystroke path.** `refresh()` coalesces into a single idle
 *   callback, so a typing burst schedules one repaint rather than one per
 *   transaction. Measurement (`getBoundingClientRect` / `coordsAtPos`) is
 *   strictly a READ phase followed by a WRITE phase, never interleaved.
 *
 * ## Bounded staleness
 *
 * The numbers come from the cached markdown source, which refreshes on the
 * SYNC cadence, not per keystroke: immediate on the first edit after a pause,
 * otherwise ≤300 ms after typing stops and ≤2 s under continuous typing
 * (`webview/syncScheduler.ts`). During a burst that adds lines the numbers
 * therefore lag and then catch up. This is not a bug to work around:
 * re-serializing per keystroke is O(document) and explicitly forbidden (see
 * AGENTS.md → "View→document sync invariant"). Between refreshes the index
 * still walks the CURRENT document, so anchors that no longer match degrade to
 * contiguous positions rather than jumping — and a block the stale source
 * cannot verify is left unnumbered instead of numbered wrongly.
 */
import type { EditorView } from "../../pm";
import { sourceLineIndex, type SourceLineEntry } from "../../utils/sourceCaret";
import { isHiddenTargetPos } from "../../plugins/headingFold/foldModel";
import { observeVisibleWindow, type VisibleWindow } from "../../plugins/visibleRange";
import { requestIdle } from "../../utils/idle";
import { hasMark } from "../../perf";
import { layoutLineNumbers, type MeasuredLine, type PlacedLine } from "./layout";
import { ensureLineNumberStyles } from "./styles";

/**
 * How long an idle repaint may be deferred. Long enough that a typing burst
 * coalesces into one pass, short enough that the numbers never feel detached
 * from the document.
 */
const IDLE_TIMEOUT_MS = 400;

/** Fallback gutter line-height when the layer's computed style is unreadable. */
const FALLBACK_GUTTER_LINE_HEIGHT = 14;
/** Fallback content line-height (the content column's `line-height: 1.6`). */
const FALLBACK_CONTENT_LINE_HEIGHT = 20;

/** Everything the gutter needs from the webview's module state. */
export interface LineNumbersHost {
    getView: () => EditorView | null;
    /** Block start lines for the cached source (shared/lineMap.ts). */
    getLineMap: () => number[];
    /** The cached BODY markdown — the frontmatter is not part of it. */
    getMarkdownSource: () => string;
    /** Source lines the frontmatter occupies, added to reach document lines. */
    getLineOffset: () => number;
}

export interface LineNumbersController {
    /** Turn the gutter on. Idempotent; the first paint lands on idle. */
    enable(): void;
    /** Turn it off and remove every trace from the DOM. Idempotent. */
    disable(): void;
    /** The document, the source, the fold state or the layout changed. */
    refresh(): void;
    destroy(): void;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** A computed `line-height` in px, with a sane fallback for `normal`/unset. */
function readLineHeight(el: HTMLElement, fallback: number): number {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    if (!style) { return fallback; }
    const lineHeight = Number.parseFloat(style.lineHeight);
    if (Number.isFinite(lineHeight) && lineHeight > 0) { return lineHeight; }
    const fontSize = Number.parseFloat(style.fontSize);
    return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.5 : fallback;
}

/** A rect with no area at the origin is what `display: none` measures as. */
function isDegenerate(rect: { top: number; bottom: number; left: number }): boolean {
    return rect.top === 0 && rect.bottom === 0 && rect.left === 0;
}

export function createLineNumbers(host: LineNumbersHost): LineNumbersController {
    let layer: HTMLElement | null = null;
    const pool: HTMLElement[] = [];
    let observer: ReturnType<typeof observeVisibleWindow> | null = null;
    let observedView: EditorView | null = null;
    let reflow: ResizeObserver | null = null;
    let visible: VisibleWindow | null = null;
    let frame: number | null = null;
    let idle: { cancel: () => void } | null = null;
    let enabled = false;
    let gutterLineHeight = FALLBACK_GUTTER_LINE_HEIGHT;

    /** Coalesce a repaint onto the next frame. */
    const schedule = (): void => {
        if (!enabled || frame !== null) { return; }
        frame = requestAnimationFrame(() => {
            frame = null;
            render();
        });
    };

    /**
     * Bind (or rebind) to the live view. The view can arrive after the setting
     * is enabled (an `init` message enables before the editor exists) and is
     * replaced wholesale on a re-init, so the binding is resolved lazily and
     * re-checked by identity rather than captured once.
     */
    const bind = (): EditorView | null => {
        const view = host.getView();
        if (!view || view.isDestroyed) { return null; }
        if (observer && observedView === view) { return view; }
        observer?.destroy();
        reflow?.disconnect();
        observedView = view;
        observer = observeVisibleWindow(view, (next) => {
            visible = next;
            schedule();
        });
        // Any reflow moves every top below it, and the visible-window observer
        // deliberately ignores height changes under half a screen — a font-size
        // or content-width change moves everything while changing total height
        // barely at all. That case is this observer's job, not that one's.
        reflow = typeof ResizeObserver === "function"
            ? new ResizeObserver(() => { refresh(); })
            : null;
        reflow?.observe(view.dom);
        observer.start();
        return view;
    };

    /** Measure one entry into document coordinates, or null if it can't be. */
    const measureTop = (
        view: EditorView,
        entry: SourceLineEntry,
        contentLineHeight: number,
        scrollY: number,
    ): number | null => {
        if (entry.pos === null) { return null; }
        // Folded content is `display: none`; a position inside it has no top
        // worth claiming, and the fold's own marker line is already numbered.
        if (isHiddenTargetPos(view.state, entry.pos)) { return null; }
        // A line with a TEXT position is measured from that text, not from its
        // block's element box. The two are far apart for exactly the blocks
        // where it matters: a heading's `--content-heading-before` is PADDING,
        // so an h1's border box starts ~30 px above its glyphs, and a number
        // aligned to it lands in the space above the heading — closer to the
        // blank line's number than to the heading's own. The text rect is where
        // the reader's eye is.
        const text = entry.pos === entry.nodePos ? null : posRect(view, entry.pos);
        if (text) {
            // Centre the gutter's line box on the text's, so the two read as one
            // row whatever the content's font size.
            return text.top + (text.bottom - text.top - gutterLineHeight) / 2 + scrollY;
        }
        // No text position: a fence, a container marker, or a leaf block with no
        // text at all. Its box IS the line — and this is also the path that keeps
        // a code block in preview mode (Mermaid, LaTeX) correct, whose text is
        // not on screen to measure.
        const box = nodeRect(view, entry.nodePos) ?? posRect(view, entry.pos);
        if (!box) { return null; }
        // A closing marker renders at the BOTTOM of the box it closes.
        return (entry.bottom ? box.bottom - contentLineHeight : box.top) + scrollY;
    };

    /**
     * Where the space after this line begins: the bottom of the element box
     * that renders it.
     *
     * Deliberately the node's box rather than the text rect `measureTop` used —
     * a source line is one line of source and any number of rendered rows, and
     * what follows it follows ALL of them. The box also covers the cases with
     * no text to measure at all (an embed card, an image, a code fence).
     */
    const measureBottom = (view: EditorView, entry: SourceLineEntry, scrollY: number): number | null => {
        const box = nodeRect(view, entry.nodePos);
        return box ? box.bottom + scrollY : null;
    };

    /** A node's own element box. */
    const nodeRect = (view: EditorView, nodePos: number): DOMRect | null => {
        try {
            const dom = view.nodeDOM(nodePos);
            if (!(dom instanceof HTMLElement)) { return null; }
            const rect = dom.getBoundingClientRect();
            return isDegenerate(rect) ? null : rect;
        } catch {
            return null;
        }
    };

    /** A text position's own rect — the inline box the glyphs occupy. */
    const posRect = (view: EditorView, pos: number): { top: number; bottom: number } | null => {
        try {
            const coords = view.coordsAtPos(pos);
            return isDegenerate(coords) || coords.bottom <= coords.top ? null : coords;
        } catch {
            // coordsAtPos touches layout APIs a bare DOM implementation lacks.
            return null;
        }
    };

    const render = (): void => {
        if (!enabled || !layer) { return; }
        // Never before the editor's first painted frame. This pass measures
        // every visible line, inserts a span each, and paints them — in front of
        // `editor-painted` that whole cost lands on the mount path, which is
        // exactly what the deferral is for. Enabling the setting at panel load
        // can otherwise win the race against the paint mark (the idle callback
        // fires as soon as the main thread frees up, which may be the moment
        // Milkdown finishes building the doc). The post-paint refresh in
        // webview/index.ts is what drives the first pass instead. Guarded by
        // e2e/lineNumbers, which reads the DOM synchronously at the mark.
        if (!hasMark("editor-painted")) { return; }
        const view = bind();
        if (!view) { return; }
        const source = host.getMarkdownSource();
        const lineMap = host.getLineMap();
        if (!source || !lineMap.length) { paint([]); return; }

        const doc = view.state.doc;
        const size = doc.content.size;
        const from = clamp(visible?.from ?? 0, 0, size);
        const to = clamp(visible?.to ?? size, from, size);
        const entries = sourceLineIndex(
            doc,
            lineMap,
            source.split("\n"),
            doc.resolve(from).index(0),
            doc.resolve(to).index(0),
        );

        // ── READ phase: every measurement, no writes ───────────────────────
        const contentLineHeight = readLineHeight(view.dom as HTMLElement, FALLBACK_CONTENT_LINE_HEIGHT);
        const scrollY = window.scrollY;
        const measured: MeasuredLine[] = [];
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            // Two different reasons a line has no top, and they need opposite
            // treatment. A line the index says renders NOTHING (a blank
            // separator, a closing fence) is an interpolation candidate — it
            // belongs in the gap between its neighbours. A line that renders
            // something the browser could not measure is HIDDEN (folded away, a
            // collapsed callout), and interpolating it would paint a number
            // beside text that is not on screen. So the first is carried
            // forward as `null` and the second is dropped outright.
            if (entry.pos === null) {
                measured.push({ line: entry.line, top: null });
                continue;
            }
            const top = measureTop(view, entry, contentLineHeight, scrollY);
            if (top === null) { continue; }
            // A bottom is only ever read as the start of the space an
            // interpolated RUN fills, so it is measured only for the line a run
            // follows — about one line per block, rather than a second rect read
            // for every line in the window.
            const bottom = entries[i + 1]?.pos === null
                ? measureBottom(view, entry, scrollY)
                : null;
            measured.push({ line: entry.line, top, bottom });
        }

        // ── WRITE phase ────────────────────────────────────────────────────
        paint(layoutLineNumbers(measured, {
            minGap: gutterLineHeight,
            lineHeight: contentLineHeight,
            numberHeight: gutterLineHeight,
        }));
    };

    /** Reconcile the span pool against the placed lines. */
    const paint = (placed: PlacedLine[]): void => {
        if (!layer) { return; }
        const offset = host.getLineOffset();
        // Widen the column to the widest number it actually shows, so digits
        // stay end-aligned without a hard-coded ceiling on document length.
        const widest = placed.length ? String(placed[placed.length - 1].line + offset).length : 1;
        layer.style.setProperty("--ln-width", `${widest}ch`);
        for (let i = 0; i < placed.length; i++) {
            let el = pool[i];
            if (!el) {
                el = document.createElement("span");
                el.className = "line-number";
                layer.appendChild(el);
                pool.push(el);
            }
            const label = String(placed[i].line + offset);
            if (el.textContent !== label) { el.textContent = label; }
            el.style.top = `${Math.round(placed[i].top)}px`;
            if (el.hidden) { el.hidden = false; }
        }
        for (let i = placed.length; i < pool.length; i++) {
            if (!pool[i].hidden) { pool[i].hidden = true; }
        }
    };

    const refresh = (): void => {
        // One idle callback per burst: a doc change fires per transaction, and
        // re-measuring the visible window costs two `posAtCoords` probes, which
        // have no business on the keystroke path.
        if (!enabled || idle) { return; }
        idle = requestIdle(() => {
            idle = null;
            bind();
            observer?.refresh();
            schedule();
        }, IDLE_TIMEOUT_MS);
    };

    const enable = (): void => {
        if (enabled) { return; }
        enabled = true;
        ensureLineNumberStyles();
        if (!layer) {
            layer = document.createElement("div");
            layer.className = "line-number-layer";
            // A wall of numbers is chrome, not content: never read it aloud.
            layer.setAttribute("aria-hidden", "true");
            document.body.appendChild(layer);
        }
        gutterLineHeight = readLineHeight(layer, FALLBACK_GUTTER_LINE_HEIGHT);
        // Decoration settles in AFTER first paint, never on the mount path.
        idle = requestIdle(() => {
            idle = null;
            bind();
            schedule();
        }, IDLE_TIMEOUT_MS);
    };

    const disable = (): void => {
        enabled = false;
        idle?.cancel();
        idle = null;
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        observer?.destroy();
        observer = null;
        reflow?.disconnect();
        reflow = null;
        observedView = null;
        visible = null;
        layer?.remove();
        layer = null;
        pool.length = 0;
    };

    return { enable, disable, refresh, destroy: disable };
}
