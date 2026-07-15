import * as vscode from "vscode";
import type { TextCount } from "../shared/messages";

/**
 * Renders word / character / reading-time counts into a VS Code status bar item
 * for the active WYSIWYG editor (MAR-29). The webview computes the counts (it
 * has the live document and selection); this side only formats and shows them.
 *
 * Kept behind a tiny interface so the provider can be unit-tested with a fake,
 * and so the status bar item is created exactly once (in extension.ts).
 */
export interface WordCountView {
    /** Show counts for the document, or for the selection when one is passed. */
    update(doc: TextCount, selection: TextCount | null): void;
    /** Hide the item (no active WYSIWYG editor). */
    hide(): void;
}

/** Group digits for readability without locale surprises in tests (1234 → "1,234"). */
function fmt(n: number): string {
    return n.toLocaleString("en-US");
}

/** "1 min" / "5 min" — the reading-time suffix, already whole minutes. */
function minutes(n: number): string {
    return `${n} min`;
}

export class WordCountStatusBar implements WordCountView, vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        // Right-aligned near VS Code's own line/column readout; a low priority
        // keeps it to the left of the built-in editor indicators.
        this.item = vscode.window.createStatusBarItem(
            "birta.wordCount",
            vscode.StatusBarAlignment.Right,
            100,
        );
        // Names the item in the status bar's right-click "hide" menu, so a user
        // who doesn't want it can turn it off with VS Code's native control.
        this.item.name = vscode.l10n.t("Word Count");
    }

    update(doc: TextCount, selection: TextCount | null): void {
        if (selection) {
            this.item.text = `$(list-selection) ${vscode.l10n.t(
                "{0} words selected",
                fmt(selection.words),
            )}`;
            this.item.tooltip = vscode.l10n.t(
                "Selection: {0} words · {1} characters · {2} read\nDocument: {3} words · {4} characters · {5} read",
                fmt(selection.words),
                fmt(selection.characters),
                minutes(selection.readingTimeMinutes),
                fmt(doc.words),
                fmt(doc.characters),
                minutes(doc.readingTimeMinutes),
            );
        } else {
            this.item.text = `$(pencil) ${vscode.l10n.t(
                "{0} words · {1} chars · {2} read",
                fmt(doc.words),
                fmt(doc.characters),
                minutes(doc.readingTimeMinutes),
            )}`;
            this.item.tooltip = vscode.l10n.t(
                "{0} words · {1} characters · {2} reading time",
                fmt(doc.words),
                fmt(doc.characters),
                minutes(doc.readingTimeMinutes),
            );
        }
        this.item.show();
    }

    hide(): void {
        this.item.hide();
    }

    dispose(): void {
        this.item.dispose();
    }
}
