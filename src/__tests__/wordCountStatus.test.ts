import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { WordCountStatusBar } from "../wordCountStatus";
import type { TextCount } from "../../shared/messages";

/** The fake status bar item the mocked createStatusBarItem handed back. */
function lastItem() {
    const results = (vscode.window.createStatusBarItem as unknown as {
        mock: { results: Array<{ value: { text: string; tooltip?: string; name: string; show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } }> };
    }).mock.results;
    return results[results.length - 1].value;
}

const doc: TextCount = { words: 1234, characters: 5678, readingTimeMinutes: 6 };
const selection: TextCount = { words: 42, characters: 210, readingTimeMinutes: 1 };

describe("WordCountStatusBar", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("constructing should create a right-aligned status bar item with a name", () => {
        new WordCountStatusBar();
        expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
            "birta.wordCount",
            vscode.StatusBarAlignment.Right,
            100,
        );
        expect(lastItem().name).toBe("Word Count");
    });

    it("updating with no selection should show document words, chars, and reading time", () => {
        const sb = new WordCountStatusBar();
        sb.update(doc, null);
        const item = lastItem();
        expect(item.text).toContain("1,234 words");
        expect(item.text).toContain("5,678 chars");
        expect(item.text).toContain("6 min");
        expect(item.show).toHaveBeenCalled();
    });

    it("updating with a selection should show the selection word count", () => {
        const sb = new WordCountStatusBar();
        sb.update(doc, selection);
        const item = lastItem();
        expect(item.text).toContain("42 words selected");
        // The tooltip still surfaces the whole-document totals.
        expect(item.tooltip).toContain("1,234 words");
        expect(item.show).toHaveBeenCalled();
    });

    it("hiding should hide the underlying item", () => {
        const sb = new WordCountStatusBar();
        sb.hide();
        expect(lastItem().hide).toHaveBeenCalled();
    });

    it("disposing should dispose the underlying item", () => {
        const sb = new WordCountStatusBar();
        sb.dispose();
        expect(lastItem().dispose).toHaveBeenCalled();
    });
});
