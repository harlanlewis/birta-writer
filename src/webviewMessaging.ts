/**
 * webviewMessaging.ts
 *
 * The single funnel for every extension→webview send. `Webview.postMessage`
 * takes `any`, so a raw call site compiles even when the payload has drifted
 * from the protocol; routing all sends through this function makes every
 * payload compile-check against `ToWebviewMessage` (the webview-side mirror is
 * webview/messaging.ts, which types the opposite direction).
 *
 * Enforced by src/__tests__/typedWebviewSends.test.ts: no `.postMessage(`
 * outside this module. Deliberately NOT wrapped in try/catch — a disposed
 * panel throws synchronously, and call sites that can race disposal (e.g. the
 * save-flush post) handle that themselves; swallowing it here would hide the
 * signal they depend on.
 */
import type * as vscode from "vscode";
import type { ToWebviewMessage } from "../shared/messages";
import type { ToDiffViewMessage } from "../shared/diffMessages";

/** Post a protocol message to one webview (throws if the panel is disposed). */
export function postToWebview(webview: vscode.Webview, msg: ToWebviewMessage): void {
    void webview.postMessage(msg);
}

/**
 * The same funnel for the diff panel, which speaks its own protocol
 * (shared/diffMessages.ts) on its own page. It lives here rather than beside
 * the panel because the guard above is file-scoped: `.postMessage(` may appear
 * in this module and nowhere else in src/.
 */
export function postToDiffView(webview: vscode.Webview, msg: ToDiffViewMessage): void {
    void webview.postMessage(msg);
}
