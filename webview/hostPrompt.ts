/**
 * webview/hostPrompt.ts
 *
 * The page's end of the host-prompt seam (MAR-395): it asks the host to draw
 * one step, and routes the answer back to the flow that is waiting for it.
 *
 * This module is eager and deliberately small, for the reason `dateInsert.ts`
 * gives about itself: a reply has to be routed by the eager message handler,
 * so the pending table cannot live in a chunk that may not be loaded. The
 * flows themselves are lazy, so a document that never asks for one loads
 * neither the questions nor the composer.
 *
 * The failure rules are `dateInsert.ts`'s, lifted rather than re-derived,
 * because each was written for a reason:
 *
 *  - A reply whose id the table does not know is DROPPED rather than guessed
 *    at. It names a request that has already been retired, and guessing which
 *    pending step it meant would record an answer the user did not give.
 *  - A reply that arrives twice is honoured once: the table entry is deleted
 *    before the waiter runs.
 *  - The wait is BOUNDED. The host is supposed to answer every request, a
 *    cancel included, and both shipped hosts do. It can still fail to: a
 *    malformed request is dropped rather than answered, and a host that
 *    implements none of this drops the message silently (MAR-390). Without a
 *    bound the flow would never settle and the caret would never come back.
 */
import type { HostPromptStep } from "../shared/hostPrompt";
import type { Diagnostics } from "../shared/feedback/compose";
import { notifyHostPrompt, notifyRequestHostDiagnostics } from "@/messaging";

/**
 * How long a host may leave a request unanswered.
 *
 * The same figure as the native date picker's, and for the same reason: it is
 * long enough that a user reading a sheet never trips it, and short enough
 * that a host which will never answer does not wedge the flow forever.
 */
export const HOST_PROMPT_TIMEOUT_MS = 60_000;

/** What a step can come back as, once the host has spoken. */
export interface HostPromptOutcome {
    /** The text typed, the row id chosen, or null for a cancel. */
    readonly value: string | null;
    /** The host cannot draw this kind of step at all. */
    readonly unsupported?: true;
}

const pendingPrompts = new Map<string, (outcome: HostPromptOutcome) => void>();
const pendingDiagnostics = new Map<string, (diagnostics: Diagnostics | null) => void>();

let nextRequestId = 0;

/** Routes a `hostPromptResult` back to the step that asked for it. */
export function resolveHostPrompt(id: string, outcome: HostPromptOutcome): void {
    const waiter = pendingPrompts.get(id);
    if (!waiter) return;
    pendingPrompts.delete(id);
    waiter(outcome);
}

/** Routes a `hostDiagnosticsResult` back to the flow that asked for it. */
export function resolveHostDiagnostics(id: string, diagnostics: Diagnostics): void {
    const waiter = pendingDiagnostics.get(id);
    if (!waiter) return;
    pendingDiagnostics.delete(id);
    waiter(diagnostics);
}

function request<T>(
    table: Map<string, (value: T) => void>,
    prefix: string,
    send: (id: string) => void,
    onTimeout: T,
): Promise<T> {
    const id = `${prefix}-${++nextRequestId}`;
    return new Promise<T>((resolve) => {
        const timer = setTimeout(() => {
            if (table.delete(id)) resolve(onTimeout);
        }, HOST_PROMPT_TIMEOUT_MS);
        table.set(id, (value) => {
            clearTimeout(timer);
            resolve(value);
        });
        send(id);
    });
}

/**
 * Put one step to the host and wait for its answer.
 *
 * A timeout resolves as a cancel, which is the safe reading: the flow unwinds
 * and nothing is composed or sent, exactly as if the user had pressed Escape.
 */
export function askHost(step: HostPromptStep): Promise<HostPromptOutcome> {
    return request<HostPromptOutcome>(
        pendingPrompts,
        "prompt",
        (id) => notifyHostPrompt(id, step),
        { value: null },
    );
}

/**
 * Ask the host for the environment facts a report carries.
 *
 * Resolves null when the host does not answer, which the caller composes
 * around rather than aborting on: diagnostics are a nicety, and failing to
 * gather them must never stop somebody reporting a bug.
 */
export function askHostDiagnostics(): Promise<Diagnostics | null> {
    return request<Diagnostics | null>(
        pendingDiagnostics,
        "diag",
        (id) => notifyRequestHostDiagnostics(id),
        null,
    );
}
