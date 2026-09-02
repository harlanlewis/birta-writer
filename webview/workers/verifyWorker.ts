/**
 * webview/workers/verifyWorker.ts — the save pipeline's reopen question,
 * answered off the interaction thread (MAR-430, tier B0).
 *
 * The verifying reparse (`utils/verifiedMerge.ts`) is the largest piece of a
 * sync on a large document and the only piece that is a whole-document parse.
 * This worker holds the page's own parser, built headless
 * (`utils/headlessParser.ts`) from the markdown format's parse half, and
 * answers one question per message: does this text reopen holding exactly
 * this fingerprint. The page keeps the merge, the serialize and the live
 * fingerprint, so nothing but text and a fingerprint cross the boundary in
 * either direction, and the answer is the same function the page would have
 * run (`reopensAs`), on the same presets.
 *
 * It is a classic worker, built self-contained by `verifyWorkerPlugin` in
 * esbuild.mjs and started from a Blob URL (`utils/verifyOracle.ts` says why),
 * so it must import nothing that needs a document at load time, and nothing
 * lazy: a Blob-origin worker has no base URL to resolve a chunk against.
 *
 * Markdown only. The MDX format loads lazily and brings its own presets;
 * a document in it keeps the main-thread path, which the page decides.
 */
import { markdownParse } from "../format/markdown/parse";
import { createHeadlessParser, type HeadlessParser } from "../utils/headlessParser";
import { reopensAs } from "../utils/verifiedMerge";
import type { VerifyReply, VerifyRequest } from "./protocol";

/** The worker scope, typed by what this file uses of it; the DOM lib's `Window` is not it. */
const scope = globalThis as unknown as {
    addEventListener(type: "message", handler: (event: { data: VerifyRequest }) => void): void;
    postMessage(reply: VerifyReply): void;
};

let parserPromise: Promise<HeadlessParser> | null = null;
const parser = (): Promise<HeadlessParser> => (parserPromise ??= createHeadlessParser(markdownParse));

async function handle(request: VerifyRequest): Promise<void> {
    try {
        const p = await parser();
        if (request.type === "warm") {
            // A parser throw here is a property of the text, not of the
            // worker; the real question is answered per text below.
            try { p.parse(request.text); } catch { /* the text's own failure */ }
            scope.postMessage({ type: "warmed" });
            return;
        }
        scope.postMessage({ type: "verdict", id: request.id, reopens: reopensAs(request.liveFp, request.text, p.parse) });
    } catch (e) {
        scope.postMessage({
            type: "failed",
            id: request.type === "reopens" ? request.id : null,
            reason: e instanceof Error ? e.message : String(e),
        });
    }
}

// Answered in arrival order: each message is its own task, and a handler
// waiting on the parser's build continues in the order it began waiting.
scope.addEventListener("message", (event) => { void handle(event.data); });
