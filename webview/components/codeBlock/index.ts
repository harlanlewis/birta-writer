/**
 * components/codeBlock/index.ts
 *
 * The code block's public surface — the ONE import path for everything outside
 * this directory (the `plugins/headingFold` and `components/blockMenu` facades
 * set the discipline). The files behind it, roughly outermost-in:
 *
 *   nodeView.ts       — the NodeView itself: wrapper DOM, chrome row, control
 *                       column, the editable <pre>, and the code⇄preview
 *                       state machine that decides which pane is visible
 *   langPicker.ts     — the language pill and its searchable dropdown
 *   lineNumbers.ts    — gutter geometry (shared with both lightboxes)
 *   mermaidRuntime.ts — process-wide Mermaid: theme, lazy init, off-screen
 *                       render/measure, and the repaint-on-theme registry
 *   diagramPane.ts    — the inline diagram surface shared by every engine:
 *                       pan/zoom/fit/adaptive height + the single-flight render
 *   mermaidPane.ts    — Mermaid's adapter onto it (off-screen render/measure)
 *   plantUmlRuntime.ts— process-wide PlantUML: theme, render entry point, and
 *                       the repaint-on-theme registry
 *   plantUmlPane.ts   — PlantUML's adapter onto the shared pane
 *   plantUmlTheme.ts  — the skinparam preamble and its line-number bookkeeping
 *   calcLedger.ts     — the ```calc two-column worksheet (MAR-196), including
 *                       the selection routing that keeps it copyable
 *   latexPane.ts      — the ```latex block formula (KaTeX)
 *   lightbox.ts       — the two fullscreen surfaces (code editor, diagram)
 *   mermaidTheme.ts   — Mermaid's theme-name mapping
 *   diagramTheme.ts   — the pure dark/light decision, shared by both engines
 *
 * Internal cross-imports between those files stay direct; only external
 * consumers come through here. Exports are trimmed to names with consumers
 * outside the directory (including the test suites, which drive the real
 * renderers) — don't re-export an internal helper "for completeness".
 */
export { createCodeBlockView } from "./nodeView";

export { setMermaidThemeMode, syncMermaidCanvasClass } from "./mermaidRuntime";

export { setPlantUmlThemeMode, refreshPlantUmlForEditorTheme } from "./plantUmlRuntime";

export { createLangPickerItem, isSameLanguage, langLabelHtml } from "./langPicker";

import './codeBlock.css';
