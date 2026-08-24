/**
 * webview/feedbackFlow.ts
 *
 * `/help` running the Send Feedback flow from inside the document, on every
 * surface (MAR-395).
 *
 * LAZY, and that is a requirement rather than a habit: this module pulls in
 * the questions, the composer and the URL builders, and none of them may cost
 * anything at launch. `webview/hostPrompt.ts` is the eager half, because a
 * reply has to be routed by the eager message handler.
 *
 * Why the page composes at all, rather than handing the answers to the host
 * and letting it build the report: the Mac app has no TypeScript, so anything
 * running host-side there would have to be a Swift port of the composer, which
 * is the drift this seam exists to stop. The page is the one runtime both
 * surfaces share. What the page does NOT do is gather diagnostics, which name
 * the host and so can only come from it.
 *
 * Delivery needs no host code of its own. Both hosts already open a URL and
 * write the clipboard, which is the whole of what a rung-0 report needs: Birta
 * never makes the request. It composes a URL and asks the host to open it, so
 * the outbound call is the user's own browser or mail client under the user's
 * own identity, against a form they can still read and edit before they send
 * it (docs/NETWORK_POSTURE.md).
 */
import { composeFeedback, type Diagnostics } from "../shared/feedback/compose";
import { githubIssueUrl, mailtoUrl, type Prefill } from "../shared/feedback/channels";
import { feedbackAnswers, feedbackSteps } from "../shared/feedback/flow";
import { runPromptFlow } from "../shared/hostPrompt";
import { askHost, askHostDiagnostics } from "./hostPrompt";
import { notifyClipboardWrite, notifyOpenUrl } from "@/messaging";
import { showToast } from "@/ui/toast";
import { t } from "@/i18n";

/** The toast surface these messages share. */
const SURFACE = "feedback-toast";

/**
 * Diagnostics for a host that did not answer.
 *
 * A report with an empty diagnostics block is worth more than no report, so a
 * silent host costs the block's contents and never the flow. The strings say
 * the host did not answer rather than guessing values, because a wrong version
 * in a bug report is worse than an absent one.
 */
const UNKNOWN_DIAGNOSTICS: Diagnostics = {
    extensionVersion: "unknown",
    hostVersion: "unknown (the host did not report one)",
    platform: "unknown",
    changedSettings: [],
};

/**
 * Run the flow: four questions, then compose, then deliver.
 *
 * Cancelling at any step returns without composing anything, which is
 * `runPromptFlow`'s property rather than a rule repeated here.
 */
export async function runFeedbackFlow(): Promise<void> {
    let unsupported = false;
    const answers = await runPromptFlow(feedbackSteps(), async (step) => {
        const outcome = await askHost(step);
        if (outcome.unsupported) unsupported = true;
        return outcome.value;
    });

    if (!answers) {
        // A host that cannot draw the step is a different event from a user
        // pressing Escape, and saying so is the whole reason `unsupported` is
        // a distinct reply: silence would read as the editor ignoring them.
        if (unsupported) {
            showToast(t("This surface cannot ask for feedback yet."), { surface: SURFACE, tone: "error" });
        }
        return;
    }

    const named = feedbackAnswers(answers, (await askHostDiagnostics()) ?? UNKNOWN_DIAGNOSTICS);
    if (!named) return;

    const { title, body } = composeFeedback(named.draft);
    deliver(named.channel, title, body);
}

function deliver(channel: string, title: string, body: string): void {
    const fullText = `# ${title}\n\n${body}`;

    // The clipboard is the safety net for the other two, not their default. It
    // is written when the report would otherwise be incomplete — copying on
    // every report would silently destroy whatever the user had copied, as a
    // toll paid on every send to insure against a rare one.
    const copy = (): void => notifyClipboardWrite("markdown", fullText);

    if (channel === "clipboard") {
        copy();
        showToast(t("Feedback copied to the clipboard."), { surface: SURFACE });
        return;
    }

    const prefill: Prefill | null =
        channel === "mail" ? mailtoUrl({ subject: title, body }) : githubIssueUrl({ title, body });
    // Unreachable while the row is only offered when an address exists — belt
    // and braces so a future wiring mistake degrades to the clipboard rather
    // than to a broken `mailto:null`.
    if (!prefill) {
        deliver("clipboard", title, body);
        return;
    }

    if (prefill.truncated) copy();
    notifyOpenUrl(prefill.url);
    if (prefill.truncated) {
        showToast(
            t("Your report was too long for the link — the full text is on your clipboard, paste it in."),
            { surface: SURFACE, dwellMs: 8000 },
        );
    }
}
