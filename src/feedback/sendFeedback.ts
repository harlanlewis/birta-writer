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
 *    host (`env.openExternal`) or a string to the clipboard. The outbound
 *    request, if any, is made by the user's browser under the user's own
 *    identity — which is why this is rung 0 in `docs/NETWORK_POSTURE.md` and
 *    works with `birta.network.enabled` off.
 *  - **The payload is visible and editable at the moment of sending.** The
 *    prefilled GitHub form is an editable textarea; the clipboard is text they
 *    paste. There is no step where something the user has not read leaves.
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
    KIND_ISSUE_LABELS,
    type Diagnostics,
    type Disappointment,
    type FeedbackKind,
} from "./compose";
import {
    availableChannels,
    githubIssueUrl,
    mailtoUrl,
    FEEDBACK_EMAIL,
    type FeedbackChannel,
} from "./channels";

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

interface KindItem extends vscode.QuickPickItem {
    // Not `kind`: QuickPickItem already has one (QuickPickItemKind, the
    // separator enum), and shadowing it with a string breaks the interface.
    feedbackKind: FeedbackKind;
}
interface MoodItem extends vscode.QuickPickItem {
    mood: Disappointment | "skip";
}
interface ChannelItem extends vscode.QuickPickItem {
    channel: FeedbackChannel;
}

const CHANNEL_ROWS: Record<FeedbackChannel, { label: string; detail: string }> = {
    github: {
        label: "$(github) Open a prefilled GitHub issue",
        detail: "Opens your browser. Nothing is sent until you press Submit — you can edit everything first.",
    },
    mail: {
        label: "$(mail) Open a prefilled email",
        detail: "Opens a draft in your mail client. Nothing is sent until you send it.",
    },
    clipboard: {
        label: "$(clippy) Copy to the clipboard",
        detail: "No network of any kind. Paste it wherever you like.",
    },
};

/**
 * Run the command. `extensionVersion` is injected rather than read from the
 * extension registry so the flow is testable without a real ExtensionContext.
 */
export async function runSendFeedback(extensionVersion: string): Promise<void> {
    const kindItem = await vscode.window.showQuickPick<KindItem>(
        [
            { feedbackKind: "bug", label: "$(bug) Something is broken", detail: "A bug, a wrong result, a crash" },
            { feedbackKind: "idea", label: "$(lightbulb) An idea", detail: "Something missing, or something that could be better" },
            { feedbackKind: "other", label: "$(comment) Something else", detail: "Anything at all" },
        ],
        {
            title: "Send Feedback (1 of 4)",
            placeHolder: "What kind of feedback is this?",
            ignoreFocusOut: true,
        },
    );
    if (!kindItem) return;

    // Optional, and visibly so: this question exists to learn who Birta is
    // actually for, and it must never stand between a user and a bug report.
    const moodItem = await vscode.window.showQuickPick<MoodItem>(
        [
            { mood: "very", label: "Very disappointed" },
            { mood: "somewhat", label: "Somewhat disappointed" },
            { mood: "not", label: "Not disappointed" },
            { mood: "skip", label: "$(chevron-right) Skip this question", detail: "Entirely optional" },
        ],
        {
            title: "Send Feedback (2 of 4) — optional",
            placeHolder: "How would you feel if you could no longer use Birta Writer?",
            ignoreFocusOut: true,
        },
    );
    if (!moodItem) return;

    const summary = await vscode.window.showInputBox({
        title: "Send Feedback (3 of 4)",
        prompt: "One line — this becomes the subject",
        placeHolder: "e.g. Moving a list item with a table inside it loses the table",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : "A one-line summary is required"),
    });
    if (!summary?.trim()) return;

    const details = await vscode.window.showInputBox({
        title: "Send Feedback (4 of 4) — optional",
        prompt: "Any detail you want to add now — there is room to write more in the next step",
        placeHolder: "What you did, what you expected, what happened",
        ignoreFocusOut: true,
    });
    // Escape at this step cancels; an empty submission is a deliberate "no
    // further detail" and continues.
    if (details === undefined) return;

    const { title, body } = composeFeedback({
        kind: kindItem.feedbackKind,
        summary,
        details,
        ...(moodItem.mood !== "skip" && { disappointment: moodItem.mood }),
        diagnostics: collectDiagnostics(extensionVersion),
    });

    const channelItem = await vscode.window.showQuickPick<ChannelItem>(
        availableChannels().map((channel) => ({ channel, ...CHANNEL_ROWS[channel] })),
        {
            title: "Send Feedback — where should it go?",
            placeHolder: "Birta does not send anything itself; you do",
            ignoreFocusOut: true,
        },
    );
    if (!channelItem) return;

    await deliver(channelItem.channel, kindItem.feedbackKind, title, body);
}

/**
 * Turn a fully-encoded URL into a `Uri` that survives the trip to the browser.
 *
 * **`vscode.Uri.parse(url)` on a prefilled URL is a trap.** It decodes the
 * query into a raw string, so the reserved characters that gave the query its
 * structure get re-escaped on the way out: `?title=Bug%3A%20x&labels=bug`
 * comes back as `?title%3DBug%3A%20x%26labels%3Dbug` — one parameter named
 * "title=Bug: x&labels" instead of three. `openExternal` renders with
 * `toString(true)`, which avoids that double-escape but instead emits the
 * *decoded* text, putting literal spaces and newlines in the URL.
 *
 * Splitting at the first `?` and passing the already-encoded query through
 * `.with({ query })` is exact under `toString(true)` — verified for both
 * `https:` and `mailto:` by `sendFeedback.test.ts`.
 */
export function openableUri(url: string): vscode.Uri {
    const q = url.indexOf("?");
    if (q === -1) return vscode.Uri.parse(url);
    return vscode.Uri.parse(url.slice(0, q)).with({ query: url.slice(q + 1) });
}

async function deliver(
    channel: FeedbackChannel,
    kind: FeedbackKind,
    title: string,
    body: string,
): Promise<void> {
    try {
        if (channel === "clipboard") {
            await vscode.env.clipboard.writeText(`# ${title}\n\n${body}`);
            vscode.window.setStatusBarMessage("Birta: feedback copied to the clipboard", 5000);
            return;
        }
        if (channel === "mail") {
            const url = mailtoUrl({ subject: title, body });
            // Unreachable while FEEDBACK_EMAIL is null, because the row is not
            // offered — belt and braces so a future wiring mistake degrades to
            // the clipboard rather than to a broken `mailto:null`.
            if (!url) {
                await deliver("clipboard", kind, title, body);
                return;
            }
            await vscode.env.openExternal(openableUri(url));
            return;
        }
        const url = githubIssueUrl({
            title,
            body,
            labels: [KIND_ISSUE_LABELS[kind]],
        });
        // The body may have been truncated to fit the URL; the clipboard
        // always carries the whole thing, so nothing the user wrote is lost.
        await vscode.env.clipboard.writeText(`# ${title}\n\n${body}`);
        await vscode.env.openExternal(openableUri(url));
    } catch (error) {
        reportError(`feedback delivery (${channel})`, error);
        vscode.window.showErrorMessage(
            "Birta: could not open that. Your feedback is on the clipboard.",
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

export { FEEDBACK_EMAIL };
