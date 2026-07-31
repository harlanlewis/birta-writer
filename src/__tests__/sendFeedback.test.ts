import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { runSendFeedback, collectDiagnostics } from "../feedback/sendFeedback";
import { composeFeedback } from "../feedback/compose";

const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
const showInputBox = vscode.window.showInputBox as unknown as ReturnType<typeof vi.fn>;
const openExternal = vscode.env.openExternal as unknown as ReturnType<typeof vi.fn>;
const writeText = vscode.env.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
const showErrorMessage = vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>;

/** Answer the three prompts in order: summary, disappointment, detail. */
function answer(options: { summary?: string; mood?: string; details?: string | undefined }): void {
    showQuickPick.mockResolvedValueOnce({ mood: options.mood ?? "skip" });
    showInputBox
        .mockResolvedValueOnce("summary" in options ? options.summary : "a summary")
        .mockResolvedValueOnce("details" in options ? options.details : "some details");
}

/**
 * What VS Code's opener actually does with what `openExternal` is handed —
 * `_doOpenExternal`, verified against the shipped 1.130 bundle:
 *
 *     if (typeof i === "string" && t.toString() === o.toString()) n = i;
 *     else n = encodeURI(o.toString(!0));
 *
 * A string is opened verbatim; a `Uri` is re-rendered through `encodeURI`,
 * which escapes `%`. Modelling it here is the whole point of these tests. An
 * assertion about `uri.toString(true)` describes what we *stored*, not what
 * the browser receives, and passed happily while every prefill was arriving
 * double-encoded — GitHub showing the literal text `Bug%3A%20hi` in its title
 * field. This function is the difference between the two.
 */
function asOpenerSends(target: unknown): string {
    return typeof target === "string"
        ? target
        : encodeURI((target as { toString(skip: boolean): string }).toString(true));
}

/** The URL as the browser receives it, parsed. */
function sentUrl(): URL {
    return new URL(asOpenerSends(openExternal.mock.calls[0][0]));
}

describe("the prefilled URL, as the opener sends it", () => {
    // The invariant: whatever the composer produced comes back out of the URL
    // byte-identical, after the opener has had its way with it. It holds
    // regardless of what anyone expects the encoding to look like, which is
    // why it catches both the double-encode (`%3A` → `%253A`) and the plain
    // `Uri.parse` alternative, where an `&` in the summary would split the
    // query into a new parameter and a `#` would truncate the body.
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("what the composer produced should be what the browser receives, exactly", async () => {
        const summary = "Table & list #2 lose 100% of a+b=c?d";
        const details = "first line & more\nsecond #line 50%";
        answer({ summary, details });
        await runSendFeedback("9.9.9");

        const expected = composeFeedback({
            summary,
            details,
            diagnostics: collectDiagnostics("9.9.9"),
        });
        const parsed = sentUrl();
        expect(parsed.searchParams.get("title")).toBe(expected.title);
        expect(parsed.searchParams.get("body")).toBe(expected.body);
    });

    it("no percent-escape should reach the browser doubly escaped", async () => {
        answer({ summary: "hi" });
        await runSendFeedback("0.0.0");
        expect(asOpenerSends(openExternal.mock.calls[0][0])).not.toContain("%25");
    });

    it("a summary of only reserved characters should still land in the title", async () => {
        answer({ summary: "&#?=+%", details: "" });
        await runSendFeedback("0.0.0");
        expect(sentUrl().searchParams.get("title")).toBe("&#?=+%");
    });

    it("the issue should be filed against the fork, unlabelled", async () => {
        answer({});
        await runSendFeedback("0.0.0");
        const parsed = sentUrl();
        expect(parsed.origin + parsed.pathname).toBe(
            "https://github.com/harlanlewis/birta-writer/issues/new",
        );
        expect(parsed.searchParams.has("labels")).toBe(false);
    });
});

