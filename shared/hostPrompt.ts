/**
 * shared/hostPrompt.ts
 *
 * THE seam every interactive multi-step command flow goes through: a flow is
 * DEFINED once here, in TypeScript, and RENDERED by whichever host is running
 * (MAR-395).
 *
 * The problem it exists for. Every interactive flow the extension has is
 * written against `vscode.window.showInputBox` / `showQuickPick`, which is a
 * VS Code API and nothing else. A surface that is not VS Code therefore cannot
 * run any of them, and the alternative to a seam is porting each one to Swift
 * by hand: a second copy of the questions, their order, their validation and
 * their cancel semantics, drifting from the first as either side changes.
 * `AgentRequest.swift` and `AgentReference.swift` are the two such ports that
 * already exist, and their headers exist to name where the two have diverged.
 *
 * What crosses the wire is the STEP, one at a time, never the flow. Batching
 * would be fewer round trips and would lose the two things the flows actually
 * rely on: validation that runs as the user types, and the distinction between
 * cancelling a step and submitting it empty. Both are per-step facts.
 *
 * Validation is DECLARED rather than passed, because a function does not
 * survive `postMessage`. Each renderer turns the declaration back into whatever
 * its platform's live validation is, and `validateHostPromptInput` below is the
 * one implementation of the rule, so the two cannot disagree about what is
 * valid or about what the user is told.
 *
 * Dependency-free (no vscode, no DOM) so the extension, the webview and the
 * tests all import it.
 */

/** A free-text question. */
export interface HostPromptInputStep {
    readonly kind: "input";
    /** Window/sheet title. Carries the step's position, e.g. "(1 of 4)". */
    readonly title: string;
    /** The question itself. */
    readonly prompt: string;
    /** Greyed example text inside the field. Never a default value. */
    readonly placeholder?: string;
    /**
     * Refuse an empty answer, with the message the user is shown. Absent means
     * the step is optional, and an empty submission is a real answer rather
     * than a cancel.
     */
    readonly required?: { readonly message: string };
    /** Refuse an answer longer than `value`, with the message shown. */
    readonly maxLength?: { readonly value: number; readonly message: string };
}

/** One row of a `pick` step. */
export interface HostPromptRow {
    /** Returned verbatim as the step's answer when this row is chosen. */
    readonly id: string;
    readonly label: string;
    /** The second line: what this row costs, or what it means. */
    readonly detail?: string;
    /**
     * A VS Code codicon name (`github`, `mail`, `clippy`), drawn before the
     * label by the palette renderer and ignored by every other host. It is a
     * separate field rather than a `$(github) ` prefix inside `label` because
     * a host that is not VS Code would draw that prefix as the literal text.
     */
    readonly icon?: string;
}

/** A choice between named rows. */
export interface HostPromptPickStep {
    readonly kind: "pick";
    readonly title: string;
    /** The question. Drawn as the filter field's placeholder in the palette. */
    readonly placeholder?: string;
    readonly rows: readonly HostPromptRow[];
}

export type HostPromptStep = HostPromptInputStep | HostPromptPickStep;

/** The kinds a host has to be able to draw to serve any flow at all. */
export const ALL_HOST_PROMPT_KINDS: readonly HostPromptStep["kind"][] = ["input", "pick"];

/**
 * The message to show for `value`, or undefined when it is acceptable.
 *
 * Both renderers call this, so "what is valid" and "what the user is told"
 * have one home. A `pick` step needs none: its answers are its own rows.
 */
export function validateHostPromptInput(
    step: HostPromptInputStep,
    value: string,
): string | undefined {
    const trimmed = value.trim();
    if (step.required && !trimmed) return step.required.message;
    if (step.maxLength && trimmed.length > step.maxLength.value) return step.maxLength.message;
    return undefined;
}

/**
 * How a renderer answers one step: the text typed, the id of the row chosen,
 * or **null for a cancel**.
 *
 * Null and the empty string are different answers and the difference is
 * load-bearing: on an optional step, Escape abandons the flow and an empty
 * submission is a deliberate "nothing to add" that continues. VS Code's
 * `showInputBox` already draws exactly that distinction (`undefined` against
 * `""`), which is where it comes from.
 */
export type HostPromptAsk = (step: HostPromptStep, index: number) => Promise<string | null>;

/**
 * Whether `answer` is one this step could have produced.
 *
 * A renderer is supposed to refuse an invalid answer before it hands one back,
 * and both shipped renderers do: VS Code validates as the user types, and the
 * sheet puts the question again. This is the driver's own check, and it is
 * what stops a renderer's mistake becoming a report: a `pick` answer that
 * names no row the step offered was never chosen by anybody, and an `input`
 * that its own declared rules refuse is not an answer either.
 */
export function isAcceptableAnswer(step: HostPromptStep, answer: string): boolean {
    return step.kind === "pick"
        ? step.rows.some((row) => row.id === answer)
        : validateHostPromptInput(step, answer) === undefined;
}

/**
 * Put each step to `ask` in order, and return the answers.
 *
 * Returns null the moment any step is cancelled, and asks nothing after it:
 * the caller then has no partial answers to decide what to do with, which is
 * what makes "cancelling at any step leaves everything untouched" a property
 * of the driver rather than a rule each flow has to remember.
 *
 * An unacceptable answer STOPS the flow rather than being asked again. The
 * driver cannot usefully re-ask, because re-asking is the renderer's own job
 * and a renderer that has already broken its contract is the one thing here
 * that cannot be trusted to do it. Stopping asks nothing further and composes
 * nothing, which is the same outcome as a cancel and the safe reading of a
 * host that is not doing what it said.
 */
export async function runPromptFlow(
    steps: readonly HostPromptStep[],
    ask: HostPromptAsk,
): Promise<string[] | null> {
    const answers: string[] = [];
    for (let i = 0; i < steps.length; i++) {
        const answer = await ask(steps[i], i);
        if (answer === null || !isAcceptableAnswer(steps[i], answer)) return null;
        answers.push(answer);
    }
    return answers;
}
