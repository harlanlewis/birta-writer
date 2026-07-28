import { describe, it, expect } from "vitest";
import {
    availableChannels,
    fitToBudget,
    githubIssueUrl,
    mailtoUrl,
    FEEDBACK_EMAIL,
    FEEDBACK_REPO,
    GITHUB_URL_BUDGET,
    MAILTO_URL_BUDGET,
    TRUNCATION_NOTE,
} from "../feedback/channels";

describe("FEEDBACK_EMAIL", () => {
    // The mail channel is built and deliberately dark until a dedicated
    // @birtalabs.com address exists (MAR-250). Both halves are pinned so it
    // cannot ship half-wired: dark today, and complete the moment it is set.
    it("no address configured should be the shipped state", () => {
        expect(FEEDBACK_EMAIL).toBeNull();
    });

    it("no address configured should hide the mail channel", () => {
        expect(availableChannels()).toEqual(["github", "clipboard"]);
    });

    it("an address configured should offer mail between GitHub and the clipboard", () => {
        expect(availableChannels("hello@birtalabs.com")).toEqual([
            "github",
            "mail",
            "clipboard",
        ]);
    });

    it("the clipboard should always be offered last, as the no-network fallback", () => {
        for (const email of [null, "hello@birtalabs.com"]) {
            expect(availableChannels(email).at(-1)).toBe("clipboard");
        }
    });
});

describe("githubIssueUrl", () => {
    it("a short report should round-trip title, body and label into the query", () => {
        const url = githubIssueUrl({ title: "Bug: thing", body: "it broke", labels: ["bug"] });
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe(
            `https://github.com/${FEEDBACK_REPO}/issues/new`,
        );
        expect(parsed.searchParams.get("title")).toBe("Bug: thing");
        expect(parsed.searchParams.get("body")).toBe("it broke");
        expect(parsed.searchParams.get("labels")).toBe("bug");
    });

    it("a space should be escaped as %20, never as a form-encoded plus", () => {
        // `+` means a literal plus in mailto:, so both channels use one rule.
        const url = githubIssueUrl({ title: "Bug: a summary", body: "x y", labels: ["bug"] });
        expect(url).toContain("title=Bug%3A%20a%20summary");
        expect(url).not.toContain("+");
    });

    it("no labels should omit the parameter rather than send an empty one", () => {
        const url = githubIssueUrl({ title: "t", body: "b" });
        expect(new URL(url).searchParams.has("labels")).toBe(false);
    });

    it("an over-long body should be truncated to fit the budget and say so", () => {
        const url = githubIssueUrl({ title: "t", body: "x".repeat(20000) });
        expect(url.length).toBeLessThanOrEqual(GITHUB_URL_BUDGET);
        expect(new URL(url).searchParams.get("body")).toContain("Truncated to fit the link");
    });

    it("a body of characters that expand when encoded should still fit the budget", () => {
        // Newlines and spaces cost 3 chars each once escaped, which is exactly
        // the case a raw-length check would under-count.
        const url = githubIssueUrl({ title: "t", body: "a b\n".repeat(4000) });
        expect(url.length).toBeLessThanOrEqual(GITHUB_URL_BUDGET);
    });
});

describe("mailtoUrl", () => {
    it("no destination should return null so the caller can hide the channel", () => {
        expect(mailtoUrl({ to: null, subject: "s", body: "b" })).toBeNull();
    });

    it("an omitted destination should fall back to the (currently null) constant", () => {
        expect(mailtoUrl({ subject: "s", body: "b" })).toBeNull();
    });

    it("a destination should produce a prefilled draft within the mail budget", () => {
        const url = mailtoUrl({
            to: "hello@birtalabs.com",
            subject: "Bug: thing",
            body: "y".repeat(9000),
        });
        expect(url).not.toBeNull();
        expect(url!.startsWith("mailto:hello@birtalabs.com?")).toBe(true);
        expect(url!.length).toBeLessThanOrEqual(MAILTO_URL_BUDGET);
    });
});

describe("fitToBudget", () => {
    it("a body that already fits should be returned unchanged", () => {
        expect(fitToBudget("short", 10, 1000)).toBe("short");
    });

    it("a truncated body should end with the note pointing at the clipboard", () => {
        const out = fitToBudget("z".repeat(5000), 10, 500);
        expect(out.endsWith(TRUNCATION_NOTE)).toBe(true);
        expect(encodeURIComponent(out).length).toBeLessThanOrEqual(490);
    });

    it("an overhead larger than the budget should degrade to the note alone", () => {
        expect(fitToBudget("anything", 900, 100)).toBe(TRUNCATION_NOTE.trim());
    });
});
