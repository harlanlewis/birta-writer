/**
 * MAR-395: the feedback flow run against a scripted renderer.
 *
 * What this file is for. The flow used to be four `vscode.window` calls in a
 * row, so the only way to exercise it was to mock VS Code, and every claim
 * about it was therefore a claim about one host. It is `HostPromptStep` data
 * and a driver now, and both are host-free, so the questions, their order,
 * their validation and their cancel behaviour can be asserted directly.
 *
 * The cancel matrix is ENUMERATED FROM THE STEP LIST rather than written out.
 * A hand-written list of cancel cases is a list a fifth step never joins, and
 * the case that would matter most is the one nobody remembered to add.
 */
import { describe, it, expect } from "vitest";
import {
    runPromptFlow,
    validateHostPromptInput,
    type HostPromptAsk,
    type HostPromptStep,
} from "../hostPrompt";
import { TITLE_MAX, SKIP_ANSWER, feedbackAnswers, feedbackSteps } from "../feedback/flow";
import { composeFeedback, type Diagnostics } from "../feedback/compose";
import { FEEDBACK_EMAIL } from "../feedback/channels";

const DIAGNOSTICS: Diagnostics = {
    extensionVersion: "9.9.9",
    hostVersion: "a host",
    platform: "a platform",
    changedSettings: [],
};

/** Answers each step in turn from `script`, and records what it was asked. */
function scriptedRenderer(script: readonly (string | null)[]): {
    ask: HostPromptAsk;
    asked: HostPromptStep[];
} {
    const asked: HostPromptStep[] = [];
    const ask: HostPromptAsk = async (step, index) => {
        asked.push(step);
        return script[index] ?? null;
    };
    return { ask, asked };
}

describe("the feedback flow's shape", () => {
    it("the steps should be the four questions, in order, with only the first required", () => {
        const steps = feedbackSteps();

        expect(steps.map((s) => s.kind)).toEqual(["input", "pick", "input", "pick"]);
        expect(steps.filter((s) => s.kind === "input" && s.required)).toHaveLength(1);
        expect(steps[0].title).toContain("1 of 4");
        expect(steps[3].title).toContain("4 of 4");
    });

    it("the destination step should offer mail only when an address is configured", () => {
        const withMail = feedbackSteps("someone@example.com");
        const without = feedbackSteps(null);
        const ids = (steps: HostPromptStep[]): string[] => {
            const last = steps[3];
            return last.kind === "pick" ? last.rows.map((r) => r.id) : [];
        };

        expect(ids(withMail)).toEqual(["github", "mail", "clipboard"]);
        expect(ids(without)).toEqual(["github", "clipboard"]);
    });

    /**
     * Every destination row states what it costs, which is the whole reason
     * the step exists rather than opening GitHub and hoping: someone without
     * an account would otherwise meet a login wall holding the report they
     * just finished writing.
     */
    it("every destination row should carry a detail line saying what it costs", () => {
        const step = feedbackSteps()[3];
        if (step.kind !== "pick") throw new Error("the destination step should be a pick");

        expect(step.rows).not.toHaveLength(0);
        for (const row of step.rows) {
            expect(row.detail, `${row.id} has no detail`).toBeTruthy();
        }
    });

    /**
     * The disappointment rows are the one place a row's own text has to carry
     * the subject: the scale asks about the editor and is put at the end of a
     * bug report, where a bare "Not disappointed" reads as a verdict on the
     * bug instead.
     */
    it("the disappointment rows should each name what they are an answer about", () => {
        const step = feedbackSteps()[1];
        if (step.kind !== "pick") throw new Error("the mood step should be a pick");

        const SCALE_POINTS = ["Very disappointed", "Somewhat disappointed", "Not disappointed"];
        const answered = step.rows.filter((r) => r.id !== SKIP_ANSWER);

        // The instrument reached something: three scale points and a skip.
        expect(answered).toHaveLength(SCALE_POINTS.length);
        for (const row of answered) {
            const point = SCALE_POINTS.find((p) => row.label.startsWith(p));
            expect(point, `${row.id} does not open with a scale point`).toBeDefined();
            // Longer than the scale point alone, which is the whole claim: the
            // row says what it is an answer about rather than leaving it to
            // the placeholder above it.
            expect(row.label.length, `${row.id} is a bare scale point`).toBeGreaterThan(
                point!.length + 8,
            );
        }
    });
});

