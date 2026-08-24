/**
 * shared/feedback/flow.ts
 *
 * The Send Feedback questions, as DATA rather than as calls (MAR-395).
 *
 * The four prompts, their order, their validation and their cancel semantics
 * used to live inside `src/feedback/sendFeedback.ts`, spelled as
 * `vscode.window.showInputBox` / `showQuickPick`. That made them unavailable
 * to any surface that is not VS Code, which is every surface but one. They are
 * `HostPromptStep`s here instead, so the palette renders them, Birta Writer for
 * Mac renders them as a sheet, and neither owns them.
 *
 * The strings are byte-identical to the ones the command showed before the
 * move, deliberately: the flow that shipped is the flow that was written, and
 * a rewording is a separate decision from a relocation. They are English
 * source text and are not passed through `t()`, because this module is shared
 * with the extension host, which has no translator; the palette command never
 * translated them either.
 */
import type { HostPromptStep } from "../hostPrompt";
import { FEEDBACK_EMAIL, availableChannels, type FeedbackChannel } from "./channels";
import type { Diagnostics, Disappointment, FeedbackDraft } from "./compose";

/** GitHub's own ceiling on an issue title. */
export const TITLE_MAX = 256;

/** The answer id the disappointment step uses for "no answer". */
export const SKIP_ANSWER = "skip";

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
const MOOD_ROWS: ReadonlyArray<{ id: Disappointment; label: string }> = [
    { id: "very", label: "Very disappointed — Birta Writer is part of how I work" },
    { id: "somewhat", label: "Somewhat disappointed — I'd miss parts of it" },
    { id: "not", label: "Not disappointed — I could switch without much trouble" },
];

const CHANNEL_ROWS: Record<FeedbackChannel, { icon: string; label: string; detail: string }> = {
    github: {
        icon: "github",
        label: "Open a prefilled GitHub issue",
        detail: "Needs a GitHub account. Public, and you can edit it before you press Submit.",
    },
    mail: {
        icon: "mail",
        label: "Open a prefilled email",
        detail: `No account needed. Opens a draft to ${FEEDBACK_EMAIL}; nothing is sent until you send it.`,
    },
    clipboard: {
        icon: "clippy",
        label: "Copy to the clipboard",
        detail: "No network of any kind. Paste it wherever you like.",
    },
};

/**
 * The four steps, in order. Only the first is required.
 *
 * The destination for all of this is a full Markdown textarea in the browser,
 * which is a better place to write than any modal a host can show — VS Code's
 * `showInputBox` cannot even accept a newline — so the flow collects the one
 * thing the URL needs (a title) and gets out of the way.
 *
 * `email` is a parameter rather than a read of `FEEDBACK_EMAIL` so a test can
 * drive the no-mail-address shape, which is the one that changes the row count.
 */
export function feedbackSteps(email: string | null = FEEDBACK_EMAIL): HostPromptStep[] {
    const channels = availableChannels(email);
    return [
        {
            kind: "input",
            title: "Send Feedback (1 of 4)",
            prompt: "What's the issue?",
            placeholder: "e.g. Moving a list item with a table inside it loses the table",
            required: { message: "A one-line summary is required" },
            maxLength: {
                value: TITLE_MAX,
                message: `A title is at most ${TITLE_MAX} characters — the rest belongs in the detail step`,
            },
        },
        // Optional, and visibly so: this question exists to learn who Birta is
        // actually for, and it must never stand between a user and a bug report
        // — which is why it comes after the summary rather than before it.
        {
            kind: "pick",
            title: "Send Feedback (2 of 4) — optional",
            placeholder: "How would you feel if you could no longer use Birta Writer?",
            rows: [...MOOD_ROWS, { id: SKIP_ANSWER, label: "Skip this question" }],
        },
        {
            kind: "input",
            title: "Send Feedback (3 of 4) — optional",
            prompt: "Any additional details?",
            placeholder: "What you did, what you expected, what happened",
        },
        // Last, and worth its step: this is where the user finds out that a
        // browser is about to open, and — the reason it exists — that GitHub
        // wants an account. Someone without one would otherwise meet a login
        // wall holding the report they just finished writing. Each row says
        // what it costs, so the answer is obvious without reading a paragraph.
        {
            kind: "pick",
            title: "Send Feedback (4 of 4) — where should this go?",
            placeholder: "Birta does not send anything itself; you do",
            rows: channels.map((channel) => ({ id: channel, ...CHANNEL_ROWS[channel] })),
        },
    ];
}

/** What `runPromptFlow` returns for this flow, once the answers are named. */
export interface FeedbackAnswers {
    readonly draft: FeedbackDraft;
    readonly channel: FeedbackChannel;
}

/**
 * Name the positional answers, or return null when the summary is blank.
 *
 * The blank check is belt and braces: `required` on step 1 means no renderer
 * should be able to submit one. A renderer that validated nothing would
 * otherwise compose a report with an empty issue title.
 */
export function feedbackAnswers(
    answers: readonly string[],
    diagnostics: Diagnostics,
): FeedbackAnswers | null {
    const [summary, mood, details, channel] = answers;
    if (!summary?.trim()) return null;
    return {
        draft: {
            summary,
            details: details ?? "",
            ...(mood !== SKIP_ANSWER && { disappointment: mood as Disappointment }),
            diagnostics,
        },
        channel: channel as FeedbackChannel,
    };
}