describe("runSendFeedback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a complete answer should open a prefilled issue and never post it", async () => {
        answer({});
        await runSendFeedback("0.0.0");
        expect(openExternal).toHaveBeenCalledTimes(1);
        // Nothing here fetches, posts, or resolves anything: opening a URL is
        // the whole delivery mechanism. Rung 0.
        expect(sentUrl().searchParams.get("title")).toBe("a summary");
    });

    it("three prompts should be the whole flow", async () => {
        answer({});
        await runSendFeedback("0.0.0");
        expect(showInputBox).toHaveBeenCalledTimes(2);
        expect(showQuickPick).toHaveBeenCalledTimes(1);
    });

    it("a report that fits should leave the clipboard alone", async () => {
        answer({});
        await runSendFeedback("0.0.0");
        expect(writeText).not.toHaveBeenCalled();
    });

    it("a report too long for the link should be copied whole, so nothing is lost", async () => {
        answer({ details: "x".repeat(20000) });
        await runSendFeedback("0.0.0");
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(String(writeText.mock.calls[0][0])).toContain("x".repeat(20000));
        expect(sentUrl().searchParams.get("body")).toContain("Truncated to fit the link");
    });

    it("a browser that will not open should leave the report on the clipboard, and say so", async () => {
        openExternal.mockResolvedValueOnce(false);
        answer({ details: "the detail" });
        await runSendFeedback("0.0.0");
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(String(writeText.mock.calls[0][0])).toContain("the detail");
        expect(showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it("an opener that throws should be caught, not surfaced as a crash", async () => {
        openExternal.mockRejectedValueOnce(new Error("nope"));
        answer({});
        await runSendFeedback("0.0.0");
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it("a truncated report should be copied exactly once, not once per reason", async () => {
        openExternal.mockResolvedValueOnce(false);
        answer({ details: "y".repeat(20000) });
        await runSendFeedback("0.0.0");
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it("a skipped disappointment question should leave it out of the payload", async () => {
        answer({ mood: "skip" });
        await runSendFeedback("0.0.0");
        expect(sentUrl().searchParams.get("body")).not.toContain("no longer use");
    });

    it("an answered disappointment question should be carried into the payload", async () => {
        answer({ mood: "very" });
        await runSendFeedback("0.0.0");
        expect(sentUrl().searchParams.get("body")).toContain("Very disappointed");
    });

    it("cancelling at the summary step should do nothing at all", async () => {
        showInputBox.mockResolvedValueOnce(undefined);
        await runSendFeedback("0.0.0");
        expect(showQuickPick).not.toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
    });

    it("an empty summary should abort rather than file a titleless report", async () => {
        showInputBox.mockResolvedValueOnce("   ");
        await runSendFeedback("0.0.0");
        expect(openExternal).not.toHaveBeenCalled();
    });

    it("cancelling the disappointment question should abort, since skipping is its own row", async () => {
        showInputBox.mockResolvedValueOnce("a summary");
        showQuickPick.mockResolvedValueOnce(undefined);
        await runSendFeedback("0.0.0");
        expect(openExternal).not.toHaveBeenCalled();
    });

    it("escaping the optional detail step should abort, but an empty answer should continue", async () => {
        showInputBox.mockResolvedValueOnce("a summary").mockResolvedValueOnce(undefined);
        showQuickPick.mockResolvedValueOnce({ mood: "skip" });
        await runSendFeedback("0.0.0");
        expect(openExternal).not.toHaveBeenCalled();

        vi.clearAllMocks();
        answer({ details: "" });
        await runSendFeedback("0.0.0");
        expect(openExternal).toHaveBeenCalledTimes(1);
    });

    it("a summary longer than a GitHub title should be rejected at the prompt", async () => {
        answer({});
        await runSendFeedback("0.0.0");
        const validate = showInputBox.mock.calls[0][0].validateInput as (v: string) => string | undefined;
        expect(validate("a".repeat(256))).toBeUndefined();
        expect(validate("a".repeat(257))).toContain("256");
        expect(validate("   ")).toContain("required");
    });
});

describe("collectDiagnostics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a default configuration should report the version, host and platform only", () => {
        const d = collectDiagnostics("1.2.3");
        expect(d.extensionVersion).toBe("1.2.3");
        expect(d.hostVersion).toBe("VS Code 1.99.0");
        expect(d.platform).toBe(`${process.platform} ${process.arch}`);
        expect(d.changedSettings).toEqual([]);
    });

    it("diagnostics should never contain a document, a path, or a workspace name", async () => {
        answer({});
        await runSendFeedback("0.0.0");
        const payload = String(sentUrl().searchParams.get("body"));
        expect(payload).not.toContain("workspaceFolders");
        expect(payload).not.toMatch(/\/(Users|home)\//);
    });
});
