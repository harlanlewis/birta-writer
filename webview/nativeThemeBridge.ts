/**
 * Native VS Code theme-change bridge.
 *
 * VS Code injects the full `--vscode-*` palette into every webview and updates
 * it live whenever the active color theme changes; it also swaps a single theme
 * class on `<body>` (`vscode-light` / `vscode-dark` / `vscode-high-contrast` /
 * `vscode-high-contrast-light`). In auto mode the extension pushes no color
 * overrides, so CSS follows those native variables on its own — but JS-driven
 * consumers (e.g. Mermaid diagram re-rendering) still need a signal.
 *
 * This bridges the native body-class swap to the same `theme-changed` event the
 * `setTheme` message dispatches, so those consumers refresh on every theme
 * change — including OS-driven light/dark switching, which never reaches the
 * extension host.
 */

const THEME_CLASSES = [
    // Order matters: match the most specific class first so the shorter
    // "vscode-high-contrast" doesn't win over "vscode-high-contrast-light".
    "vscode-high-contrast-light",
    "vscode-high-contrast",
    "vscode-light",
    "vscode-dark",
] as const;

/**
 * Extract the VS Code theme kind from a `<body>` className, ignoring any other
 * classes present. Returns `""` when no known theme class is set.
 */
export function themeKindFromClass(className: string): string {
    const classes = className.split(/\s+/);
    for (const kind of THEME_CLASSES) {
        if (classes.includes(kind)) {
            return kind;
        }
    }
    return "";
}

/**
 * Observe `<body>` for VS Code theme-class changes and dispatch a
 * `theme-changed` event on the given target when the theme kind actually
 * changes. Returns a disposer that stops observing.
 */
export function observeNativeThemeChanges(
    body: HTMLElement = document.body,
    target: EventTarget = window,
): () => void {
    // Fire only when the theme KIND changes (light / dark / high-contrast /
    // high-contrast-light), not on every class mutation. Switching between two
    // themes of the same kind (e.g. one dark theme to another) leaves colors to
    // VS Code's live --vscode-* variables and does not re-dispatch: the sole
    // consumer (Mermaid) derives a binary dark/light theme, so a same-kind
    // switch would re-render to an identical result. Don't "fix" this to fire
    // on every mutation without a consumer that needs finer granularity.
    let lastKind = themeKindFromClass(body.className);
    const observer = new MutationObserver(() => {
        const kind = themeKindFromClass(body.className);
        if (kind !== lastKind) {
            lastKind = kind;
            target.dispatchEvent(new CustomEvent("theme-changed"));
        }
    });
    observer.observe(body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
}