describe("validation, which both renderers run", () => {
    const summary = feedbackSteps()[0];
    if (summary.kind !== "input") throw new Error("step 1 should be an input");

    it("an empty or whitespace-only summary should be refused", () => {
        expect(validateHostPromptInput(summary, "")).toBe(summary.required?.message);
        expect(validateHostPromptInput(summary, "   ")).toBe(summary.required?.message);
    });

    it("a summary should be accepted at the ceiling and refused one past it", () => {
        expect(validateHostPromptInput(summary, "x".repeat(TITLE_MAX))).toBeUndefined();
        expect(validateHostPromptInput(summary, "x".repeat(TITLE_MAX + 1))).toBe(
            summary.maxLength?.message,
        );
    });

    it("an optional step should accept an empty answer", () => {
        const details = feedbackSteps()[2];
        if (details.kind !== "input") throw new Error("step 3 should be an input");

        expect(details.required).toBeUndefined();
        expect(validateHostPromptInput(details, "")).toBeUndefined();
    });
});

describe("cancelling", () => {
    const steps = feedbackSteps();
    const fullScript = ["a summary", "very", "some details", "github"];

    /**
     * Derived from the step list, so a fifth step joins this matrix without
     * anyone adding a case. Asserting the ASKED COUNT is what makes each arm
     * discriminate: without it, "no answers" passes for a flow that cancelled
     * at step 1 and for one that ran to the end and returned nothing.
     */
    for (let cancelAt = 0; cancelAt < steps.length; cancelAt++) {
        it(`cancelling at step ${cancelAt + 1} should return nothing and ask nothing further`, async () => {
            const script = fullScript.map((a, i) => (i === cancelAt ? null : a));
            const { ask, asked } = scriptedRenderer(script);

            const answers = await runPromptFlow(steps, ask);

            expect(answers).toBeNull();
            expect(asked).toHaveLength(cancelAt + 1);
        });
    }

    /**
     * The driver's own check on what a renderer hands back.
     *
     * Both shipped renderers refuse an invalid answer before returning one, so
     * these arms describe a renderer that has broken its contract: a host bug,
     * a step drawn from a stale build, a reply crossing the bridge from
     * somewhere unexpected. Stopping asks nothing further and composes
     * nothing, which is the same outcome as a cancel.
     *
     * Enumerated over the steps, so the answer that is wrong is wrong for that
     * step's OWN reason: a row id no pick offered, or text its own declared
     * rules refuse.
     */
    for (let at = 0; at < steps.length; at++) {
        const step = steps[at];
        const impossible = step.kind === "pick" ? "a-row-that-was-never-offered" : "";
        // Only a step that declares a rule can be given an answer breaking it;
        // the optional detail step accepts the empty string as a real answer.
        const canRefuse = step.kind === "pick" || Boolean(step.required);
        if (!canRefuse) continue;

        it(`an answer step ${at + 1} could not have produced should stop the flow`, async () => {
            const script = fullScript.map((a, i) => (i === at ? impossible : a));
            const { ask, asked } = scriptedRenderer(script);

            const answers = await runPromptFlow(steps, ask);

            expect(answers).toBeNull();
            expect(asked).toHaveLength(at + 1);
        });
    }

    it("the optional detail step should still accept an empty answer as a real one", async () => {
        const { ask } = scriptedRenderer(["a summary", "very", "", "github"]);

        await expect(runPromptFlow(steps, ask)).resolves.toEqual([
            "a summary", "very", "", "github",
        ]);
    });

    it("answering every step should return every answer, in order", async () => {
        const { ask, asked } = scriptedRenderer(fullScript);

        const answers = await runPromptFlow(steps, ask);

        expect(answers).toEqual(fullScript);
        expect(asked).toHaveLength(steps.length);
    });
});

describe("naming the answers", () => {
    it("a skipped disappointment should leave the question out of the report", () => {
        const named = feedbackAnswers(["a summary", SKIP_ANSWER, "", "github"], DIAGNOSTICS);

        expect(named?.draft.disappointment).toBeUndefined();
        expect(composeFeedback(named!.draft).body).not.toContain("How would you feel");
    });

    it("an answered disappointment should reach the report", () => {
        const named = feedbackAnswers(["a summary", "very", "", "clipboard"], DIAGNOSTICS);

        expect(named?.draft.disappointment).toBe("very");
        expect(composeFeedback(named!.draft).body).toContain("Very disappointed");
    });

    /**
     * The belt-and-braces arm. `required` on step 1 means no renderer should
     * be able to submit a blank summary; a renderer that validated nothing
     * would otherwise compose a report with an empty issue title.
     */
    it("a blank summary should produce no report even if a renderer let it through", () => {
        expect(feedbackAnswers(["   ", SKIP_ANSWER, "", "github"], DIAGNOSTICS)).toBeNull();
    });

    it("the chosen destination should be carried through as the row's own id", () => {
        const step = feedbackSteps(FEEDBACK_EMAIL)[3];
        if (step.kind !== "pick") throw new Error("the destination step should be a pick");

        for (const row of step.rows) {
            const named = feedbackAnswers(["a summary", SKIP_ANSWER, "", row.id], DIAGNOSTICS);
            expect(named?.channel).toBe(row.id);
        }
    });
});
