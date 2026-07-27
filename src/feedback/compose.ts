/**
 * src/feedback/compose.ts
 *
 * The pure half of the feedback command: turning what the user chose and typed
 * into the exact Markdown that will appear in their browser or on their
 * clipboard. No vscode import, so every privacy rule here is unit-testable
 * against plain values.
 *
 * The privacy rule that motivates this file: **a setting's KEY is diagnostic,
 * a setting's VALUE may be the user's data.** `birta.customCss` is a list of
 * filesystem paths; `birta.fontFamilySans` is free text a workspace could put
 * anything in. So values are included only when their shape proves they cannot
 * carry a path or a sentence (`isReportableValue`), and everything else is
 * reported as "customized" — the fact that it differs is the useful signal,
 * and it is the whole of the useful signal.
 *
 * Document content, file paths, workspace and folder names never appear here
 * at all, by construction: this module is never given them.
 */

/** What the user says the feedback is. Drives the title prefix and the label. */
export type FeedbackKind = "bug" | "idea" | "other";

/**
 * The disappointment question (Vohra's product/market-fit instrument, see
 * `docs/research/superhuman-case-study.md` §6). Always optional — it must
 * never stand between a user and filing a bug.
 */
export type Disappointment = "very" | "somewhat" | "not";

/** Environment facts, gathered by the caller so this module stays pure. */
export interface Diagnostics {
    /** Birta's own version, e.g. "0.2.4" (local builds report "0.0.0"). */
    extensionVersion: string;
    /** The host's version, e.g. VS Code's `vscode.version`. */
    hostVersion: string;
    /** OS and architecture, e.g. "darwin arm64". */
    platform: string;
    /**
     * Non-default `birta.*` settings, already reduced to safe strings by
     * `describeChangedSettings`. Empty means "everything at defaults", which
     * is itself worth stating.
     */
    changedSettings: string[];
}

export interface FeedbackDraft {
    kind: FeedbackKind;
    /** One line; becomes the issue title. Required. */
    summary: string;
    /** Free text; may be empty (the browser form is a fine place to continue). */
    details: string;
    /** Omitted when the user skipped the question. */
    disappointment?: Disappointment;
    diagnostics: Diagnostics;
}

const KIND_LABELS: Record<FeedbackKind, string> = {
    bug: "Bug",
    idea: "Idea",
    other: "Feedback",
};

const DISAPPOINTMENT_LABELS: Record<Disappointment, string> = {
    very: "Very disappointed",
    somewhat: "Somewhat disappointed",
    not: "Not disappointed",
};

/** The GitHub label applied to a prefilled issue, per kind. */
export const KIND_ISSUE_LABELS: Record<FeedbackKind, string> = {
    bug: "bug",
    idea: "enhancement",
    other: "feedback",
};

/**
 * A setting value is quotable only when its shape rules out a path or a
 * sentence: booleans and finite numbers always, and strings only when they
 * read as an identifier or enum member (`richText`, `always`, `on`). Anything
 * longer, spaced, dotted or slashed is reported as customized instead.
 */
export function isReportableValue(value: unknown): boolean {
    if (typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") return /^[A-Za-z][A-Za-z0-9-]{0,23}$/.test(value);
    return false;
}

/**
 * Reduce a settings snapshot to one safe line per non-default key. Arrays
 * report only their length; unquotable scalars report only that they differ.
 * Keys are sorted so two reports from the same configuration read identically.
 */
export function describeChangedSettings(
    current: Readonly<Record<string, unknown>>,
    defaults: Readonly<Record<string, unknown>>,
): string[] {
    const lines: string[] = [];
    for (const key of Object.keys(defaults).sort()) {
        const value = current[key];
        const fallback = defaults[key];
        if (JSON.stringify(value) === JSON.stringify(fallback)) continue;
        if (Array.isArray(value)) {
            lines.push(`${key}: ${value.length} ${value.length === 1 ? "entry" : "entries"}`);
        } else if (isReportableValue(value)) {
            lines.push(`${key}: ${String(value)}`);
        } else {
            lines.push(`${key}: customized`);
        }
    }
    return lines;
}

/** The diagnostics block, as the collapsed `<details>` the user can delete. */
export function formatDiagnostics(diagnostics: Diagnostics): string {
    const settings = diagnostics.changedSettings.length
        ? diagnostics.changedSettings.join("\n")
        : "(all birta.* settings at their defaults)";
    return [
        "<details>",
        "<summary>Diagnostics</summary>",
        "",
        "```",
        `Birta       ${diagnostics.extensionVersion}`,
        `Host        ${diagnostics.hostVersion}`,
        `Platform    ${diagnostics.platform}`,
        "",
        settings,
        "```",
        "",
        "</details>",
    ].join("\n");
}

/**
 * The whole payload. `title` is the issue subject; `body` is what lands in the
 * (editable) form or on the clipboard — everything the user will send, and
 * nothing else.
 */
export function composeFeedback(draft: FeedbackDraft): { title: string; body: string } {
    const summary = draft.summary.trim();
    const details = draft.details.trim();
    const sections: string[] = [];

    sections.push(details || "_(no further detail given)_");

    if (draft.disappointment) {
        sections.push(
            [
                "**How would you feel if you could no longer use Birta Writer?**",
                "",
                DISAPPOINTMENT_LABELS[draft.disappointment],
            ].join("\n"),
        );
    }

    sections.push(formatDiagnostics(draft.diagnostics));

    return {
        title: `${KIND_LABELS[draft.kind]}: ${summary}`,
        body: sections.join("\n\n"),
    };
}
