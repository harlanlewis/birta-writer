/**
 * src/feedback/sendFeedback.ts
 *
 * The "Birta: Send Feedback" command — a channel to the maintainer that is
 * **not** telemetry, and is built so the difference is structural rather than
 * a promise:
 *
 *  - **The user initiates.** Nothing here ever runs on its own. There is no
 *    prompt, no nag, no after-N-days toast, no rating request. Solicitation is
 *    what turns opt-in back into telemetry, so the command is reachable only
 *    from the palette.
 *  - **Birta never sends anything.** It composes text and hands a URL to the
 *    host (`env.openExternal`). The outbound request is made by the user's
 *    browser under the user's own identity — which is why this is rung 0 in
 *    `docs/NETWORK_POSTURE.md` and works with `birta.network.enabled` off.
 *  - **The payload is visible and editable at the moment of sending.** The
 *    prefilled GitHub form is an editable textarea, and the last prompt says
 *    the browser is about to open. There is no step where something the user
 *    has not read leaves, and no step that surprises them.
 *  - **Document content never enters the payload.** The composer is never
 *    given the document, the file path, or the workspace name; settings values
 *    are filtered by shape (`compose.ts`).
 *
 * Extension-side on purpose: it contributes nothing to the webview bundle, so
 * it costs zero against the launch-performance gates.
 */
import * as vscode from "vscode";
import { BIRTA_CONFIG_DEFAULTS, BIRTA_SETTING_KEYS } from "../../shared/config";
import { readBirtaConfig } from "../config";
import { reportError } from "../errorSink";
import {
    composeFeedback,
    describeChangedSettings,
    type Diagnostics,
    type Disappointment,
} from "./compose";
import { githubIssueUrl } from "./channels";

export const SEND_FEEDBACK_COMMAND = "birta.sendFeedback";

/**
 * Settings, keyed by their real `birta.*` setting key rather than the snapshot
 * field name, so a report names what a user would search for in Settings.
 */
function keyedBySettingKey(snapshot: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [field, key] of Object.entries(BIRTA_SETTING_KEYS)) {
        out[`birta.${key}`] = snapshot[field];
    }
    return out;
}

/** Environment facts. Never reads the document, the path, or the workspace. */
export function collectDiagnostics(extensionVersion: string): Diagnostics {
    let changedSettings: string[] = [];
    try {
        changedSettings = describeChangedSettings(
            keyedBySettingKey(readBirtaConfig() as unknown as Record<string, unknown>),
            keyedBySettingKey(BIRTA_CONFIG_DEFAULTS as unknown as Record<string, unknown>),
        );
    } catch (error) {
        // A diagnostics block is a nicety; failing to build one must never
        // stop someone reporting a bug.
        reportError("feedback diagnostics", error);
    }
    return {
        extensionVersion,
        hostVersion: `VS Code ${vscode.version ?? "unknown"}`,
        platform: `${process.platform} ${process.arch}`,
        changedSettings,
    };
}

interface MoodItem extends vscode.QuickPickItem {
    mood: Disappointment | "skip";
}

/** GitHub's own ceiling on an issue title. */
const TITLE_MAX = 256;

/**
 * Run the command. `extensionVersion` is injected rather than read from the
 * extension registry so the flow is testable without a real ExtensionContext.
 *
 * Three prompts, and no more. The destination for all of this is a full
 * Markdown textarea in the browser, which is a better place to write than any
 * modal VS Code can show — `showInputBox` cannot even accept a newline — so
 * the flow collects the one thing the URL needs (a title) and gets out of the
 * way. Every step after the first is optional and says so.
 */
