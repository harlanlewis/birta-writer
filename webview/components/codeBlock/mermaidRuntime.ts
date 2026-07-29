/**
 * components/codeBlock/mermaidRuntime.ts
 *
 * The PROCESS-WIDE half of Mermaid support: the effective theme, the lazily
 * loaded + memoized `mermaid.initialize()`, the off-screen render/measure, and
 * the registry of live diagrams to repaint when the theme moves.
 *
 * It is module-level singleton state on purpose — Mermaid itself is a
 * singleton, so its init is global and every NodeView shares it. Everything
 * per-diagram (pan/zoom, the visible pane, the render memo) lives in the
 * NodeView instead; the only thing an instance publishes here is `invalidate`.
 *
 * Mermaid is loaded through the cached dynamic `import()` in
 * `utils/mermaidLoader.ts`, so a document with no ```mermaid fence never pulls
 * the bundle onto the launch path.
 */
import { loadMermaid } from "@/utils/mermaidLoader";
import { isMermaidDark } from "./mermaidTheme";
import { normalizeMermaidThemeMode, type MermaidThemeMode } from "../../../shared/mermaid";

let mermaidInitialized = false;
let lastMermaidTheme = "";

// The active `birta.mermaid.theme` mode, seeded from the injected config and
// kept current by setMermaidThemeMode() when the setting changes live.
let mermaidThemeMode: MermaidThemeMode = normalizeMermaidThemeMode(window.__i18n?.mermaidTheme);

/** The live editor background, used only when the mode is `auto`. */
function currentEditorBg(): string {
    return getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-editor-background")
        .trim();
}

/**
 * Effective dark/light for the current mode. Reads the editor background (a
 * forced `getComputedStyle` reflow) only in `auto` mode — `light`/`dark` are
 * fixed, so on the mount path and on theme events those modes cost nothing.
 */
function mermaidDarkNow(): boolean {
    return isMermaidDark(mermaidThemeMode, mermaidThemeMode === "auto" ? currentEditorBg() : "");
}

/** The Mermaid init-theme key for the current effective mode. */
export function mermaidThemeKey(): "dark" | "default" {
    return mermaidDarkNow() ? "dark" : "default";
}

/**
 * The theme key the LAST completed `ensureMermaid()` initialized with. A
 * render records this rather than the live key, because the mode may have
 * moved on mid-flight.
 */
export function lastInitializedThemeKey(): string {
    return lastMermaidTheme;
}

/**
 * Reflect the effective (light/dark) Mermaid canvas onto <body>, so the CSS
 * `--mermaid-canvas` variable — white by default, dark under this class — backs
 * every diagram surface (inline preview and lightbox) consistently. Idempotent;
 * safe to call on every render and on theme/setting changes.
 */
export function syncMermaidCanvasClass(): void {
    document.body.classList.toggle("mermaid-canvas-dark", mermaidDarkNow());
}

/** Re-render every Mermaid diagram (after a theme or setting change). */
function rerenderAllMermaid(): void {
    for (const instance of mermaidInstances) instance.invalidate();
}

/**
 * Live-apply a `birta.mermaid.theme` change: update the mode, force a re-init on
 * the next render, resync the canvas class, and re-render open diagrams.
 */
export function setMermaidThemeMode(mode: MermaidThemeMode): void {
    if (mode === mermaidThemeMode) return;
    mermaidThemeMode = mode;
    mermaidInitialized = false;
    syncMermaidCanvasClass();
    rerenderAllMermaid();
}

/**
 * Load Mermaid on demand (lazily code-split) and (re-)initialize it for the
 * current mode/theme, returning the module so the caller can render. Only
 * invoked when a diagram actually renders, so documents without ```mermaid
 * blocks never pull the Mermaid bundle into the launch path.
 */
