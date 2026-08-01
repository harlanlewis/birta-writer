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
 *    request, if any, is made by the user's browser or mail client under the
 *    user's own identity — which is why this is rung 0 in
 *    `docs/NETWORK_POSTURE.md` and works with `birta.network.enabled` off.
 *  - **The payload is visible and editable at the moment of sending.** The
 *    prefilled GitHub form is an editable textarea; the mail draft is one
 *    they press send on; the clipboard is text they paste. The last step names
 *    the destination and what it costs, so nothing opens unannounced.
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
import {
    availableChannels,
    githubIssueUrl,
    mailtoUrl,
    FEEDBACK_EMAIL,
    type FeedbackChannel,
    type Prefill,
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

interface MoodItem extends vscode.QuickPickItem {
    mood: Disappointment | "skip";
}
interface ChannelItem extends vscode.QuickPickItem {
    channel: FeedbackChannel;
}

/** GitHub's own ceiling on an issue title. */
const TITLE_MAX = 256;

/**
 * The disappointment scale, with each answer stating what it is an answer
 * *about*. The question is Vohra's product/market-fit instrument and it asks
 * about Birta Writer as a whole — but it is asked at the end of a bug report,
 * where "Not disappointed" reads naturally as a verdict on the bug. Someone
 * could be unbothered by the issue and devastated to lose the editor, and the
 * bare scale would record the opposite. A prompt cannot fix that: it is grey
 * placeholder text above three bold rows, and the rows are what people read.
 * So the rows carry the subject.
 */
const MOOD_ROWS: ReadonlyArray<{ mood: Disappointment; label: string }> = [
    { mood: "very", label: "Very disappointed — Birta Writer is part of how I work" },
    { mood: "somewhat", label: "Somewhat disappointed — I'd miss parts of it" },
    { mood: "not", label: "Not disappointed — I could switch without much trouble" },
];

const CHANNEL_ROWS: Record<FeedbackChannel, { label: string; detail: string }> = {
    github: {
        label: "$(github) Open a prefilled GitHub issue",
        detail: "Needs a GitHub account. Public, and you can edit it before you press Submit.",
    },
    mail: {
        label: "$(mail) Open a prefilled email",
        detail: `No account needed. Opens a draft to ${FEEDBACK_EMAIL}; nothing is sent until you send it.`,
    },
    clipboard: {
        label: "$(clippy) Copy to the clipboard",
        detail: "No network of any kind. Paste it wherever you like.",
    },
};

/**
 * Run the command. `extensionVersion` is injected rather than read from the
 * extension registry so the flow is testable without a real ExtensionContext.
 *
 * Four prompts, only the first of which is required. The destination for all
 * of this is a full Markdown textarea in the browser, which is a better place
 * to write than any modal VS Code can show — `showInputBox` cannot even accept
 * a newline — so the flow collects the one thing the URL needs (a title) and
 * gets out of the way.
 *
 * Note that VS Code appends "(Press 'Enter' to confirm or 'Escape' to cancel)"
 * to every `prompt` itself. Don't write it here; it arrives twice.
 */
export async function runSendFeedback(extensionVersion: string): Promise<void> {
    const summary = await vscode.window.showInputBox({
        title: "Send Feedback (1 of 4)",
        prompt: "What's the issue?",
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
            ...MOOD_ROWS.map(({ mood, label }) => ({ mood, label }) as MoodItem),
            { mood: "skip", label: "Skip this question" },
        ],
        {
            title: "Send Feedback (2 of 4) — optional",
            placeHolder: "How would you feel if you could no longer use Birta Writer?",
            ignoreFocusOut: true,
        },
    );
    if (!moodItem) return;

    const details = await vscode.window.showInputBox({
        title: "Send Feedback (3 of 4) — optional",
        prompt: "Any additional details?",
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

    // Last, and worth its step: this is where the user finds out that a
    // browser is about to open, and — the reason it exists — that GitHub wants
    // an account. Someone without one would otherwise meet a login wall
    // holding the report they just finished writing. Each row says what it
    // costs, so the answer is obvious without reading a paragraph.
    const channelItem = await vscode.window.showQuickPick<ChannelItem>(
        availableChannels().map((channel) => ({ channel, ...CHANNEL_ROWS[channel] })),
        {
            title: "Send Feedback (4 of 4) — where should this go?",
            placeHolder: "Birta does not send anything itself; you do",
            ignoreFocusOut: true,
        },
    );
    if (!channelItem) return;

    await deliver(channelItem.channel, title, body);
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

async function deliver(channel: FeedbackChannel, title: string, body: string): Promise<void> {
    const fullText = `# ${title}\n\n${body}`;

    // The clipboard is the safety net for the other two, not their default. It
    // is written when the report would otherwise be incomplete or unreachable
    // — copying on every report would silently destroy whatever the user had
    // copied, as a toll paid on every send to insure against a rare one.
    let copied = false;
    const copy = async (): Promise<void> => {
        if (copied) return;
        await vscode.env.clipboard.writeText(fullText);
        copied = true;
    };

    if (channel === "clipboard") {
        await copy();
        vscode.window.setStatusBarMessage("Birta: feedback copied to the clipboard", 5000);
        return;
    }

    const prefill: Prefill | null =
        channel === "mail"
            ? mailtoUrl({ subject: title, body })
            : githubIssueUrl({ title, body });
    // Unreachable while the row is only offered when an address exists — belt
    // and braces so a future wiring mistake degrades to the clipboard rather
    // than to a broken `mailto:null`.
    if (!prefill) {
        await deliver("clipboard", title, body);
        return;
    }

    if (prefill.truncated) await copy();

    let opened = false;
    try {
        opened = await openPrefilledUrl(prefill.url);
    } catch (error) {
        reportError(`feedback delivery (${channel})`, error);
    }

    if (!opened) {
        await copy();
        vscode.window.showErrorMessage(
            "Birta: could not open that. Your feedback is on the clipboard.",
        );
        return;
    }
    // Quiet on purpose: a notification here would be raised behind the window
    // that is taking focus. The reliable channel is `TRUNCATION_NOTE`, which
    // is already sitting in the draft the user is now looking at.
    if (prefill.truncated) {
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