export async function runSendFeedback(extensionVersion: string): Promise<void> {
    const summary = await vscode.window.showInputBox({
        title: "Send Feedback (1 of 3)",
        prompt: "One line — this becomes the issue title",
        placeHolder: "e.g. Moving a list item with a table inside it loses the table",
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value.trim()) return "A one-line summary is required";
            return value.trim().length > TITLE_MAX
                ? `A title is at most ${TITLE_MAX} characters — the rest belongs in the detail step`
                : undefined;
        },
    });
    if (!summary?.trim()) return;

    // Optional, and visibly so: this question exists to learn who Birta is
    // actually for, and it must never stand between a user and a bug report —
    // which is why it comes after the summary rather than before it.
    const moodItem = await vscode.window.showQuickPick<MoodItem>(
        [
            { mood: "very", label: "Very disappointed" },
            { mood: "somewhat", label: "Somewhat disappointed" },
            { mood: "not", label: "Not disappointed" },
            { mood: "skip", label: "$(chevron-right) Skip this question", detail: "Entirely optional" },
        ],
        {
            title: "Send Feedback (2 of 3) — optional",
            placeHolder: "How would you feel if you could no longer use Birta Writer?",
            ignoreFocusOut: true,
        },
    );
    if (!moodItem) return;

    // The prompt names what happens next on purpose. The destination picker
    // this flow replaced was the one place that said "opens your browser;
    // nothing is sent until you press Submit" — for a rung-0b feature whose
    // whole claim is that the user reads the payload before it goes, a browser
    // window opening unannounced is the wrong last impression.
    const details = await vscode.window.showInputBox({
        title: "Send Feedback (3 of 3) — optional",
        prompt: "Any detail to add now. Next: a prefilled GitHub issue opens in your browser — nothing is sent until you press Submit, and you can edit all of it first.",
        placeHolder: "What you did, what you expected, what happened",
        ignoreFocusOut: true,
    });
    // Escape at this step cancels; an empty submission is a deliberate "no
    // further detail" and continues.
    if (details === undefined) return;

    const { title, body } = composeFeedback({
        summary,
        details,
        ...(moodItem.mood !== "skip" && { disappointment: moodItem.mood }),
        diagnostics: collectDiagnostics(extensionVersion),
    });

    await deliver(title, body);
}

/**
 * Open a prefilled URL with its encoding intact.
 *
 * `env.openExternal` is typed for `Uri`, but a `Uri` is the one thing that
 * cannot carry a prefilled query. The opener renders it as
 * `encodeURI(uri.toString(true))`, and `encodeURI` escapes `%` — so every
 * `%3A` we wrote arrives as `%253A`, and GitHub shows the literal text
 * `Bug%3A%20hi` in its title field. That is not a hypothetical: it is what
 * shipped, and what `sendFeedback.test.ts` now models directly.
 *
 * A **string** is passed through verbatim, verified across all three hops of
 * VS Code 1.130: `ExtHostWindow.openUri` keeps it as `uriAsString`,
 * `MainThreadWindow.$openUri` prefers it when it round-trips, and
 * `_doOpenExternal` opens it as-is (`typeof i === "string" && … → n = i`).
 * The cast is the price of a public signature narrower than the runtime it
 * fronts; `Uri` is simply lossy here and there is no encoding of the query
 * that survives it, because `%` itself is what gets escaped.
 */
export function openPrefilledUrl(url: string): Thenable<boolean> {
    return vscode.env.openExternal(url as unknown as vscode.Uri);
}

async function deliver(title: string, body: string): Promise<void> {
    const { url, truncated } = githubIssueUrl({ title, body });
    const fullText = `# ${title}\n\n${body}`;

    // The clipboard is the safety net, not the default. It is written when the
    // report would otherwise be incomplete or unreachable — copying on every
    // report would silently destroy whatever the user had copied, as a toll
    // paid on every send to insure against a rare one.
    let copied = false;
    const copy = async (): Promise<void> => {
        if (copied) return;
        await vscode.env.clipboard.writeText(fullText);
        copied = true;
    };

    if (truncated) await copy();

    let opened = false;
    try {
        opened = await openPrefilledUrl(url);
    } catch (error) {
        reportError("feedback delivery", error);
    }

    if (!opened) {
        await copy();
        vscode.window.showErrorMessage(
            "Birta: could not open your browser. Your feedback is on the clipboard.",
        );
        return;
    }
    // Quiet on purpose: a notification here would be raised behind the browser
    // window that is taking focus. The reliable channel is `TRUNCATION_NOTE`,
    // which is already sitting in the form the user is now looking at.
    if (truncated) {
        vscode.window.setStatusBarMessage(
            "Birta: your report was too long for the link — the full text is on your clipboard, paste it in",
            8000,
        );
    }
}

/** Register the command. Called once from `activate`. */
export function registerSendFeedback(context: vscode.ExtensionContext): void {
    const version =
        (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "unknown";
    context.subscriptions.push(
        vscode.commands.registerCommand(SEND_FEEDBACK_COMMAND, () => runSendFeedback(version)),
    );
}
