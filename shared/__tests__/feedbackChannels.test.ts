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

describe("availableChannels", () => {
    it("a configured address should offer mail between GitHub and the clipboard", () => {
        expect(FEEDBACK_EMAIL).toBe("harlan@birtalabs.com");
        expect(availableChannels()).toEqual(["github", "mail", "clipboard"]);
    });

    it("no address should hide the mail channel rather than show a broken one", () => {
        expect(availableChannels(null)).toEqual(["github", "clipboard"]);
    });

    it("the clipboard should always be offered last, as the no-network fallback", () => {
        for (const email of [null, "hello@birtalabs.com"]) {
            expect(availableChannels(email).at(-1)).toBe("clipboard");
        }
    });
});

describe("mailtoUrl", () => {
    it("no destination should return null so the caller can hide the channel", () => {
        expect(mailtoUrl({ to: null, subject: "s", body: "b" })).toBeNull();
    });

    it("a destination should produce a prefilled draft within the mail budget", () => {
        const prefill = mailtoUrl({ subject: "a thing broke", body: "y".repeat(9000) });
        expect(prefill).not.toBeNull();
        expect(prefill!.url.startsWith("mailto:harlan@birtalabs.com?")).toBe(true);
        expect(prefill!.url.length).toBeLessThanOrEqual(MAILTO_URL_BUDGET);
        expect(prefill!.truncated).toBe(true);
    });

    it("a short draft should round-trip its subject and body, and report no truncation", () => {
        const prefill = mailtoUrl({ to: "a@b.com", subject: "A & B #2", body: "c+d 100%" })!;
        const parsed = new URL(prefill.url);
        expect(parsed.searchParams.get("subject")).toBe("A & B #2");
        expect(parsed.searchParams.get("body")).toBe("c+d 100%");
        expect(prefill.truncated).toBe(false);
    });
});

describe("githubIssueUrl", () => {
    it("a short report should round-trip title and body into the query", () => {
        const { url, truncated } = githubIssueUrl({ title: "a thing broke", body: "it broke" });
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe(
            `https://github.com/${FEEDBACK_REPO}/issues/new`,
        );
        expect(parsed.searchParams.get("title")).toBe("a thing broke");
        expect(parsed.searchParams.get("body")).toBe("it broke");
        expect(truncated).toBe(false);
    });

    it("a space should be escaped as %20, never as a form-encoded plus", () => {
        // A `+` the user actually typed would arrive as a space under form
        // encoding, so `encodeURIComponent` is the rule everywhere.
        const { url } = githubIssueUrl({ title: "a summary", body: "c+ + c" });
        expect(url).toContain("title=a%20summary");
        expect(url).not.toContain("+");
        expect(new URL(url).searchParams.get("body")).toBe("c+ + c");
    });

    it("an over-long body should be truncated to fit the budget, and say so twice", () => {
        // Twice: in the body the user will see, and in the flag the caller
        // needs to decide whether the clipboard is worth clobbering.
        const { url, truncated } = githubIssueUrl({ title: "t", body: "x".repeat(20000) });
        expect(url.length).toBeLessThanOrEqual(GITHUB_URL_BUDGET);
        expect(new URL(url).searchParams.get("body")).toContain("Truncated to fit the link");
        expect(truncated).toBe(true);
    });

    it("a body of characters that expand when encoded should still fit the budget", () => {
        // Newlines and spaces cost 3 chars each once escaped, which is exactly
        // the case a raw-length check would under-count.
        const { url } = githubIssueUrl({ title: "t", body: "a b\n".repeat(4000) });
        expect(url.length).toBeLessThanOrEqual(GITHUB_URL_BUDGET);
    });

    it("a long title should not push the body past the budget", () => {
        const { url } = githubIssueUrl({ title: "t".repeat(256), body: "b".repeat(20000) });
        expect(url.length).toBeLessThanOrEqual(GITHUB_URL_BUDGET);
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
