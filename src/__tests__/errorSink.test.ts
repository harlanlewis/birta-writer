/**
 * Error sink (MAR-169): the one console-vs-notification decision point. Every
 * failure logs; the user-facing toast is deduped per distinct message and
 * capped per session, so repeated failures can never stack notifications.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import {
    reportError,
    reportErrorWithNotification,
    MAX_NOTIFICATIONS_PER_SESSION,
    _resetErrorSinkForTests,
} from "../errorSink";

describe("errorSink", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        _resetErrorSinkForTests();
        consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleError.mockRestore();
    });

    describe("reportError", () => {
        it("a failure should log to the console and never notify", () => {
            const err = new Error("boom");

            reportError("openFile", err);

            expect(consoleError).toHaveBeenCalledWith("[birta] openFile failed:", err);
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        });
    });

    describe("reportErrorWithNotification", () => {
        it("a failure should log and show the notification once", () => {
            reportErrorWithNotification("webview error", new Error("boom"), "Editor error");

            expect(consoleError).toHaveBeenCalledTimes(1);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Editor error");
        });

        it("a repeated identical message should log every time but notify only once", () => {
            reportErrorWithNotification("webview error", new Error("a"), "Editor error");
            reportErrorWithNotification("webview error", new Error("b"), "Editor error");
            reportErrorWithNotification("webview error", new Error("c"), "Editor error");

            expect(consoleError).toHaveBeenCalledTimes(3);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
        });

        it("distinct messages past the session cap should log but stop notifying", () => {
            for (let i = 0; i < MAX_NOTIFICATIONS_PER_SESSION + 2; i++) {
                reportErrorWithNotification("source", new Error(String(i)), `message ${i}`);
            }

            expect(consoleError).toHaveBeenCalledTimes(MAX_NOTIFICATIONS_PER_SESSION + 2);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(
                MAX_NOTIFICATIONS_PER_SESSION,
            );
        });
    });
});