async function ensureMermaid(): Promise<typeof import("mermaid")["default"]> {
    const mermaid = await loadMermaid();
    const dark = mermaidDarkNow();
    document.body.classList.toggle("mermaid-canvas-dark", dark);
    const currentTheme = dark ? "dark" : "default";

    // If the theme hasn't changed and it's already initialized, skip re-init.
    if (mermaidInitialized && lastMermaidTheme === currentTheme) return mermaid;

    mermaidInitialized = true;
    lastMermaidTheme = currentTheme;
    mermaid.initialize({
        startOnLoad: false,
        theme: currentTheme,
        securityLevel: "strict",
        // Disable Mermaid setting max-width:100% on the SVG, to avoid conflicting with the fixed width/height attributes we write back
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
    });
    return mermaid;
}

/**
 * Render Mermaid source to SVG in a clean off-screen host and measure its
 * natural size there.
 *
 * The host MUST NOT be the on-screen preview container: Mermaid measures
 * HTML labels with getBoundingClientRect() wherever it renders, and that is
 * scaled by any ancestor CSS transform — rendering inside the pan/zoomed
 * `svgContainer` corrupted every re-render's geometry (clipped/mis-sized
 * text, MAR-202). visibility:hidden (not display:none) keeps layout alive
 * for measurement; the explicit width makes width-sensitive diagrams
 * (gantt's width:100%) lay out at the real target width.
 */
export async function renderMermaidToSvg(
    code: string,
    renderWidth: number,
): Promise<{ svg: string; width: number; height: number }> {
    const mermaid = await ensureMermaid();
    const host = document.createElement("div");
    host.style.cssText =
        `position:absolute;top:0;left:-10000px;visibility:hidden;pointer-events:none;width:${renderWidth}px`;
    document.body.appendChild(host);
    try {
        const id = `mmid-${Math.random().toString(36).slice(2, 9)}`;
        const { svg } = await mermaid.render(id, code, host);
        // Natural-size fallback chain: viewBox (most precise) → explicit
        // non-percentage width/height attributes → the laid-out size inside
        // the sized host (valid because the host has the real render width).
        host.innerHTML = svg;
        const svgEl = host.querySelector("svg");
        let nw = 0, nh = 0;
        const vb = svgEl?.getAttribute("viewBox");
        if (vb) {
            const parts = vb.trim().split(/[\s,]+/);
            if (parts.length >= 4) {
                nw = parseFloat(parts[2]);
                nh = parseFloat(parts[3]);
            }
        }
        if (!nw) {
            const wa = svgEl?.getAttribute("width");
            if (wa && !wa.includes("%")) nw = parseFloat(wa);
        }
        if (!nh) {
            const ha = svgEl?.getAttribute("height");
            if (ha && !ha.includes("%")) nh = parseFloat(ha);
        }
        if (!nw) nw = svgEl?.clientWidth || renderWidth;
        if (!nh) nh = svgEl?.clientHeight || 400;
        return { svg, width: nw, height: nh };
    } finally {
        host.remove();
    }
}

// ─── Mermaid instance registry (used to re-render on theme change) ──────────
export type MermaidInstance = {
    /**
     * Re-request the current diagram after a theme/setting change. The render
     * memo is (code, theme)-aware, so the request re-renders exactly when the
     * effective palette changed and is a cheap no-op otherwise (switching
     * between two dark themes repaints nothing). A block sitting in code mode
     * needs no action here — its next preview entry hits the same guard.
     */
    invalidate: () => void;
};
const mermaidInstances = new Set<MermaidInstance>();

export function registerMermaidInstance(instance: MermaidInstance): () => void {
    mermaidInstances.add(instance);
    return () => mermaidInstances.delete(instance);
}

// Listen for theme-change events and re-render all Mermaid diagrams. Only `auto`
// mode tracks the editor theme; `light`/`dark` render a fixed palette that a
// theme switch cannot change, so we skip the re-init + re-render of every open
// diagram entirely in those modes.
if (typeof window !== 'undefined') {
    window.addEventListener('theme-changed', () => {
        if (mermaidThemeMode !== 'auto') return;
        mermaidInitialized = false;
        syncMermaidCanvasClass();
        rerenderAllMermaid();
    });
}
