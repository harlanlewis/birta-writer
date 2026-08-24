/**
 * MAR-395: the page's end of the host-prompt seam.
 *
 * The failure rules here are `dateInsert.ts`'s, lifted rather than
 * re-derived, so this file asserts the same four things its suite does: a
 * reply routes to the request that asked, an unknown id is dropped, a
 * duplicate reply is honoured once, and an unanswered request settles rather
 * than wedging the flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const posted: Array<Record<string, unknown>> = [];
vi.mock("@/messaging", () => ({
    notifyHostPrompt: (id: string, step: unknown) => { posted.push({ type: "hostPrompt", id, step }); },
    notifyRequestHostDiagnostics: (id: string) => { posted.push({ type: "requestHostDiagnostics", id }); },
}));

import {
    HOST_PROMPT_TIMEOUT_MS,
    askHost,
    askHostDiagnostics,
    resolveHostDiagnostics,
    resolveHostPrompt,
} from "../hostPrompt";
import type { HostPromptStep } from "../../shared/hostPrompt";

const STEP: HostPromptStep = {
    kind: "input",
    title: "a title",
    prompt: "a question",
};

/** The id of the request posted most recently. */
function lastId(): string {
    return String(posted.at(-1)!.id);
}

describe("asking the host to draw a step", () => {
    beforeEach(() => {
        posted.length = 0;
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("a request should carry the step and an id the reply can name", async () => {
        const pending = askHost(STEP);

        expect(posted).toHaveLength(1);
        expect(posted[0].step).toEqual(STEP);
        expect(posted[0].id).toBeTruthy();

        resolveHostPrompt(lastId(), { value: "typed" });
        await expect(pending).resolves.toEqual({ value: "typed" });
    });

    it("a cancel should resolve as a null value rather than never settling", async () => {
        const pending = askHost(STEP);
        resolveHostPrompt(lastId(), { value: null });

        await expect(pending).resolves.toEqual({ value: null });
    });

    it("a host that cannot draw the step should be reported, not read as a cancel", async () => {
        const pending = askHost(STEP);
        resolveHostPrompt(lastId(), { value: null, unsupported: true });

        await expect(pending).resolves.toEqual({ value: null, unsupported: true });
    });

    /**
     * An id the table does not know names a request that has already been
     * retired. Guessing which pending one it meant would record an answer the
     * user did not give.
     */
    it("a reply naming an unknown request should be dropped, leaving the real one waiting", async () => {
        const pending = askHost(STEP);
        const settled = vi.fn();
        void pending.then(settled);

        resolveHostPrompt("prompt-from-another-document", { value: "wrong" });
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();

        resolveHostPrompt(lastId(), { value: "right" });
        await expect(pending).resolves.toEqual({ value: "right" });
    });

    it("a reply that arrives twice should be honoured once", async () => {
        const pending = askHost(STEP);
        const id = lastId();

        resolveHostPrompt(id, { value: "first" });
        resolveHostPrompt(id, { value: "second" });

        await expect(pending).resolves.toEqual({ value: "first" });
    });

    /**
     * Without this the flow never settles and the caret never comes back, with
     * nothing on screen explaining why. A timeout resolves as a CANCEL, which
     * is the safe reading: nothing is composed and nothing is sent.
     */
    it("a host that never answers should time out as a cancel", async () => {
        const pending = askHost(STEP);
        const settled = vi.fn();
        void pending.then(settled);

        await vi.advanceTimersByTimeAsync(HOST_PROMPT_TIMEOUT_MS - 1);
        expect(settled).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2);
        await expect(pending).resolves.toEqual({ value: null });
    });

    it("an answered request should not still fire its timeout", async () => {
        const pending = askHost(STEP);
        resolveHostPrompt(lastId(), { value: "typed" });
        await expect(pending).resolves.toEqual({ value: "typed" });

        // A timer that outlived its request would resolve an already-settled
        // promise, which is silent, and would keep the page awake for a minute
        // after a flow finished.
        expect(vi.getTimerCount()).toBe(0);
    });

    it("two requests in flight should each get their own answer", async () => {
        const first = askHost(STEP);
        const firstId = lastId();
        const second = askHost({ ...STEP, title: "another" });
        const secondId = lastId();

        expect(firstId).not.toBe(secondId);
        resolveHostPrompt(secondId, { value: "b" });
        resolveHostPrompt(firstId, { value: "a" });

        await expect(first).resolves.toEqual({ value: "a" });
        await expect(second).resolves.toEqual({ value: "b" });
    });
});

describe("asking the host for diagnostics", () => {
    beforeEach(() => {
        posted.length = 0;
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("the facts the host reports should reach the caller", async () => {
        const pending = askHostDiagnostics();
        const diagnostics = {
            extensionVersion: "1.2.3",
            hostVersion: "macOS 26.1.0",
            platform: "darwin arm64",
            changedSettings: ["autosave: off"],
        };

        resolveHostDiagnostics(lastId(), diagnostics);

        await expect(pending).resolves.toEqual(diagnostics);
    });

    /**
     * Diagnostics are a nicety and failing to gather them must never stop
     * somebody reporting a bug, so a silent host resolves null and the caller
     * composes around it.
     */
    it("a host that never answers should resolve null rather than block the report", async () => {
        const pending = askHostDiagnostics();

        await vi.advanceTimersByTimeAsync(HOST_PROMPT_TIMEOUT_MS + 1);

        await expect(pending).resolves.toBeNull();
    });

    it("a prompt reply should not be able to answer a diagnostics request", async () => {
        const prompt = askHost(STEP);
        const promptId = lastId();
        const diagnostics = askHostDiagnostics();
        const diagnosticsId = lastId();
        const settled = vi.fn();
        void diagnostics.then(settled);

        // Two tables, two id spaces. Crossing them would let one reply retire
        // the wrong request.
        resolveHostPrompt(diagnosticsId, { value: "x" });
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();

        resolveHostPrompt(promptId, { value: "x" });
        await expect(prompt).resolves.toEqual({ value: "x" });
    });
});
