import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { runSendFeedback, collectDiagnostics, openableUri } from "../feedback/sendFeedback";

const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
const showInputBox = vscode.window.showInputBox as unknown as ReturnType<typeof vi.fn>;
const openExternal = vscode.env.openExternal as unknown as ReturnType<typeof vi.fn>;
const writeText = vscode.env.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;

/** Answer the four prompts in order, then pick a destination. */
function answer(options: {
    kind?: string;
    mood?: string;
    summary?: string | undefined;
    details?: string | undefined;
    channel?: string;
}): void {
    const picks = [
        { feedbackKind: options.kind ?? "bug" },
        { mood: options.mood ?? "skip" },
    ];
    showQuickPick
        .mockResolvedValueOnce(picks[0])
        .mockResolvedValueOnce(picks[1])
        .mockResolvedValueOnce({ channel: options.channel ?? "github" });
    showInputBox
        .mockResolvedValueOnce("summary" in options ? options.summary : "a summary")
        .mockResolvedValueOnce("details" in options ? options.details : "some details");
}

describe("openableUri", () => {
    // Regression: the first cut used `Uri.parse(url)` directly, which decodes
    // the query and then re-escapes `=` and `&` — collapsing three parameters
    // into one named "title=Bug: x&labels". The prefill silently arrived
    // empty. These pin the encoded query surviving intact.
    it("a prefilled https query should survive as it was encoded", () => {
        const raw =
            "https://github.com/o/r/issues/new?title=Bug%3A%20a%20summary&labels=bug&body=x%20y%0Az";
        expect(openableUri(raw).toString(true)).toBe(raw);
    });

    it("a prefilled mailto query should survive as it was encoded", () => {
        const raw = "mailto:hello@birtalabs.com?subject=Bug%3A%20x&body=a%0Ab";
        expect(openableUri(raw).toString(true)).toBe(raw);
    });

    it("the reserved characters that give a query its structure should stay unescaped", () => {
        const out = openableUri(
            "https://github.com/o/r/issues/new?title=A%3AB&labels=bug",
        ).toString(true);
        expect(out).toContain("?title=");
        expect(out).toContain("&labels=");
        expect(out).not.toContain("%3D");
        expect(out).not.toContain("%26");
    });

    it("a URL with no query should pass through unchanged", () => {
        expect(openableUri("https://example.com/a/b").toString(true)).toBe(
            "https://example.com/a/b",
        );
    });
});

describe("runSendFeedback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("the GitHub channel should open a prefilled issue and never post it", async () => {
        answer({ channel: "github" });
        await runSendFeedback("0.0.0");

        expect(openExternal).toHaveBeenCalledTimes(1);
        // toString(true) is how openExternal renders a Uri for the browser.
        const url = (openExternal.mock.calls[0][0] as { toString(skip: boolean): string }).toString(
            true,
        );
        expect(url.startsWith("https://github.com/harlanlewis/birta-writer/issues/new?")).toBe(true);
        expect(url).toContain("title=Bug%3A%20a%20summary");
        expect(url).toContain("labels=bug");
        // Nothing here fetches, posts, or resolves anything: opening a URL is
        // the whole delivery mechanism. Rung 0.
    });

    it("the GitHub channel should also copy the full text, so truncation loses nothing", async () => {
        answer({ channel: "github" });
        await runSendFeedback("0.0.0");
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(String(writeText.mock.calls[0][0])).toContain("some details");
    });

    it("the clipboard channel should make no outbound call at all", async () => {
        answer({ channel: "clipboard" });
        await runSendFeedback("0.0.0");
        expect(openExternal).not.toHaveBeenCalled();
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it("the mail channel should fall back to the clipboard while no address is configured", async () => {
        answer({ channel: "mail" });
        await runSendFeedback("0.0.0");
        expect(openExternal).not.toHaveBeenCalled();
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it("a skipped disappointment question should leave it out of the payload", async () => {
        answer({ mood: "skip", channel: "clipboard" });
        await runSendFeedback("0.0.0");
        expect(String(writeText.mock.calls[0][0])).not.toContain("no longer use");
    });

    it("an answered disappointment question should be carried into the payload", async () => {
        answer({ mood: "very", channel: "clipboard" });
        await runSendFeedback("0.0.0");
        expect(String(writeText.mock.calls[0][0])).toContain("Very disappointed");
    });

    it("cancelling at the kind step should do nothing at all", async () => {
        showQuickPick.mockResolvedValueOnce(undefined);
        await runSendFeedback("0.0.0");
        expect(showInputBox).not.toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
    });

    it("an empty summary should abort rather than file a titleless report", async () => {
        showQuickPick.mockResolvedValueOnce({ feedbackKind: "bug" }).mockResolvedValueOnce({ mood: "skip" });
        showInputBox.mockResolvedValueOnce("   ");
        await runSendFeedback("0.0.0");
        expect(openExternal).not.toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
    });

    it("escaping the optional details step should abort, but an empty answer should continue", async () => {
        showQuickPick.mockResolvedValueOnce({ feedbackKind: "bug" }).mockResolvedValueOnce({ mood: "skip" });
        showInputBox.mockResolvedValueOnce("a summary").mockResolvedValueOnce(undefined);
        await runSendFeedback("0.0.0");
        expect(writeText).not.toHaveBeenCalled();

        vi.clearAllMocks();
        answer({ details: "", channel: "clipboard" });
        await runSendFeedback("0.0.0");
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it("cancelling the destination step should send nowhere", async () => {
        showQuickPick
            .mockResolvedValueOnce({ feedbackKind: "bug" })
            .mockResolvedValueOnce({ mood: "skip" })
            .mockResolvedValueOnce(undefined);
        showInputBox.mockResolvedValueOnce("a summary").mockResolvedValueOnce("d");
        await runSendFeedback("0.0.0");
        expect(openExternal).not.toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
    });

    it("the mail channel should not be offered while no address is configured", async () => {
        answer({ channel: "clipboard" });
        await runSendFeedback("0.0.0");
        const rows = showQuickPick.mock.calls[2][0] as Array<{ channel: string }>;
        expect(rows.map((r) => r.channel)).toEqual(["github", "clipboard"]);
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
        answer({ channel: "clipboard" });
        await runSendFeedback("0.0.0");
        const payload = String(writeText.mock.calls[0][0]);
        expect(payload).not.toContain("workspaceFolders");
        expect(payload).not.toMatch(/\/(Users|home)\//);
    });
});
