/**
 * src/feedback/sendFeedback.ts
 *
 * The "Birta: Send Feedback" command — a channel to the maintainer that is
 * **not** telemetry, and is built so the difference is structural rather than
 * a promise:
 *
 *  - **The user initiates.** Nothing here ever runs on its own. There is no
 *    prompt, no nag, no after-N-days toast, no rating request. Solicitation is
 *    what turns opt-in back into telemetry, so the flow is only ever reached
 *    by asking for it: the palette command here, or `/help` in the editor.
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
 * What this file is, since MAR-395 moved the questions out of it: the VS CODE
 * RENDERER for the host-prompt seam, plus delivery. The questions, their order
 * and their validation are `shared/feedback/flow.ts`, and the driver that puts
 * them is `shared/hostPrompt.ts`. Both surfaces run those; only the drawing
 * differs, which is the whole point of the seam.
 *
 * `askViaPalette` therefore has two callers and must keep behaving identically
 * for both: this command, and a `hostPrompt` message from a webview running
 * `/help`. A difference introduced for one of them is a difference between two
 * routes to the same flow.
 *
 * Extension-side on purpose: it contributes nothing to the webview bundle, so
 * it costs zero against the launch-performance gates.
 */
import * as vscode from "vscode";
import { BIRTA_CONFIG_DEFAULTS, BIRTA_SETTING_KEYS } from "../../shared/config";
import { readBirtaConfig } from "../config";
import { reportError } from "../errorSink";
import { openExternalUrl } from "../utils/openExternalUrl";
import {
    composeFeedback,
    describeChangedSettings,
    type Diagnostics,
} from "../../shared/feedback/compose";
import {
    githubIssueUrl,
    mailtoUrl,
    type FeedbackChannel,
    type Prefill,
} from "../../shared/feedback/channels";
import { feedbackAnswers, feedbackSteps } from "../../shared/feedback/flow";
import {
    runPromptFlow,
    validateHostPromptInput,
    type HostPromptStep,
} from "../../shared/hostPrompt";

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

/**
 * The VS Code rendering of one step, and the `HostPromptAsk` both routes use.
 *
 * Returns null for a cancel, which is what `runPromptFlow` stops on. The
 * distinction between null and `""` is load-bearing and comes straight from
 * `showInputBox`: Escape gives `undefined`, an empty submission gives `""`, so
 * an optional step can tell "nothing to add" from "never mind".
 *
 * Note that VS Code appends "(Press 'Enter' to confirm or 'Escape' to cancel)"
 * to every `prompt` itself. Don't write it into a step; it arrives twice.
 */
export async function askViaPalette(step: HostPromptStep): Promise<string | null> {
    if (step.kind === "input") {
        const value = await vscode.window.showInputBox({
            title: step.title,
            prompt: step.prompt,
            ...(step.placeholder !== undefined && { placeHolder: step.placeholder }),
            ignoreFocusOut: true,
            validateInput: (v) => validateHostPromptInput(step, v),
        });
        return value ?? null;
    }

    // The codicon is applied HERE rather than carried in the label, because
    // every other host would draw `$(github)` as those seven characters.
    const picked = await vscode.window.showQuickPick(
        step.rows.map((row) => ({
            id: row.id,
            label: row.icon ? `$(${row.icon}) ${row.label}` : row.label,
            ...(row.detail !== undefined && { detail: row.detail }),
        })),
        {
            title: step.title,
            ...(step.placeholder !== undefined && { placeHolder: step.placeholder }),
            ignoreFocusOut: true,
        },
    );
    return picked?.id ?? null;
}

/**
 * Run the command. `extensionVersion` is injected rather than read from the
 * extension registry so the flow is testable without a real ExtensionContext.
 */
export async function runSendFeedback(extensionVersion: string): Promise<void> {
    const answers = await runPromptFlow(feedbackSteps(), askViaPalette);
    if (!answers) return;

    const named = feedbackAnswers(answers, collectDiagnostics(extensionVersion));
    if (!named) return;

    const { title, body } = composeFeedback(named.draft);
    await deliver(named.channel, title, body);
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
        opened = await openExternalUrl(prefill.url);
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
