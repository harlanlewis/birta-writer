/**
 * webview/vscodeHost.ts — THE `acquireVsCodeApi()` call (MAR-55).
 *
 * VS Code hands a webview its API exactly once: the second `acquireVsCodeApi()`
 * in a page throws, and because the call sits at module scope the throw takes
 * the whole entry down and leaves a blank panel. So the acquisition is one
 * module that every page imports, rather than a line each page writes.
 *
 * This exists because the extension now ships TWO pages. The rendered-diff
 * panel (webview/diffView) needs the markdown presets, and one of them reaches
 * transitively into the presentation state bag, which imports
 * webview/messaging.ts — so the editor's comms layer is initialized inside a
 * page that is not the editor, and it had already acquired the API by the time
 * the diff page's own call ran.
 *
 * The handle is deliberately untyped at this layer (`unknown` in, `unknown`
 * out). It is plumbing, not a protocol: the typing belongs to the funnel each
 * page owns, `webview/messaging.ts` for the editor and
 * `webview/diffView/index.ts` for the diff panel, so neither page can post the
 * other's message shapes. Nothing else should import this module — a third
 * consumer means a page with two protocols.
 */

/** What VS Code's webview API provides, as the webview sees it. */
export interface VsCodeHost {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeHost;

export const vscodeHost: VsCodeHost = acquireVsCodeApi();
