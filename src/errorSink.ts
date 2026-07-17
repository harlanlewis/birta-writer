/**
 * errorSink.ts
 *
 * The one place that decides how an extension-side failure surfaces:
 * console-only (the default — diagnosable in the developer tools, invisible in
 * healthy operation) versus a user-facing notification (reserved for failures
 * the user must know about, e.g. a crashed webview). Handlers that used to
 * swallow errors with `.catch(() => {})` route through here instead, so a
 * best-effort feature can still fail quietly for the user without failing
 * silently for whoever is debugging it.
 */
import * as vscode from "vscode";

/**
 * How many distinct notifications the sink will show per session. Everything
 * past the cap still logs; the cap only bounds the user-facing surface so a
 * crash-looping webview can't stack toasts.
 */
export const MAX_NOTIFICATIONS_PER_SESSION = 3;

/** Notification dedupe: one toast per distinct message per session. */
const notifiedMessages = new Set<string>();

/**
 * Log a failure to the extension-host console. `source` names the operation
 * (e.g. "openFile", "webview crash") so the log line is greppable; `error` is
 * whatever was thrown. Never user-visible.
 */
export function reportError(source: string, error: unknown): void {
    console.error(`[birta] ${source} failed:`, error);
}

/**
 * Log a failure AND notify the user once. Deduped per distinct `message` and
 * capped at MAX_NOTIFICATIONS_PER_SESSION per session, so repeated failures
 * (a crash-looping webview, a watcher stuck on a bad file) surface as a single
 * non-spammy toast while every occurrence still reaches the console.
 */
export function reportErrorWithNotification(
    source: string,
    error: unknown,
    message: string,
): void {
    reportError(source, error);
    if (notifiedMessages.has(message)) { return; }
    if (notifiedMessages.size >= MAX_NOTIFICATIONS_PER_SESSION) { return; }
    notifiedMessages.add(message);
    void vscode.window.showErrorMessage(message);
}

/** TEST-ONLY: clear the per-session notification dedupe state. */
export function _resetErrorSinkForTests(): void {
    notifiedMessages.clear();
}
